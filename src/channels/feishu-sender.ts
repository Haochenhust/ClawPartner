/**
 * Feishu outbound helpers — all HTTP calls through Lark.Client.
 *
 * Token management is handled automatically by the SDK.
 */
import * as Lark from '@larksuiteoapi/node-sdk';

import { logger } from '../logger.js';
import { FeishuUserInfo } from './feishu-types.js';

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

export class FeishuSender {
  readonly client: Lark.Client;

  constructor(appId: string, appSecret: string) {
    this.client = new Lark.Client({ appId, appSecret });
  }

  // ── Card builder ────────────────────────────────────────────────────────────

  /** Convert Markdown to lark_md format. */
  static markdownToLarkMd(text: string): string {
    return (
      text
        // **bold** → *bold* (lark uses single asterisk)
        .replace(/\*\*([^*]+)\*\*/g, '*$1*')
        // __bold__ → *bold*
        .replace(/__([^_]+)__/g, '*$1*')
        // # Heading → *Heading* (lark doesn't have headings, use bold)
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        // [text](url) → <text|url>  (lark hyperlink format in lark_md)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
      // ~~strikethrough~~ → ~~strikethrough~~ (lark supports)
      // _italic_ → _italic_ (lark supports)
      // `code` → `code` (lark supports)
      // ```block``` → ```block``` (lark supports)
    );
  }

  /** Build a simple interactive card with lark_md content. */
  buildCard(text: string): string {
    const larkText = FeishuSender.markdownToLarkMd(text);
    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: larkText },
        },
      ],
    });
  }

  /** Build a rich interactive card with separate sections for thinking and result. */
  buildRichCard(resultText: string, thinkingText?: string): string {
    const elements = [];

    if (thinkingText) {
      elements.push({
        tag: 'collapsible_panel',
        header: {
          title: { tag: 'plain_text', content: '💭 思考过程' },
          vertical_align: 'center',
        },
        expanded: false,
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: FeishuSender.markdownToLarkMd(thinkingText),
            },
          },
        ],
      });
    }

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: FeishuSender.markdownToLarkMd(resultText),
      },
    });

    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements,
    });
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  /** Send a new message (card or text) to a chat by chat_id. */
  async sendToChat(
    chatId: string,
    content: string,
    msgType: 'text' | 'interactive' = 'interactive',
  ): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content,
        msg_type: msgType,
      },
    });
    return res.data?.message_id ?? '';
  }

  /**
   * Reply to a specific message.
   * reply_in_thread=false → shows in chat as a quoted reply.
   * Used for: normal groups (reply to trigger message).
   */
  async replyToMessage(
    messageId: string,
    content: string,
    msgType: 'text' | 'interactive' = 'interactive',
  ): Promise<string> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content,
        msg_type: msgType,
        reply_in_thread: false,
      },
    });
    return res.data?.message_id ?? '';
  }

  /**
   * Reply within a thread (reply_in_thread=true).
   * Used for: topic groups (话题群).
   * Falls back to sendToChat on thread-deleted error (code 230019).
   */
  async replyInThread(
    messageId: string,
    chatId: string,
    content: string,
    msgType: 'text' | 'interactive' = 'interactive',
  ): Promise<string> {
    try {
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content,
          msg_type: msgType,
          reply_in_thread: true,
        },
      });
      return res.data?.message_id ?? '';
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 230019) {
        logger.warn(
          { messageId, chatId },
          'Feishu: thread gone (230019), falling back to chat',
        );
        return this.sendToChat(chatId, content, msgType);
      }
      throw err;
    }
  }

  /** Edit an existing interactive card in-place via PATCH. */
  async updateCard(messageId: string, content: string): Promise<void> {
    if (!messageId) return;
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Feishu: updateCard failed');
      throw err;
    }
  }

  // ── Reactions ───────────────────────────────────────────────────────────────

  /** Add an emoji reaction to a message. Returns the reaction_id or null. */
  async addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<string | null> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res.data?.reaction_id ?? null;
    } catch (err) {
      logger.warn({ messageId, emojiType, err }, 'Feishu: addReaction failed');
      return null;
    }
  }

  /** Remove an emoji reaction from a message. */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      logger.warn(
        { messageId, reactionId, err },
        'Feishu: removeReaction failed',
      );
    }
  }

  // ── Cardkit streaming API ────────────────────────────────────────────────────

  /**
   * Create a Cardkit streaming card (JSON 2.0 schema).
   * Returns { cardId, elementId } for subsequent streaming updates.
   *
   * The card has two elements:
   *   - "progress": collapsible panel for agent progress / thinking lines
   *   - "result":   main markdown area for the final answer
   */
  async createStreamingCard(initialText: string): Promise<{
    cardId: string;
    resultElementId: string;
    progressElementId: string;
    progressPanelId: string;
  }> {
    const RESULT_ID = 'nanoclaw_result';
    const PANEL_ID = 'nanoclaw_progress';
    const PROGRESS_MD_ID = 'nanoclaw_progress_md';

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: {
        wide_screen_mode: true,
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 5 },
          print_strategy: 'delay',
        },
      },
      body: {
        elements: [
          {
            tag: 'collapsible_panel',
            element_id: PANEL_ID,
            header: {
              title: {
                tag: 'plain_text',
                content: '💭 思考中...',
              },
              vertical_align: 'center',
            },
            expanded: false,
            elements: [
              {
                tag: 'markdown',
                element_id: PROGRESS_MD_ID,
                content: '',
              },
            ],
          },
          {
            tag: 'markdown',
            element_id: RESULT_ID,
            content: initialText || '...',
          },
        ],
      },
    });

    const res = await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: cardJson,
      },
    });

    const cardId = res.data?.card_id ?? '';
    if (!cardId) throw new Error('Feishu: cardkit.create returned no card_id');

    return {
      cardId,
      resultElementId: RESULT_ID,
      progressElementId: PROGRESS_MD_ID,
      progressPanelId: PANEL_ID,
    };
  }

  /**
   * Send a message that references an existing Cardkit card.
   * Returns the message_id of the sent message.
   */
  async sendCardKitMessage(chatId: string, cardId: string): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        msg_type: 'interactive',
      },
    });
    return res.data?.message_id ?? '';
  }

  /**
   * Update the content of a Cardkit card element (streaming typewriter effect).
   * sequence must be monotonically increasing.
   */
  async updateCardKitElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    try {
      await this.client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence },
      });
    } catch (err) {
      logger.warn(
        { cardId, elementId, err },
        'Feishu: updateCardKitElement failed',
      );
      throw err;
    }
  }

  /**
   * Close streaming mode on a Cardkit card.
   * Call this when the agent has finished so the "streaming" indicator disappears.
   */
  async closeCardStreaming(cardId: string, sequence: number): Promise<void> {
    try {
      await this.client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence,
        },
      });
    } catch (err) {
      logger.warn({ cardId, err }, 'Feishu: closeCardStreaming failed');
    }
  }

  /**
   * Partially update an element's properties (e.g. collapse a panel).
   */
  async patchCardElement(
    cardId: string,
    elementId: string,
    partial: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    try {
      await this.client.cardkit.v1.cardElement.patch({
        path: { card_id: cardId, element_id: elementId },
        data: { partial_element: JSON.stringify(partial), sequence },
      });
    } catch (err) {
      logger.warn({ cardId, elementId, err }, 'Feishu: patchCardElement failed');
    }
  }

  // ── Image ───────────────────────────────────────────────────────────────────

  /** Upload an image buffer and return its image_key. */
  async uploadImage(imageBuffer: Buffer): Promise<string> {
    try {
      const res = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: imageBuffer,
        },
      });
      // SDK returns image_key at top level for this endpoint
      const r = res as unknown as {
        image_key?: string;
        data?: { image_key?: string };
      };
      return r.image_key ?? r.data?.image_key ?? '';
    } catch (err) {
      logger.warn({ err }, 'Feishu: uploadImage failed');
      throw err;
    }
  }

  // ── Resource download ───────────────────────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video).
   * Uses raw fetch because the SDK returns a ReadableStream instead of Buffer.
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' | 'audio' | 'video',
    token: string,
  ): Promise<Buffer | null> {
    try {
      const res = await fetch(
        `${FEISHU_BASE_URL}/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        logger.warn(
          { messageId, fileKey, status: res.status },
          'Feishu: downloadResource failed',
        );
        return null;
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      logger.warn(
        { messageId, fileKey, err },
        'Feishu: downloadResource error',
      );
      return null;
    }
  }

  // ── User info ───────────────────────────────────────────────────────────────

  /**
   * Fetch user info by open_id.
   * Uses raw fetch to avoid SDK auth quirks with contact API scope.
   */
  async getUserInfo(
    openId: string,
    token: string,
  ): Promise<FeishuUserInfo | null> {
    try {
      const res = await fetch(
        `${FEISHU_BASE_URL}/contact/v3/users/${openId}?user_id_type=open_id`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        logger.warn(
          { openId, status: res.status },
          'Feishu: getUserInfo HTTP error',
        );
        return null;
      }
      const json = (await res.json()) as {
        code: number;
        msg?: string;
        data?: { user?: FeishuUserInfo };
      };
      if (json.code !== 0) {
        logger.warn(
          { openId, code: json.code, msg: json.msg },
          'Feishu: getUserInfo API error',
        );
        return null;
      }
      return json.data?.user ?? null;
    } catch (err) {
      logger.warn({ err, openId }, 'Feishu: getUserInfo exception');
      return null;
    }
  }

  // ── Group list ──────────────────────────────────────────────────────────────

  /** List chats the bot belongs to. */
  async getChatList(
    token: string,
  ): Promise<Array<{ chatId: string; name: string }>> {
    try {
      const res = await fetch(`${FEISHU_BASE_URL}/im/v1/chats?page_size=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        code: number;
        data?: {
          items?: Array<{ chat_id: string; name: string }>;
        };
      };
      if (json.code !== 0) return [];
      return (json.data?.items ?? []).map((item) => ({
        chatId: item.chat_id,
        name: item.name,
      }));
    } catch {
      return [];
    }
  }
}
