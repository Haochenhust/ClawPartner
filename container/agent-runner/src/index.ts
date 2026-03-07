/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  streamProgress?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function truncate(s: string, max = 120): string {
  s = s.trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatToolUseBlock(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      const firstLine = cmd.split('\n')[0];
      return `🔧 Bash: ${truncate(firstLine, 100)}`;
    }
    case 'Read':
      return `📂 Read: ${truncate(String(input.file_path ?? input.path ?? ''), 100)}`;
    case 'Write':
      return `✏️ Write: ${truncate(String(input.file_path ?? input.path ?? ''), 100)}`;
    case 'Edit':
    case 'MultiEdit':
      return `✏️ Edit: ${truncate(String(input.file_path ?? input.path ?? ''), 100)}`;
    case 'Glob':
      return `🔍 Glob: ${truncate(String(input.pattern ?? ''), 100)}`;
    case 'Grep':
      return `🔍 Grep: ${truncate(String(input.pattern ?? ''), 80)}`;
    case 'WebSearch':
      return `🌐 WebSearch: ${truncate(String(input.query ?? ''), 100)}`;
    case 'WebFetch':
      return `🌐 WebFetch: ${truncate(String(input.url ?? ''), 100)}`;
    case 'Task':
      return `🧩 Task: ${truncate(String(input.description ?? input.prompt ?? ''), 100)}`;
    case 'TodoWrite':
      return `📋 TodoWrite`;
    case 'NotebookEdit':
      return `📓 NotebookEdit: ${truncate(String(input.notebook_path ?? ''), 100)}`;
    default:
      return `⚙️ ${name}`;
  }
}

/**
 * Format an SDKMessage into a human-readable progress string.
 * Returns null if the message should not be forwarded.
 */
function formatProgress(
  message: SDKMessage,
  state: { thinkingNotified: boolean; lastProgressByType: Map<string, number>; sentToolProgressIds: Set<string> },
  streamProgress: boolean,
  containerState: { initShown: boolean },
): string | null {
  if (!streamProgress) return null;

  const now = Date.now();
  const THROTTLE_MS = 3000;

  const throttle = (key: string): boolean => {
    const last = state.lastProgressByType.get(key) ?? 0;
    if (now - last < THROTTLE_MS) return true;
    state.lastProgressByType.set(key, now);
    return false;
  };

  switch (message.type) {
    case 'assistant': {
      state.thinkingNotified = false;
      const content = (message as { message?: { content?: unknown[] } }).message?.content;
      if (!Array.isArray(content)) return null;
      const parts: string[] = [];
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'tool_use'
        ) {
          const b = block as { name: string; input: Record<string, unknown> };
          parts.push(formatToolUseBlock(b.name, b.input ?? {}));
        }
      }
      if (parts.length === 0) return null;
      return parts.join('\n');
    }

    case 'tool_use_summary': {
      const summary = (message as { summary?: string }).summary;
      if (!summary) return null;
      if (throttle('tool_use_summary')) return null;
      return summary;
    }

    case 'tool_progress': {
      const tp = message as { tool_use_id: string; tool_name: string; elapsed_time_seconds: number };
      if (tp.elapsed_time_seconds < 10) return null;
      const key = `tool_progress:${tp.tool_use_id}`;
      const last = state.lastProgressByType.get(key) ?? 0;
      if (now - last < 10_000) return null;
      state.lastProgressByType.set(key, now);
      return `⏳ ${tp.tool_name} 执行中（已 ${Math.round(tp.elapsed_time_seconds)}s）`;
    }

    case 'stream_event': {
      if (state.thinkingNotified) return null;
      state.thinkingNotified = true;
      return `💭 正在思考中…`;
    }

    case 'system': {
      const msg = message as { subtype?: string; [key: string]: unknown };
      switch (msg.subtype) {
        case 'init': {
          if (containerState.initShown) return null;
          containerState.initShown = true;
          const model = String(msg.model ?? '');
          return `🤖 Agent 已启动${model ? ` (${model})` : ''}`;
        }
        case 'task_started': {
          const desc = truncate(String(msg.description ?? ''), 100);
          return `🚀 子任务启动: ${desc}`;
        }
        case 'task_progress': {
          if (throttle('task_progress')) return null;
          const usage = msg.usage as { tool_uses?: number; duration_ms?: number } | undefined;
          const tools = usage?.tool_uses ?? 0;
          const secs = Math.round((usage?.duration_ms ?? 0) / 1000);
          return `📊 子任务进度: 已调用 ${tools} 个工具，用时 ${secs}s`;
        }
        case 'task_notification': {
          const tn = msg as { status: string; summary: string };
          const icon = tn.status === 'completed' ? '✅' : '❌';
          return `${icon} 子任务${tn.status === 'completed' ? '完成' : '失败'}: ${truncate(tn.summary, 100)}`;
        }
        case 'compact_boundary': {
          const meta = msg.compact_metadata as { pre_tokens?: number } | undefined;
          const tokens = meta?.pre_tokens ?? 0;
          return `📦 上下文压缩 (${tokens.toLocaleString()} tokens)`;
        }
        case 'hook_started': {
          if (throttle(`hook_started:${msg.hook_name}`)) return null;
          return `🪝 Hook 启动: ${msg.hook_name}`;
        }
        case 'hook_progress': {
          if (throttle(`hook_progress:${msg.hook_name}`)) return null;
          return `🪝 Hook 进度: ${msg.hook_name}`;
        }
        case 'hook_response': {
          const hr = msg as { hook_name: string; outcome: string };
          return `🪝 Hook 完成: ${hr.hook_name} (${hr.outcome})`;
        }
        case 'files_persisted': {
          const files = (msg.files as unknown[]) ?? [];
          return `💾 已保存 ${files.length} 个文件`;
        }
        case 'elicitation_complete': {
          const server = String(msg.mcp_server_name ?? '');
          return `📝 MCP 交互完成${server ? `: ${server}` : ''}`;
        }
        case 'status': {
          if (throttle('status')) return null;
          return `📡 状态: ${msg.status}`;
        }
        default:
          return null;
      }
    }

    case 'auth_status': {
      const as_ = message as { isAuthenticating: boolean; error?: string };
      if (as_.error) return `🔑 认证失败: ${truncate(as_.error, 80)}`;
      if (as_.isAuthenticating) return `🔑 认证中…`;
      return null;
    }

    case 'rate_limit_event': {
      const rle = message as { rate_limit_info: { status: string; resetsAt?: number } };
      const info = rle.rate_limit_info;
      if (info.status === 'allowed') return null;
      if (throttle('rate_limit')) return null;
      const resetsAt = info.resetsAt
        ? `，预计 ${new Date(info.resetsAt * 1000).toLocaleTimeString()} 恢复`
        : '';
      return `⚠️ 限流中${resetsAt}`;
    }

    case 'result':
      state.thinkingNotified = false;
      return null;

    default:
      return null;
  }
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  streamProgress = true,
  containerState: { initShown: boolean } = { initShown: false },
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; totalInputTokens: number; totalOutputTokens: number }> {
  const progressState = {
    thinkingNotified: false,
    lastProgressByType: new Map<string, number>(),
    sentToolProgressIds: new Set<string>(),
  };
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    // Forward progress messages to host
    const progress = formatProgress(message, progressState, streamProgress, containerState);
    if (progress) {
      writeOutput({ status: 'progress', result: progress });
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const resultMsg = message as { modelUsage?: Record<string, { inputTokens: number; outputTokens: number }> };
      if (resultMsg.modelUsage) {
        totalInputTokens += Object.values(resultMsg.modelUsage).reduce((sum, m) => sum + (m.inputTokens || 0), 0);
        totalOutputTokens += Object.values(resultMsg.modelUsage).reduce((sum, m) => sum + (m.outputTokens || 0), 0);
      }
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''} cumInputTokens=${totalInputTokens} cumOutputTokens=${totalOutputTokens}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);

  // Send a single cumulative token summary after all results are done
  if (totalInputTokens > 0) {
    writeOutput({
      status: 'progress',
      result: `📊 *Token 消耗* | Input: ${totalInputTokens.toLocaleString()} | Output: ${totalOutputTokens.toLocaleString()}`,
    });
  }

  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  const containerState = { initShown: false };
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, containerInput.streamProgress !== false, containerState);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
