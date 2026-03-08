/**
 * Complete TypeScript type definitions for Feishu/Lark events and messages.
 */

// ── Raw event structures ──────────────────────────────────────────────────────

export interface FeishuMessageEvent {
  sender: FeishuSender;
  message: FeishuMessage;
}

export interface FeishuSender {
  sender_id: {
    open_id: string;
    union_id: string;
    user_id: string;
  };
  sender_type: string;
  tenant_key: string;
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  update_time?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  message_type: FeishuMessageType;
  content: string; // JSON string
  mentions?: FeishuMention[];
  thread_id?: string; // present in topic-group (话题群) messages
}

export type FeishuMessageType =
  | 'text'
  | 'post'
  | 'image'
  | 'file'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'interactive'
  | 'share_chat'
  | 'share_user'
  | 'system';

export interface FeishuMention {
  key: string;
  id: {
    open_id: string;
    union_id: string;
    user_id: string;
  };
  name: string;
  tenant_key: string;
}

// ── Message content JSON structures ──────────────────────────────────────────

export interface FeishuTextContent {
  text: string;
}

export interface FeishuPostContent {
  title?: string;
  content: FeishuPostElement[][];
}

export type FeishuPostElement =
  | FeishuPostText
  | FeishuPostLink
  | FeishuPostAt
  | FeishuPostImage
  | FeishuPostCode;

export interface FeishuPostText {
  tag: 'text';
  text: string;
  style?: string[]; // 'bold', 'italic', 'strikethrough', 'underline', 'inline_code'
}

export interface FeishuPostLink {
  tag: 'a';
  text: string;
  href: string;
}

export interface FeishuPostAt {
  tag: 'at';
  user_id: string;
  user_name?: string;
}

export interface FeishuPostImage {
  tag: 'img';
  image_key: string;
  width?: number;
  height?: number;
}

export interface FeishuPostCode {
  tag: 'code_block';
  language?: string;
  text: string;
}

export interface FeishuImageContent {
  image_key: string;
}

export interface FeishuFileContent {
  file_key: string;
  file_name?: string;
}

export interface FeishuAudioContent {
  file_key: string;
  duration?: number;
}

export interface FeishuVideoContent {
  file_key: string;
  image_key?: string; // thumbnail
  duration?: number;
}

export interface FeishuStickerContent {
  file_key: string;
}

// ── API response types ────────────────────────────────────────────────────────

export interface FeishuApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

export interface FeishuUserInfo {
  open_id: string;
  name: string;
  en_name?: string;
  nickname?: string;
  avatar_url?: string;
}

// ── Parsed message for internal use ──────────────────────────────────────────

/**
 * Interaction type determines context isolation and reply routing.
 *
 * - p2p: private chat, continuous session, reply directly
 * - group: normal group chat, one group-level session, reply to trigger message
 * - thread_group: topic group (话题群), per-thread session, reply within thread
 */
export type InteractionType = 'p2p' | 'group' | 'thread_group';

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  chatJid: string;
  chatType: 'p2p' | 'group';
  interactionType: InteractionType;
  userId: string;
  threadRootId?: string; // set for thread_group — the root message ID of the topic
  messageType: FeishuMessageType;
  text: string;
  attachments: ParsedAttachment[];
  timestamp: string;
  mentions: FeishuMention[];
}

export interface ParsedAttachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  fileKey?: string;
  imageKey?: string;
  fileName?: string;
  localPath?: string; // path after download
  placeholder: string; // text description for the agent
}
