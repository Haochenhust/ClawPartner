import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  HEARTBEAT_INTERVAL_MS,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  STREAM_PROGRESS,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesByThread,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getThreadSession,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setThreadSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup, ReplyContext } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// In-memory map: messageId → { reactionId, triggerMessageId, interactionType }
// These fields are transient (only needed between message receipt and processing completion)
// so they don't need to be persisted to the database.
const messageMetadata = new Map<
  string,
  {
    reactionId?: string;
    triggerMessageId?: string;
    interactionType?: 'p2p' | 'group' | 'thread_group';
  }
>();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // ── Context resolution — three interaction types ───────────────────────
  //
  // p2p / group:    one group-level session; all messages since last cursor
  // thread_group:   per-topic session; only messages from the active thread
  //
  // We infer interaction type from the most-recent new message's interactionType
  // field (set by FeishuChannel.handleInboundEvent).  For non-Feishu channels
  // (WhatsApp, Telegram …) interactionType is undefined → treated as group.

  const globalCursor = lastAgentTimestamp[chatJid] || '';
  const allNewMessages = getMessagesSince(
    chatJid,
    globalCursor,
    ASSISTANT_NAME,
  );

  if (allNewMessages.length === 0) return true;

  const latestMsg = allNewMessages[allNewMessages.length - 1];
  // DB doesn't store interactionType — retrieve from in-memory metadata
  const latestMeta = messageMetadata.get(latestMsg.id);
  const interactionType =
    latestMeta?.interactionType ?? latestMsg.interactionType ?? 'group';

  // For thread_group: isolate context to the active topic thread
  const latestThreadId =
    interactionType === 'thread_group'
      ? (latestMsg.thread_id ?? undefined)
      : undefined;
  const isThreadAware = latestThreadId !== undefined;

  let missedMessages;
  let cursorKey: string;

  if (isThreadAware && latestThreadId) {
    cursorKey = `${chatJid}:${latestThreadId}`;
    missedMessages = getMessagesByThread(
      chatJid,
      latestThreadId,
      ASSISTANT_NAME,
    );
  } else {
    cursorKey = chatJid;
    missedMessages = allNewMessages;
  }

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursors. For thread-aware channels we advance both the per-thread
  // cursor (cursorKey) and the global chatJid cursor so the outer loop
  // doesn't keep seeing the same messages as "new".
  const previousCursor = lastAgentTimestamp[cursorKey] || '';
  const latestTimestamp = missedMessages[missedMessages.length - 1].timestamp;
  lastAgentTimestamp[cursorKey] = latestTimestamp;
  if (isThreadAware) lastAgentTimestamp[chatJid] = latestTimestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      threadId: latestThreadId,
    },
    'Processing messages',
  );

  // ── Session resolution ─────────────────────────────────────────────────
  // Thread-aware channels get a per-thread Claude session so continuity is
  // maintained within a thread, and each new thread starts fresh (undefined).
  // Non-thread-aware channels always reuse the group-wide session.
  const sessionId =
    isThreadAware && latestThreadId
      ? (getThreadSession(chatJid, latestThreadId) ?? undefined) // undefined = fresh start for new threads
      : (sessions[group.folder] ?? undefined); // fallback to group session

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Heartbeat timer: fallback for when agent is silent for a long time
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const heartbeatStart = Date.now();

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const resetHeartbeat = () => {
    stopHeartbeat();
    if (!HEARTBEAT_INTERVAL_MS) return;
    heartbeatTimer = setInterval(async () => {
      const mins = Math.round((Date.now() - heartbeatStart) / 60_000);
      await ctxSend(`⏳ 任务仍在处理中（已用时约 ${mins} 分钟）`);
    }, HEARTBEAT_INTERVAL_MS);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let reactionRemoved = false;

  // Build reply context so sends are routed to the correct place
  // (quoted reply in groups, thread reply in topic groups, direct in p2p).
  const triggerMsgId = latestMeta?.triggerMessageId;
  const replyContext: ReplyContext = {
    type: interactionType as ReplyContext['type'],
    triggerMessageId: triggerMsgId,
  };

  const ctxSend = async (text: string): Promise<void> => {
    if (channel.sendMessageWithContext) {
      await channel.sendMessageWithContext(chatJid, text, replyContext);
    } else {
      await channel.sendMessage(chatJid, text);
    }
  };

  const ctxSendGetId = async (text: string): Promise<string> => {
    if (channel.sendMessageGetIdWithContext) {
      return channel.sendMessageGetIdWithContext(chatJid, text, replyContext);
    }
    if (channel.sendMessageGetId) {
      return channel.sendMessageGetId(chatJid, text);
    }
    await channel.sendMessage(chatJid, text);
    return '';
  };

  // State for in-place progress+result message (channels that support editing)
  let progressMessageId: string | null = null;
  const progressLines: string[] = [];
  let resultText: string | null = null;

  /**
   * Build the combined text for the live progress message.
   * Progress lines are shown first; when the result arrives it is appended
   * after a visual separator so the two sections are clearly distinguished.
   */
  const buildLiveMessage = (): string => {
    // '---' renders as a horizontal rule in Feishu lark_md cards
    const SEPARATOR = '\n\n---\n\n';
    const progressSection = progressLines.join('\n');
    if (resultText === null) return progressSection;
    return progressSection
      ? progressSection + SEPARATOR + resultText
      : resultText;
  };

  resetHeartbeat();

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      if (result.status === 'progress') {
        resetHeartbeat();
        if (!result.result) return;

        progressLines.push(result.result);
        const fullText = buildLiveMessage();

        if (
          (channel.sendMessageGetIdWithContext || channel.sendMessageGetId) &&
          channel.updateMessage
        ) {
          if (!progressMessageId) {
            try {
              progressMessageId = await ctxSendGetId(fullText);
            } catch (err) {
              logger.warn(
                { err },
                'Failed to create live progress message, falling back',
              );
              await ctxSend(result.result);
            }
          } else {
            try {
              await channel.updateMessage(progressMessageId, fullText);
            } catch (err) {
              logger.warn(
                { err },
                'Failed to update live progress message, ignoring',
              );
            }
          }
        } else {
          await ctxSend(result.result);
        }
        return;
      }

      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          if (progressMessageId && channel.updateMessage) {
            // Append result to the existing live message after a separator
            resultText = text;
            const fullText = buildLiveMessage();
            try {
              await channel.updateMessage(progressMessageId, fullText);
            } catch (err) {
              logger.warn(
                { err },
                'Failed to append result to live message, sending separately',
              );
              await ctxSend(text);
            }
            // Reset live-message state so a subsequent turn starts fresh
            progressMessageId = null;
            progressLines.length = 0;
            resultText = null;
          } else {
            await ctxSend(text);
          }
          outputSentToUser = true;

          // Remove receipt reaction as soon as the first result is sent
          if (!reactionRemoved) {
            const tMsg = missedMessages[missedMessages.length - 1];
            const tMeta = tMsg ? messageMetadata.get(tMsg.id) : undefined;
            if (tMeta?.reactionId && tMsg?.id && channel.removeReaction) {
              reactionRemoved = true;
              channel
                .removeReaction(tMsg.id, tMeta.reactionId)
                .catch((err) =>
                  logger.warn({ err }, 'Failed to remove receipt reaction'),
                );
              messageMetadata.delete(tMsg.id);
            }
          }
        }
        resetIdleTimer();
      }
      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
        stopHeartbeat();
      }
      if (result.status === 'error') {
        hadError = true;
        stopHeartbeat();
      }
    },
    sessionId,
    latestThreadId,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  stopHeartbeat();

  // Close Cardkit streaming mode if applicable
  if (
    progressMessageId &&
    (channel as unknown as { closeStreaming?: (id: string) => Promise<void> })
      .closeStreaming
  ) {
    const feishuChannel = channel as unknown as {
      closeStreaming: (id: string) => Promise<void>;
    };
    feishuChannel
      .closeStreaming(progressMessageId)
      .catch((err) =>
        logger.warn({ err }, 'Failed to close Cardkit streaming'),
      );
  }

  // Clean up: remove reaction if it wasn't already removed in the streaming callback
  // (e.g. container exited without producing output)
  if (!reactionRemoved) {
    const triggerMsg = missedMessages[missedMessages.length - 1];
    const triggerMeta = triggerMsg
      ? messageMetadata.get(triggerMsg.id)
      : undefined;
    if (triggerMeta?.reactionId && triggerMsg?.id && channel.removeReaction) {
      channel
        .removeReaction(triggerMsg.id, triggerMeta.reactionId)
        .catch((err) =>
          logger.warn({ err }, 'Failed to remove receipt reaction'),
        );
    }
    if (triggerMsg) messageMetadata.delete(triggerMsg.id);
  }

  // Thread→session persistence is now handled by runAgent via threadSessions
  // output from the container, which covers all threads seen during the
  // container's lifetime (including mid-query thread switches).

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    lastAgentTimestamp[cursorKey] = previousCursor;
    if (isThreadAware) lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  overrideSessionId?: string,
  threadId?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Use exactly the session ID resolved by the caller — no silent fallback.
  // For thread-aware channels, undefined means a fresh session for a new thread.
  // For non-thread-aware channels, the caller already provides sessions[group.folder].
  const sessionId = overrideSessionId;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const persistThreadSessions = (ts: Record<string, string>) => {
    for (const [tid, sid] of Object.entries(ts)) {
      setThreadSession(chatJid, tid, sid);
    }
    logger.debug(
      { group: group.name, count: Object.keys(ts).length },
      'Persisted thread→session mappings',
    );
  };

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.threadSessions) {
          persistThreadSessions(output.threadSessions);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        threadId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        streamProgress: STREAM_PROGRESS,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.threadSessions) {
      persistThreadSessions(output.threadSessions);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          // Compute thread context for the IPC message so the container can
          // detect a thread switch and resume the correct Claude session.
          const latestIpcMsg = [...messagesToSend]
            .reverse()
            .find((m) => m.thread_id);
          const ipcThreadId = latestIpcMsg?.thread_id;
          const ipcSessionId = ipcThreadId
            ? (getThreadSession(chatJid, ipcThreadId) ?? undefined)
            : undefined;

          if (
            queue.sendMessage(chatJid, formatted, ipcThreadId, ipcSessionId)
          ) {
            logger.debug(
              { chatJid, count: messagesToSend.length, ipcThreadId },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
      // Stash transient metadata that the DB doesn't store
      if (msg.reactionId || msg.triggerMessageId || msg.interactionType) {
        messageMetadata.set(msg.id, {
          reactionId: msg.reactionId,
          triggerMessageId: msg.triggerMessageId,
          interactionType: msg.interactionType,
        });
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onAutoRegister: (chatJid: string, isGroup: boolean) => {
      // Derive a safe folder name from the JID: "feishu:oc_abc123" → "feishu_oc_abc123"
      const sanitized = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
      const folder = sanitized.slice(0, 64); // cap length for filesystem safety
      // Use a human-readable name initially; syncGroups will fill in the real name later
      const chatId = chatJid.includes(':') ? chatJid.split(':')[1] : chatJid;
      registerGroup(chatJid, {
        name: chatId,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isGroup,
        isMain: false,
      });
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
