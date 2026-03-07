import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';
const JID_PREFIX = 'feishu:';

interface ThreadState {
  /** The message_id that is the root of this thread — used as reply target. */
  rootMessageId: string;
  /** Same value used as thread_id in DB and session keys. */
  threadId: string;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private wsClient: Lark.WSClient | null = null;
  private connected = false;
  private tenantAccessToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * Active thread per chat JID.
   * Updated every time an inbound message arrives: if the message belongs to a
   * thread (has root_id) we track that thread; if it is a new top-level message
   * we start a fresh thread rooted at its own message_id.
   */
  private activeThread = new Map<string, ThreadState>();

  constructor(
    private appId: string,
    private appSecret: string,
    private opts: {
      onMessage: OnInboundMessage;
      onChatMetadata: OnChatMetadata;
      registeredGroups: () => Record<string, RegisteredGroup>;
    },
  ) {}

  // ── Token management ──────────────────────────────────────────────────────

  private async ensureToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantAccessToken;
    }
    const res = await fetch(
      `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`,
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
    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire - 60) * 1000;
    logger.debug('Feishu tenant access token refreshed');
    return this.tenantAccessToken;
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

  /**
   * Send a message to a Feishu chat.
   *
   * If there is an active thread for this chat (set by the most recent inbound
   * message), we reply to the thread root using reply_in_thread=true.  This
   * ensures that:
   *   - A brand-new top-level message starts a brand-new thread.
   *   - Follow-up messages within an existing thread stay in that thread.
   *
   * Falls back to a plain chat message when no thread state is available.
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendRaw(jid, JSON.stringify({ text }), 'text');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
  }

  // ── Outbound helpers ──────────────────────────────────────────────────────

  /**
   * Build a simple Feishu interactive card containing plain lark_md text.
   * Cards (interactive msg_type) are the only message type that can be
   * edited in-place via the PATCH /im/v1/messages/{id} API.
   */
  private buildProgressCard(text: string): string {
    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: text },
        },
      ],
    });
  }

  /**
   * Core send helper. Sends to a thread reply or directly to the chat.
   * @param content  Pre-serialised message content string (JSON for text/card).
   * @param msgType  Feishu message type: 'text' | 'interactive'.
   * Returns the new message_id.
   */
  private async sendRaw(
    jid: string,
    content: string,
    msgType: 'text' | 'interactive',
  ): Promise<string> {
    const thread = this.activeThread.get(jid);
    if (thread) {
      return this.replyInThread(thread.rootMessageId, jid, content, msgType);
    }
    return this.sendToChat(jid, content, msgType);
  }

  /**
   * Reply to a message with reply_in_thread=true.
   * Returns the message_id of the sent reply.
   * If the thread no longer exists (error 230019) falls back to sendToChat.
   */
  private async replyInThread(
    messageId: string,
    chatJid: string,
    content: string,
    msgType: 'text' | 'interactive',
  ): Promise<string> {
    const token = await this.ensureToken();
    const res = await fetch(
      `${FEISHU_BASE_URL}/im/v1/messages/${messageId}/reply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          msg_type: msgType,
          reply_in_thread: 'true',
        }),
      },
    );

    if (res.ok) {
      const data = (await res.json()) as { data?: { message_id?: string } };
      return data.data?.message_id ?? '';
    }

    const body = await res.text();
    let code: number | undefined;
    try {
      code = (JSON.parse(body) as { code?: number }).code;
    } catch {
      /* ignore */
    }

    if (code === 230019) {
      // Thread was deleted by the user — fall back to plain chat message
      logger.warn(
        { messageId, chatJid },
        'Feishu: thread gone (230019), sending to chat',
      );
      return this.sendToChat(chatJid, content, msgType);
    }

    logger.error(
      { messageId, status: res.status, body },
      'Feishu: reply failed',
    );
    throw new Error(`Feishu reply failed: ${res.status}`);
  }

  private async sendToChat(
    jid: string,
    content: string,
    msgType: 'text' | 'interactive',
  ): Promise<string> {
    const chatId = jid.slice(JID_PREFIX.length);
    const token = await this.ensureToken();
    const res = await fetch(
      `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          content,
          msg_type: msgType,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      logger.error({ jid, status: res.status, body }, 'Feishu: send failed');
      throw new Error(`Feishu send failed: ${res.status}`);
    }
    const data = (await res.json()) as { data?: { message_id?: string } };
    return data.data?.message_id ?? '';
  }

  /**
   * Send a live progress message as an interactive card and return its message_id.
   * Cards are the only Feishu message type that supports in-place editing.
   */
  async sendMessageGetId(jid: string, text: string): Promise<string> {
    return this.sendRaw(jid, this.buildProgressCard(text), 'interactive');
  }

  /**
   * Edit the content of a previously sent interactive card in-place.
   */
  async updateMessage(messageId: string, text: string): Promise<void> {
    if (!messageId) return;
    const token = await this.ensureToken();
    const res = await fetch(
      `${FEISHU_BASE_URL}/im/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: this.buildProgressCard(text),
          msg_type: 'interactive',
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      logger.error(
        { messageId, status: res.status, body },
        'Feishu: update failed',
      );
      throw new Error(`Feishu update failed: ${res.status}`);
    }
  }

  // ── Inbound event handling ────────────────────────────────────────────────

  private async handleInboundEvent(
    data: Record<string, unknown>,
  ): Promise<void> {
    const event = data as Record<string, unknown>;
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return;

    const sender = event.sender as Record<string, unknown> | undefined;
    const senderId = sender?.sender_id as Record<string, unknown> | undefined;

    const chatId = (message.chat_id as string) ?? '';
    if (!chatId) return;

    const chatJid = `${JID_PREFIX}${chatId}`;
    const chatType =
      (message.chat_type as string) === 'group' ? 'group' : 'p2p';
    const messageId = (message.message_id as string) ?? '';
    const rootId = (message.root_id as string) || undefined;
    const userId = (senderId?.open_id as string) ?? '';
    const timestamp = new Date().toISOString();

    // Determine thread root:
    //   - If the inbound message is itself part of an existing thread, root_id
    //     points to the thread root.
    //   - If it is a new top-level message, the message itself becomes the root
    //     of a fresh thread.
    const threadId = rootId ?? messageId;

    // Always update the active thread so sendMessage targets the right thread.
    this.activeThread.set(chatJid, { rootMessageId: threadId, threadId });

    // Parse text content
    let text = '';
    try {
      const content = JSON.parse((message.content as string) ?? '{}');
      text = content.text ?? '';
    } catch {
      text = '';
    }
    if (!text) return;

    // Translate Feishu @mentions to the canonical trigger format
    const rawMentions =
      (message.mentions as Array<Record<string, unknown>>) ?? [];
    for (const m of rawMentions) {
      const name = (m.name as string) ?? '';
      if (name) text = text.replace(`@${name}`, `@${ASSISTANT_NAME}`);
    }

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      undefined,
      'feishu',
      chatType === 'group',
    );

    const registeredGroups = this.opts.registeredGroups();
    if (!registeredGroups[chatJid]) {
      logger.info(
        { chatJid },
        'Feishu: message from unregistered chat, ignoring',
      );
      return;
    }

    logger.info(
      {
        chatJid,
        userId,
        threadId,
        isNewThread: !rootId,
        textPreview: text.slice(0, 80),
      },
      'Feishu: inbound message',
    );

    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: userId,
      sender_name: userId || 'Unknown',
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id: threadId,
    });
  }
}

// Self-register when this module is imported
registerChannel('feishu', (opts: ChannelOpts): FeishuChannel | null => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = env.FEISHU_APP_ID || process.env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return new FeishuChannel(appId, appSecret, opts);
});
