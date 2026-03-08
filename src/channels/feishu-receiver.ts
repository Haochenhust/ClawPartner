/**
 * Feishu inbound message parser and deduplication utilities.
 *
 * Handles all message types: text, post (rich text), image, file, audio, video,
 * sticker, and quoted replies.  Non-text attachments are described with a
 * human-readable placeholder so the agent always receives something useful.
 */
import fs from 'fs';
import path from 'path';

import { appendConversationLog } from '../conversation-log.js';
import { logger } from '../logger.js';
import {
  FeishuAudioContent,
  FeishuFileContent,
  FeishuImageContent,
  FeishuMention,
  FeishuMessage,
  FeishuMessageEvent,
  FeishuPostContent,
  FeishuPostElement,
  FeishuStickerContent,
  FeishuTextContent,
  FeishuVideoContent,
  InteractionType,
  ParsedAttachment,
  ParsedMessage,
} from './feishu-types.js';

const JID_PREFIX = 'feishu:';

// ── Deduplication ─────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface DedupEntry {
  ts: number;
}

const seenMessages = new Map<string, DedupEntry>();

/** Returns true if this message has been seen before; false if it is new. */
export function isDuplicate(messageId: string): boolean {
  pruneDedup();
  return seenMessages.has(messageId);
}

/** Mark a message as seen so future duplicates are detected. */
export function markSeen(messageId: string): void {
  seenMessages.set(messageId, { ts: Date.now() });
}

function pruneDedup(): void {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [id, entry] of seenMessages) {
    if (entry.ts < cutoff) seenMessages.delete(id);
  }
}

// ── User name LRU cache ───────────────────────────────────────────────────────

const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface UserCacheEntry {
  name: string;
  ts: number;
}

const userNameCache = new Map<string, UserCacheEntry>();

/** Get cached display name for an open_id (undefined = cache miss). */
export function getCachedUserName(openId: string): string | undefined {
  const entry = userNameCache.get(openId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > USER_CACHE_TTL_MS) {
    userNameCache.delete(openId);
    return undefined;
  }
  return entry.name;
}

/** Store a resolved user name in the cache. */
export function setCachedUserName(openId: string, name: string): void {
  userNameCache.set(openId, { name, ts: Date.now() });
}

// ── Rich text (post) extraction ───────────────────────────────────────────────

/** Recursively convert a Feishu post element to Markdown-flavoured text. */
function extractPostElement(el: FeishuPostElement): string {
  switch (el.tag) {
    case 'text': {
      let t = el.text ?? '';
      const style = el.style ?? [];
      if (style.includes('code') || style.includes('inline_code')) {
        t = `\`${t}\``;
      } else {
        if (style.includes('bold')) t = `*${t}*`;
        if (style.includes('italic')) t = `_${t}_`;
        if (style.includes('strikethrough')) t = `~~${t}~~`;
      }
      return t;
    }
    case 'a':
      return `[${el.text}](${el.href})`;
    case 'at':
      return `@${el.user_name ?? el.user_id}`;
    case 'img':
      return `[图片: ${el.image_key}]`;
    case 'code_block':
      return `\n\`\`\`${el.language ?? ''}\n${el.text}\n\`\`\`\n`;
    default:
      return '';
  }
}

/** Convert a Feishu post (rich text) content JSON to plain Markdown. */
export function extractRichText(postJson: string): string {
  try {
    const post = JSON.parse(postJson) as Record<string, unknown>;

    // Post messages use locale keys: { zh_cn: { content: [...] }, en_us: ... }
    // or just a bare { content: [...] }. Pick the first locale that has content.
    let body: FeishuPostContent | undefined;
    if (Array.isArray((post as unknown as FeishuPostContent).content)) {
      body = post as unknown as FeishuPostContent;
    } else {
      for (const val of Object.values(post)) {
        if (
          val &&
          typeof val === 'object' &&
          Array.isArray((val as FeishuPostContent).content)
        ) {
          body = val as FeishuPostContent;
          break;
        }
      }
    }

    if (!body) return '';
    const lines = (body.content ?? []).map((row) =>
      row.map(extractPostElement).join(''),
    );
    return lines.join('\n').trim();
  } catch {
    return '';
  }
}

// ── Message parser ────────────────────────────────────────────────────────────

/**
 * Determine interaction type from the raw Feishu message.
 *
 * - thread_group: message belongs to a topic (话题群), indicated by thread_id
 * - p2p: direct/private message
 * - group: regular group chat
 *
 * NOTE: root_id is NOT reliable for detecting topic groups — it is also
 * present on quoted-reply messages in normal groups. thread_id is the
 * correct discriminator: only topic-group messages carry this field.
 */
function resolveInteractionType(message: FeishuMessage): InteractionType {
  if (message.chat_type === 'p2p') return 'p2p';
  if (message.thread_id) return 'thread_group';
  return 'group';
}

/** Parse a raw Feishu im.message.receive_v1 event into a structured message. */
export function parseInboundEvent(
  data: Record<string, unknown>,
): ParsedMessage | null {
  const event = data as unknown as FeishuMessageEvent;
  const message = event.message;
  if (!message) return null;

  const sender = event.sender;
  const chatId = message.chat_id ?? '';
  if (!chatId) return null;

  const messageId = message.message_id ?? '';
  if (!messageId) return null;

  const userId = sender?.sender_id?.open_id ?? '';
  const chatJid = `${JID_PREFIX}${chatId}`;
  const interactionType = resolveInteractionType(message);
  const threadRootId =
    interactionType === 'thread_group' ? message.thread_id : undefined;
  const timestamp = new Date(
    parseInt(message.create_time ?? '0', 10),
  ).toISOString();
  const mentions: FeishuMention[] = message.mentions ?? [];
  const msgType = message.message_type ?? 'text';

  // Parse content based on message type
  let text = '';
  const attachments: ParsedAttachment[] = [];

  switch (msgType) {
    case 'text': {
      try {
        const c = JSON.parse(message.content) as FeishuTextContent;
        text = c.text ?? '';
      } catch {
        text = '';
      }
      break;
    }

    case 'post': {
      text = extractRichText(message.content);
      break;
    }

    case 'image': {
      try {
        const c = JSON.parse(message.content) as FeishuImageContent;
        attachments.push({
          type: 'image',
          imageKey: c.image_key,
          placeholder: '[图片]',
        });
        text = '[图片]';
      } catch {
        text = '[图片]';
      }
      break;
    }

    case 'file': {
      try {
        const c = JSON.parse(message.content) as FeishuFileContent;
        const name = c.file_name ?? c.file_key ?? '文件';
        attachments.push({
          type: 'file',
          fileKey: c.file_key,
          fileName: c.file_name,
          placeholder: `[文件: ${name}]`,
        });
        text = `[文件: ${name}]`;
      } catch {
        text = '[文件]';
      }
      break;
    }

    case 'audio': {
      try {
        const c = JSON.parse(message.content) as FeishuAudioContent;
        const dur = c.duration ? ` ${Math.round(c.duration / 1000)}秒` : '';
        attachments.push({
          type: 'audio',
          fileKey: c.file_key,
          placeholder: `[语音消息${dur}]`,
        });
        text = `[语音消息${dur}]`;
      } catch {
        text = '[语音消息]';
      }
      break;
    }

    case 'video': {
      try {
        const c = JSON.parse(message.content) as FeishuVideoContent;
        const dur = c.duration ? ` ${Math.round(c.duration / 1000)}秒` : '';
        attachments.push({
          type: 'video',
          fileKey: c.file_key,
          placeholder: `[视频${dur}]`,
        });
        text = `[视频${dur}]`;
      } catch {
        text = '[视频]';
      }
      break;
    }

    case 'sticker': {
      try {
        const c = JSON.parse(message.content) as FeishuStickerContent;
        attachments.push({
          type: 'sticker',
          fileKey: c.file_key,
          placeholder: '[表情包]',
        });
        text = '[表情包]';
      } catch {
        text = '[表情包]';
      }
      break;
    }

    default:
      text = `[${msgType} 消息]`;
      break;
  }

  if (!text) {
    logger.debug(
      { messageId, msgType },
      'Feishu: empty text after parsing, using placeholder',
    );
    text = `[${msgType} 消息]`;
  }

  return {
    messageId,
    chatId,
    chatJid,
    chatType: message.chat_type,
    interactionType,
    userId,
    threadRootId,
    messageType: msgType as ParsedMessage['messageType'],
    text,
    attachments,
    timestamp,
    mentions,
  };
}

// ── Attachment download ───────────────────────────────────────────────────────

/**
 * Save attachment buffer to a local path under the group workspace.
 * Returns the local path on success, null on failure.
 */
export function saveAttachment(
  buffer: Buffer,
  workspaceDir: string,
  fileName: string,
): string | null {
  try {
    const uploadsDir = path.join(workspaceDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const dest = path.join(uploadsDir, fileName);
    fs.writeFileSync(dest, buffer);
    return dest;
  } catch (err) {
    logger.warn(
      { workspaceDir, fileName, err },
      'Feishu: saveAttachment failed',
    );
    return null;
  }
}

export { appendConversationLog };
