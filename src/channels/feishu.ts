/**
 * Feishu/Lark channel implementation.
 *
 * Supports three interaction types:
 *   - p2p:          Private chat — continuous group-level session, reply directly
 *   - group:        Normal group — group-level session, reply to trigger message
 *   - thread_group: Topic group (话题群) — per-thread session, reply within thread
 *
 * Key improvements over the old implementation:
 *   - Uses Lark.Client instead of raw fetch (token managed by SDK)
 *   - Closure-based reply routing (no global activeThread Map race conditions)
 *   - Supports all message types: text, post, image, file, audio, video, sticker
 *   - Hourglass reaction (⏳) confirms receipt; removed when processing finishes
 *   - User name resolved via contact API with LRU cache
 *   - Scheduled tasks reply to the chat they were created in (natural behavior)
 */
import fs from 'fs';
import path from 'path';

import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, ReplyContext } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { FeishuSender } from './feishu-sender.js';
import {
  appendConversationLog,
  getCachedUserName,
  isDuplicate,
  markSeen,
  parseInboundEvent,
  setCachedUserName,
} from './feishu-receiver.js';
import { ParsedMessage } from './feishu-types.js';

const JID_PREFIX = 'feishu:';
const CARDKIT_PREFIX = 'ck:'; // prefix to distinguish cardkit card IDs from message IDs

interface CardkitSession {
  cardId: string;
  resultElementId: string;
  progressElementId: string;
  sequence: number;
  progressLines: string[];
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private wsClient: Lark.WSClient | null = null;
  private connected = false;
  private sender: FeishuSender;
  /** Active Cardkit streaming sessions: compositeId → session state */
  private cardkitSessions = new Map<string, CardkitSession>();

  constructor(
    private appId: string,
    private appSecret: string,
    private opts: ChannelOpts,
  ) {
    this.sender = new FeishuSender(appId, appSecret);
  }

  // ── Channel interface ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        try {
          await this.handleInboundEvent(data);
        } catch (err) {
          logger.error({ err }, 'Feishu: error handling inbound event');
        }
      },
    });

    this.wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info('Feishu long connection (WSClient) started');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
  }

  // ── Outbound public methods ───────────────────────────────────────────────

  /**
   * Send a message to a JID (chat).
   * No reply context — sends to the top-level chat.
   * Used by scheduled tasks (they reply to the chat they were triggered from).
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.slice(JID_PREFIX.length);
    await this.sender.sendToChat(chatId, this.sender.buildCard(text));
  }

  /**
   * Send a streaming Cardkit card and return a composite ID for subsequent updates.
   * Falls back to a plain interactive card if Cardkit creation fails.
   */
  async sendMessageGetId(jid: string, text: string): Promise<string> {
    const chatId = jid.slice(JID_PREFIX.length);
    try {
      const session = await this.sender.createStreamingCard(text);
      const msgId = await this.sender.sendCardKitMessage(
        chatId,
        session.cardId,
      );
      // Use message_id as the key (what's stored in progressMessageId)
      // but also keep track of the card session for streaming updates
      const compositeId = `${CARDKIT_PREFIX}${session.cardId}::${msgId}`;
      this.cardkitSessions.set(compositeId, {
        cardId: session.cardId,
        resultElementId: session.resultElementId,
        progressElementId: session.progressElementId,
        sequence: 1,
        progressLines: [],
      });
      return compositeId;
    } catch (err) {
      logger.warn(
        { err },
        'Feishu: Cardkit creation failed, falling back to PATCH',
      );
      return this.sender.sendToChat(chatId, this.sender.buildCard(text));
    }
  }

  /**
   * Update a streaming card (Cardkit typewriter) or fall back to PATCH.
   * The text may include both progress lines and the final result, separated by '---'.
   */
  async updateMessage(messageId: string, text: string): Promise<void> {
    const session = this.cardkitSessions.get(messageId);
    if (!session) {
      // Legacy PATCH path (non-Cardkit)
      await this.sender.updateCard(messageId, this.sender.buildCard(text));
      return;
    }

    // Parse the text: progress (above ---) and result (below ---)
    const SEPARATOR = '\n\n---\n\n';
    const sepIdx = text.indexOf(SEPARATOR);
    let progressText = '';
    let resultText = text;

    if (sepIdx !== -1) {
      progressText = text.slice(0, sepIdx).trim();
      resultText = text.slice(sepIdx + SEPARATOR.length).trim();
    }

    const seq = session.sequence;
    session.sequence += 2; // reserve 2 per update (progress + result)

    try {
      // Update result element (main content visible to user)
      if (resultText) {
        await this.sender.updateCardKitElement(
          session.cardId,
          session.resultElementId,
          resultText,
          seq,
        );
      }
      // Update progress panel if there's thinking content
      if (progressText) {
        await this.sender.updateCardKitElement(
          session.cardId,
          session.progressElementId,
          progressText,
          seq + 1,
        );
      }
    } catch (err) {
      logger.warn(
        { messageId, err },
        'Feishu: Cardkit update failed, ignoring',
      );
    }
  }

  /** Close Cardkit streaming mode and clean up session. */
  async closeStreaming(compositeId: string): Promise<void> {
    const session = this.cardkitSessions.get(compositeId);
    if (!session) return;
    await this.sender.closeCardStreaming(session.cardId, session.sequence);
    this.cardkitSessions.delete(compositeId);
  }

  // ── Context-aware send helpers (used internally and by processGroupMessages) ──

  /**
   * Send a card to the top-level chat (no thread/reply).
   * Used for: scheduled tasks, topic group top-level messages.
   */
  async sendToChat(jid: string, text: string): Promise<string> {
    const chatId = jid.slice(JID_PREFIX.length);
    return this.sender.sendToChat(chatId, this.sender.buildCard(text));
  }

  /**
   * Reply to a trigger message (normal group).
   * Feishu shows this as a quoted reply and optionally auto-creates a thread.
   */
  async replyToMessage(
    triggerMessageId: string,
    jid: string,
    text: string,
  ): Promise<string> {
    try {
      return await this.sender.replyToMessage(
        triggerMessageId,
        this.sender.buildCard(text),
      );
    } catch {
      // Fallback to plain send on any error
      return this.sendToChat(jid, text);
    }
  }

  /**
   * Reply within a thread (topic group 话题群).
   * reply_in_thread=true keeps the reply inside the topic.
   */
  async replyInThread(
    threadRootMessageId: string,
    jid: string,
    text: string,
  ): Promise<string> {
    const chatId = jid.slice(JID_PREFIX.length);
    return this.sender.replyInThread(
      threadRootMessageId,
      chatId,
      this.sender.buildCard(text),
    );
  }

  /**
   * Send a card and return its message_id, using the appropriate reply strategy
   * based on interaction type.
   */
  async sendMessageGetIdWithContext(
    jid: string,
    text: string,
    context: ReplyContext,
  ): Promise<string> {
    switch (context.type) {
      case 'p2p':
        return this.sendToChat(jid, text);
      case 'group':
        return context.triggerMessageId
          ? this.replyToMessage(context.triggerMessageId, jid, text)
          : this.sendToChat(jid, text);
      case 'thread_group':
        return context.triggerMessageId
          ? this.replyInThread(context.triggerMessageId, jid, text)
          : this.sendToChat(jid, text);
    }
  }

  /** Send a message with reply routing but discard the returned message ID. */
  async sendMessageWithContext(
    jid: string,
    text: string,
    context: ReplyContext,
  ): Promise<void> {
    await this.sendMessageGetIdWithContext(jid, text, context);
  }

  // ── Reactions ─────────────────────────────────────────────────────────────

  async addReaction(messageId: string, emoji: string): Promise<string | null> {
    return this.sender.addReaction(messageId, emoji);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    return this.sender.removeReaction(messageId, reactionId);
  }

  // ── Group sync ────────────────────────────────────────────────────────────

  async syncGroups(_force: boolean): Promise<void> {
    const token = await this.getToken();
    const chats = await this.sender.getChatList(token);
    for (const chat of chats) {
      const jid = `${JID_PREFIX}${chat.chatId}`;
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        chat.name,
        'feishu',
        true,
      );
    }
    logger.info({ count: chats.length }, 'Feishu: synced groups');
  }

  // ── Token helper ──────────────────────────────────────────────────────────

  /** Get a tenant access token for raw-fetch operations. */
  private async getToken(): Promise<string> {
    const res = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
    );
    const data = (await res.json()) as {
      tenant_access_token: string;
      expire: number;
    };
    return data.tenant_access_token;
  }

  // ── User name resolution ──────────────────────────────────────────────────

  private async resolveUserName(openId: string): Promise<string> {
    if (!openId) return 'Unknown';
    const cached = getCachedUserName(openId);
    if (cached) return cached;

    try {
      const token = await this.getToken();
      const info = await this.sender.getUserInfo(openId, token);
      if (!info) {
        logger.warn(
          { openId },
          'Feishu: getUserInfo returned null (check contact:user.base:readonly permission)',
        );
      }
      const name = info?.name ?? openId;
      setCachedUserName(openId, name);
      return name;
    } catch (err) {
      logger.warn({ err, openId }, 'Feishu: resolveUserName failed');
      return openId;
    }
  }

  // ── Inbound event handling ────────────────────────────────────────────────

  private async handleInboundEvent(
    data: Record<string, unknown>,
  ): Promise<void> {
    const parsed = parseInboundEvent(data);
    if (!parsed) return;

    // Deduplication: WebSocket may re-deliver on reconnection
    if (isDuplicate(parsed.messageId)) {
      logger.debug(
        { messageId: parsed.messageId },
        'Feishu: duplicate message, skipping',
      );
      return;
    }
    markSeen(parsed.messageId);

    // Resolve sender's display name
    const senderName = await this.resolveUserName(parsed.userId);

    // Translate @mentions to canonical trigger name.
    // Feishu embeds mentions as @_user_1 (using mention.key) in the text,
    // not as @RealName. We replace the key placeholder with @ASSISTANT_NAME
    // so TRIGGER_PATTERN can match.
    let text = parsed.text;
    for (const mention of parsed.mentions) {
      if (mention.key) {
        text = text.replace(mention.key, `@${ASSISTANT_NAME}`);
      }
    }

    // Notify chat metadata discovery
    this.opts.onChatMetadata(
      parsed.chatJid,
      parsed.timestamp,
      undefined,
      'feishu',
      parsed.chatType === 'group',
    );

    // Only process messages for registered groups.
    // If the chat is new, auto-register it and continue with the current message.
    if (!this.opts.registeredGroups()[parsed.chatJid]) {
      if (this.opts.onAutoRegister) {
        logger.info(
          { chatJid: parsed.chatJid, isGroup: parsed.chatType === 'group' },
          'Feishu: auto-registering new chat',
        );
        this.opts.onAutoRegister(parsed.chatJid, parsed.chatType === 'group');
      }
      // Re-check: if registration failed (no callback or callback threw), drop the message
      if (!this.opts.registeredGroups()[parsed.chatJid]) {
        logger.info(
          { chatJid: parsed.chatJid },
          'Feishu: message from unregistered chat, ignoring',
        );
        return;
      }
    }

    // Add "OneSecond" reaction (⏱) to confirm receipt while processing
    const reactionId = await this.sender.addReaction(
      parsed.messageId,
      'OneSecond',
    );

    // Append to daily conversation log
    const group = this.opts.registeredGroups()[parsed.chatJid];
    if (group) {
      const groupDir = path.join(GROUPS_DIR, group.folder);
      const conversationsDir = path.join(groupDir, 'conversations');
      appendConversationLog(
        conversationsDir,
        senderName,
        text,
        parsed.timestamp,
      );
    }

    logger.info(
      {
        chatJid: parsed.chatJid,
        userId: parsed.userId,
        senderName,
        interactionType: parsed.interactionType,
        threadRootId: parsed.threadRootId,
        msgType: parsed.messageType,
        textPreview: text.slice(0, 80),
      },
      'Feishu: inbound message',
    );

    // Determine thread_id for session/context resolution:
    // - thread_group: threadRootId isolates the topic's session
    // - p2p/group: no thread isolation (group-level session)
    const threadId =
      parsed.interactionType === 'thread_group'
        ? parsed.threadRootId
        : undefined;

    this.opts.onMessage(parsed.chatJid, {
      id: parsed.messageId,
      chat_jid: parsed.chatJid,
      sender: parsed.userId,
      sender_name: senderName,
      content: text,
      timestamp: parsed.timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id: threadId,
      reactionId: reactionId ?? undefined,
      triggerMessageId: parsed.messageId,
      interactionType: parsed.interactionType,
    });
  }
}

// ReplyContext is imported from ../types.js

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannel('feishu', (opts: ChannelOpts): FeishuChannel | null => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = env.FEISHU_APP_ID || process.env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return new FeishuChannel(appId, appSecret, opts);
});
