---
name: 飞书 Channel 系统优化
overview: 系统性重构飞书 Channel，目标是让飞书 Bot 像一个真实的同事——支持私聊、普通群、话题群三种交互类型，补齐图片/文件/富文本/表情/用户名等能力，重新设计 context 管理和回复路由，并建立以主人为中心、带隐私控制的统一记忆体系。
todos:
  - id: sdk-client-types
    content: 用 Lark.Client 替代手写 fetch，创建 feishu-types.ts 类型定义，抽取 API 辅助函数（sender.ts / receiver.ts）
    status: completed
  - id: context-redesign
    content: 三种交互类型的 context 和回复路由：私聊（group-level session）、普通群（group-level + reply 到触发消息）、话题群（自动新建话题 + 话题内回复）
    status: completed
  - id: memory-system
    content: 以主人为中心的记忆体系：Bot 人格(SOUL) + 主人画像(USER) 全局统一；per-group 聊天记录 + 自动总结；跨群知识带隐私标记（需主人确认才可跨群使用）
    status: completed
  - id: global-skills
    content: Skill 作用域改为全局：在任何群/私聊中创建的 skill 自动对所有场景可用，统一存储在 data/global-skills/
    status: completed
  - id: multi-msg-receive
    content: 重构 handleInboundEvent：支持 text/post/image/file/audio/video，附件下载，引用消息解析，消息去重
    status: completed
  - id: user-name-resolve
    content: 通过 contact API 获取用户真实姓名，LRU 缓存，sender_name 显示真名
    status: completed
  - id: reaction-confirm
    content: 收到消息加 HOURGLASS 表情确认，处理完成后移除；Channel 接口增加 addReaction/removeReaction
    status: completed
  - id: streaming-card
    content: 升级为 Cardkit API（JSON 2.0 schema），支持真正的流式打字机效果和 Thinking 折叠面板
    status: completed
  - id: rich-send
    content: 增强发送能力：图片上传发送、富文本(post)、Markdown 到 lark_md 转换优化
    status: completed
  - id: sync-groups
    content: 实现 syncGroups 方法，获取 bot 所在群聊列表及名称
    status: completed
isProject: false
---

# 飞书 Channel 系统优化方案

## 设计目标

Bot 是**主人（chenhao）的个人助手**，完全听命于主人。虽然它会被引入各种群组，但它的忠诚对象始终是主人一个人。

- 支持**三种交互类型**：私聊、普通群、话题群
- 群里**多人**可以同时和他交互，他能分清谁在问什么
- 发图片、文件他能看到，不会无视非文本消息
- **定时任务在哪里触发就在哪里回复**（私聊触发→私聊回复，群聊触发→群聊回复）
- 收到消息有反馈（表情确认），回复时精准定位到触发消息
- **以主人为中心的统一记忆**——Bot 有一个完整的"自我"和对主人的认知，跨群组保持一致
- **跨群知识有隐私控制**——在群 A 获得的信息，需要主人确认后才能在群 B 使用
- **Skill 全局通用**——在任何场景中创建的 skill，自动对所有场景可用

## 现状问题

当前 `[src/channels/feishu.ts](src/channels/feishu.ts)` 存在三类问题：

**架构问题：**

- 所有 API 调用手写 `fetch`，没有封装，channel 逻辑和 HTTP 细节混在一起
- 类型定义用 `Record<string, unknown>` 强转，无类型安全
- Token 管理内嵌在 channel 类中，无法复用
- `activeThread` 是全局可变 Map，存在 race condition

**功能缺失：**

- 仅支持纯文本，收到图片/文件/富文本/音视频直接丢弃（`if (!text) return`）
- `sender_name` 用 `open_id`（一串 ID），不是真实姓名
- 不支持表情回复（Reaction）、typing indicator、syncGroups
- 发送只能发纯文本或简单卡片，不能发图片/文件

**Context 与记忆问题（最严重）：**

- 每条新消息都创建新 thread → 新 Claude session → agent 失忆
- 定时任务不知道发到哪个 thread（取决于最后一条用户消息的位置）
- `activeThread` 全局 Map 在并发消息时会被覆盖，回复可能发错位置
- 记忆完全按 group 隔离——SOUL.md 和 USER.md 只存在 feishu_main 的 session 中，新 group 没有
- 聊天记录只在 `PreCompact` hook 时才归档，没有主动的记录存储和总结机制
- Skill 按 group 隔离——在一个群里创建的 skill 不会自动传播到其他群
- 没有跨群知识的隐私控制机制

## 市面调研


| 项目                                                  | 特点                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **[NeoClaw](https://github.com/amszuidas/neoclaw)** | Gateway 架构，闭包绑定回复目标，Cardkit 流式卡片，附件下载，消息去重，Thinking 面板，三层记忆系统（identity/knowledge/episodes） |
| **clawdbot-feishu** (4k stars)                      | 图片上传下载、文件下载、消息编辑/撤回、Reaction、富文本、引用回复                                                      |
| **cc-connect** (460 stars)                          | 图片多模态、语音转写、表情确认、定时任务、群聊隔离                                                                  |


**NeoClaw 的关键参考价值：**

- **Context 隔离**：普通群聊用 `chatId` 作为 conversation key（一个群一个 session），话题群才按 thread 隔离
- **回复路由**：收到消息时创建绑定了回复目标的闭包（`ReplyFn`），而非全局 Map，从根本上消除 race condition
- **SDK Client**：用 `@larksuiteoapi/node-sdk` 的 `Lark.Client` 替代手写 fetch，SDK 自带 token 管理
- **Cardkit API**：JSON 2.0 schema，`streaming_mode: true`，逐元素更新实现打字机效果
- **三层记忆**：identity（身份）、knowledge（按主题的持久化知识）、episodes（会话摘要），支持 FTS5 全文搜索
- **消息去重**：持久化 dedup 缓存，防止 WebSocket 重连时重复处理
- **附件下载**：通过 `im.messageResource.get` 下载图片/文件为 Buffer，传给 agent

---

## 核心设计一：三种交互类型

### 1. 私聊

- **Context**：你和 Bot 之间所有对话历史，一个连续的 session
- **回复方式**：直接回复（私聊没有 thread 概念）
- **定时任务**：在私聊中触发的定时任务，结果也发回私聊
- **注册方式**：`feishu:ou_xxx`（open_id 作为 JID），`requiresTrigger: false`

### 2. 普通群

- **Context**：群里所有人的所有消息，一个 group-level session
- **回复方式**：reply 到触发消息（飞书自动创建 thread，回复归入该 thread 下）
- **定时任务**：在群里触发的定时任务，结果发到群聊顶层（不进任何 thread）
- **触发方式**：群里需要 @Bot 触发（`requiresTrigger: true`）

### 3. 话题群

- **Context**：每个话题（thread）是一个独立的 context，用 `chatId_thread_threadRootId` 作为 conversation key
- **回复方式**：用户发一条消息 → Bot 自动新建一个话题 → 后续回复都在这个话题内
- **定时任务**：结果发到话题群顶层（自动成为一个新话题）
- **识别方式**：飞书话题群的消息会携带 `message.thread_id` 字段（普通群不会有）

### 判断逻辑

```typescript
function resolveInteractionType(msg: ParsedMessage): 'p2p' | 'group' | 'thread_group' {
  if (msg.chatType === 'p2p') return 'p2p';
  if (msg.threadRootId) return 'thread_group';  // 话题群消息带 thread_id
  return 'group';
}
```

### 回复路由（闭包绑定）

**关键改变**：回复目标不再是全局 `activeThread` Map，而是 per-invocation 的闭包。

```typescript
// processGroupMessages 被调用时，根据交互类型创建 reply 闭包
function createReplyFn(channel, chatJid, interactionType, triggerMessageId?) {
  switch (interactionType) {
    case 'p2p':
      // 私聊：直接发到会话
      return (text) => channel.sendToChat(chatJid, text);

    case 'group':
      // 普通群：reply 到触发消息（飞书自动归入 thread）
      return (text) => triggerMessageId
        ? channel.replyToMessage(triggerMessageId, chatJid, text)
        : channel.sendToChat(chatJid, text);

    case 'thread_group':
      // 话题群：在话题内回复
      return (text) => channel.replyInThread(triggerMessageId, chatJid, text);
  }
}
```

定时任务的回复：


| 触发场景        | 回复位置             |
| ----------- | ---------------- |
| 私聊中创建的定时任务  | 发回私聊             |
| 普通群中创建的定时任务 | 发到群聊顶层           |
| 话题群中创建的定时任务 | 发到话题群顶层（自动成为新话题） |


这由 `task.chat_jid` 天然决定——任务记录了创建时的 `chat_jid`，执行时 `sendMessage(task.chat_jid, text)` 不传 `replyToMessageId`，自然发到对应会话的顶层。

### Session 管理


| 交互类型 | Session Key                              | 说明             |
| ---- | ---------------------------------------- | -------------- |
| 私聊   | `sessions[group.folder]`                 | 一个私聊一个 session |
| 普通群  | `sessions[group.folder]`                 | 一个群一个 session  |
| 话题群  | `thread_sessions[chatJid, threadRootId]` | 每个话题独立 session |


普通群**不再**使用 `thread_sessions`。只有话题群才按 thread 隔离 session。

---

## 核心设计二：记忆体系（重中之重）

### 核心原则

Bot（石原里美）是主人（chenhao）的**个人助手**，完全听命于主人。它有：

- **一个统一的人格**（SOUL.md）——无论在哪个群，它都是同一个"人"
- **一份对主人的认知**（USER.md）——对主人的了解是全局的、持续积累的
- **跨群的知识积累**——但受**隐私控制**，需要主人授权才能跨群使用

### 现状问题

当前的记忆系统：

```
data/sessions/{group}/.claude/          # per-group，容器内挂载为 ~/.claude/
├── memory/SOUL.md                      # 身份（石原里美人设）
├── memory/USER.md                      # 用户画像
├── rules/                              # 行为规则
└── skills/                             # 技能

groups/{group}/                         # per-group，容器内挂载为 /workspace/group/
├── conversations/                      # 聊天记录归档（PreCompact hook 触发）
└── CLAUDE.md                           # 工作区说明

groups/global/CLAUDE.md                 # 全局说明（只读挂载给非 main 群）
```

**问题**：

- SOUL.md 和 USER.md 只存在 `data/sessions/feishu_main/.claude/memory/` 中，新 group 的 Bot 不认识主人
- Skill 按 group 隔离（`data/sessions/{group}/.claude/skills/`），在一个群创建的 skill 其他群用不了
- 聊天记录只在 `PreCompact` hook 时归档，不够主动
- 没有跨群知识的隐私控制机制

### 设计：三层记忆架构

```
data/global-memory/                     # 第一层：Bot 的"自我"（全局统一）
├── SOUL.md                             # 人格（石原里美的身份、原则、能力）
├── USER.md                             # 对主人的认知（chenhao 的偏好、背景、习惯）
├── knowledge/                          # 跨群知识（带隐私标记）
│   ├── tech-stack.md
│   └── people.md
└── episodes/                           # 各群的重要事件摘要
    └── 2026-03-08-feishu-main.md

data/global-skills/                     # 第二层：全局 Skill（任何场景创建，全局可用）
├── agent-browser/SKILL.md
├── feishu-cli-*/SKILL.md
└── my-custom-skill/SKILL.md

groups/{group}/                         # 第三层：per-group 记忆（聊天记录 + 工作区）
├── conversations/                      # 该群的聊天记录
│   ├── 2026-03-08.md
│   └── summaries/2026-03-07-summary.md
├── CLAUDE.md                           # 群专属工作区说明
└── workspace/                          # 群专属工作文件
```

#### 第一层：Bot 的"自我"（`data/global-memory/`）

所有群/私聊共享，是 Bot 作为一个"人"的核心记忆。


| 文件               | 作用               | 说明                    |
| ---------------- | ---------------- | --------------------- |
| `SOUL.md`        | Bot 的人格、原则、能力、教训 | 所有场景共享，Bot 的"灵魂"      |
| `USER.md`        | 对主人的认知：偏好、背景、习惯  | 所有场景共享，Bot 对主人的印象     |
| `knowledge/*.md` | 跨群积累的知识          | **带隐私标记**，需主人授权才可跨群使用 |
| `episodes/*.md`  | 各群的事件摘要          | 所有场景可读写               |


**隐私控制机制（关键设计）**：

`knowledge/` 中的知识条目必须带隐私标记：

```markdown
# Tech Stack

**Go**: chenhao 的主力后端语言 [来源: 私聊] [隐私: public]
**项目 X 的架构方案**: 使用微服务... [来源: project-x 群] [隐私: pending]
**公司内部 API 密钥规范**: ... [来源: infra 群] [隐私: private]
```

三种隐私级别：

- `**public**`：主人已确认可以跨群使用。Bot 可以在任何场景引用。
- `**pending**`（默认）：尚未确认。Bot 在其他群需要使用时，必须**先通过私聊问主人**："我在 project-x 群了解到 XX 信息，可以在当前场景使用吗？"得到确认后改为 `public`。
- `**private`**：主人明确表示不可跨群使用。Bot 绝对不能在其他场景提及，即使被直接问到也要回避。

**写入 CLAUDE.md 的隐私规则**：

```
## 跨群知识隐私规则（必须严格遵守）

你在不同群组中获得的信息，写入 knowledge/ 时默认标记为 [隐私: pending]。
- public: 主人已确认，可以在任何场景使用
- pending: 需要先问主人确认。通过 send_message 私聊主人询问，得到明确许可后改为 public
- private: 主人明确禁止，绝对不能在其他场景提及

引用知识前，必须检查隐私标记。违反隐私规则是最严重的错误。
```

**容器挂载**：


| 主机路径                  | 容器路径                | 权限  |
| --------------------- | ------------------- | --- |
| `data/global-memory/` | `/workspace/memory` | 可写  |


#### 第二层：全局 Skill（`data/global-skills/`）

**当前问题**：Skill 存储在 `data/sessions/{group}/.claude/skills/`，按 group 隔离。在群 A 创建的 skill，群 B 用不了。

**改为**：所有 skill 统一存储在 `data/global-skills/`，对所有场景可用。

**当前 skill 同步机制**（`[src/container-runner.ts](src/container-runner.ts)` 第 146-156 行）：

```typescript
// 当前：从 container/skills/ 复制到 per-group 的 .claude/skills/
const skillsSrc = path.join(process.cwd(), 'container', 'skills');
const skillsDst = path.join(groupSessionsDir, 'skills');
```

**改造为**：

```typescript
// 新：从 data/global-skills/ 同步到 per-group 的 .claude/skills/
// 1. 启动时：container/skills/（内置）→ data/global-skills/（如果不存在）
// 2. 每次容器启动：data/global-skills/ → data/sessions/{group}/.claude/skills/
```

**新 skill 的全局传播**：

Agent 在容器内创建新 skill 时，写入 `~/.claude/skills/`（即 per-group）。容器结束后，主进程扫描 per-group skills，将新增的 skill 同步回 `data/global-skills/`。下次任何 group 的容器启动时自动获得。

同步流程：

1. 容器启动前：`data/global-skills/` → `data/sessions/{group}/.claude/skills/`
2. 容器运行中：agent 创建新 skill → 写入 `~/.claude/skills/`
3. 容器结束后：主进程扫描 per-group skills，新增的同步回 `data/global-skills/`

#### 第三层：per-group 聊天记录

每个 group 维护自己的聊天记录，存储在 `groups/{group}/conversations/`。

**形式一：原始记录存储**

主进程在消息处理后，将格式化的聊天记录追加写入文件：

```
groups/{group}/conversations/
├── 2026-03-08.md          # 按日期分文件
├── 2026-03-07.md
└── ...
```

文件内容示例：

```markdown
## 2026-03-08

[10:00] 张三: @Andy 帮我查一下昨天的部署日志
[10:01] Andy: 好的，我来查...
[10:05] 李四: @Andy 这个 PR 能帮我 review 吗？
[10:06] Andy: 可以，我看看...
```

**形式二：自动总结归纳**

当聊天记录过长时，由 agent 在 session 结束时自动生成总结，同时将重要知识提取到 `data/global-memory/knowledge/`（带隐私标记）。

### 记忆的完整生命周期

```
用户在群 A 发消息
  → 主进程追加写入 groups/group-a/conversations/2026-03-08.md
  → Agent 处理消息
  → Agent 学到重要信息
    → 写入 /workspace/memory/knowledge/xxx.md [来源: group-a] [隐私: pending]
  → Session 结束
    → 更新 /workspace/memory/SOUL.md（如果人格有变化）
    → 更新 /workspace/memory/USER.md（如果对主人有新认知）
    → 生成事件摘要 → /workspace/memory/episodes/2026-03-08-group-a.md
    → 主进程扫描新 skill → 同步到 data/global-skills/

用户在群 B 发消息
  → Agent 启动，加载 /workspace/memory/（SOUL.md、USER.md、knowledge/）
  → Agent 需要引用群 A 的知识
    → 检查隐私标记
    → pending → 通过 send_message 私聊主人："我在群 A 了解到 XX，可以在这里用吗？"
    → public → 直接使用，说明"我记得你之前在群 A 提到过..."
    → private → 不提及，回避
```

### 迁移路径

1. 创建 `data/global-memory/`，将 `data/sessions/feishu_main/.claude/memory/SOUL.md` 和 `USER.md` 迁移过去
2. per-group 的 `.claude/memory/SOUL.md` 和 `USER.md` 改为符号链接指向全局
3. 创建 `data/global-skills/`，将 `container/skills/` 和现有 per-group skills 合并过去
4. 修改 `[src/container-runner.ts](src/container-runner.ts)`：新增 global-memory 挂载 + 改造 skill 同步逻辑
5. 更新 CLAUDE.md 模板：记忆目录结构 + 隐私规则 + session-end 总结协议

---

## 现状问题总结与改动对照


| 问题                                 | 改动                                       |
| ---------------------------------- | ---------------------------------------- |
| 手写 fetch，无类型安全                     | 用 Lark.Client + feishu-types.ts          |
| activeThread 全局 Map，race condition | 闭包绑定回复目标                                 |
| 每条消息新建 thread/session，agent 失忆     | 三种交互类型分别处理 context                       |
| 定时任务发到随机 thread                    | 定时任务发到触发会话的顶层                            |
| 只支持纯文本                             | 支持所有消息类型 + 附件下载                          |
| sender_name 是 open_id              | 用户名解析 + 缓存                               |
| 无消息确认反馈                            | Reaction 表情确认                            |
| 简单卡片 PATCH                         | Cardkit API 流式卡片                         |
| SOUL/USER 只在 feishu_main，新群不认识主人   | 全局统一 SOUL.md + USER.md                   |
| 跨群知识无隐私控制                          | knowledge/ 带隐私标记（public/pending/private） |
| Skill 按 group 隔离                   | 全局 Skill（data/global-skills/）            |
| 聊天记录只在 PreCompact 时归档              | 主动的聊天记录存储 + 自动总结                         |


---

## 实施步骤

### 第一步：SDK Client + 类型定义 + API 辅助函数

**用 `Lark.Client` 替代手写 fetch**（参考 NeoClaw 的 `client.ts`）：

- SDK 自带 token 管理（`tenant_access_token` 自动获取和刷新）
- 删除当前 `ensureToken()` 手动管理逻辑
- 所有 API 调用通过 `Lark.Client` 的语义化方法

**新建 `[src/channels/feishu-types.ts](src/channels/feishu-types.ts)`**：飞书事件、消息的完整 TypeScript 类型，替代 `Record<string, unknown>` 强转。参考 NeoClaw 的 `client.ts` 中的 `RawMessageEvent` 类型。

**新建 `[src/channels/feishu-sender.ts](src/channels/feishu-sender.ts)`**：发送相关辅助函数（sendCard、sendMarkdown、addReaction、removeReaction、updateCardText 等）。

**新建 `[src/channels/feishu-receiver.ts](src/channels/feishu-receiver.ts)`**：接收相关辅助函数（parseMessage、extractText、extractRichText、fetchAttachments、消息去重等）。

### 第二步：三种交互类型的 Context + 回复路由

**修改 `[src/channels/feishu.ts](src/channels/feishu.ts)`**：

- 删除 `activeThread` Map 和 `ThreadState` 接口
- 新增 `replyToMessage(messageId, chatJid, text)`、`replyInThread(messageId, chatJid, text)` 和 `sendToChat(chatJid, text)` 方法
- `sendMessage` 改为根据传入的 `replyContext` 参数决定回复方式

**修改 `[src/index.ts](src/index.ts)`**：

- `processGroupMessages` 中根据交互类型（p2p / group / thread_group）分别处理
- 普通群和私聊：context 用 group-level 的所有消息，session 用 `sessions[group.folder]`
- 话题群：context 用 thread 内的消息，session 用 `thread_sessions`
- 在调用 agent 前创建 reply 闭包，传入 channel 方法

`**[src/task-scheduler.ts](src/task-scheduler.ts)**`：无需改动——`sendMessage(task.chat_jid, text)` 不传 `replyToMessageId`，自然发到对应会话顶层。

### 第三步：记忆体系 + Skill 全局化（重中之重）

**新建 `data/global-memory/` 和 `data/global-skills/`**。

**修改 `[src/container-runner.ts](src/container-runner.ts)`**：

- `buildVolumeMounts()` 新增 `data/global-memory/` → `/workspace/memory` 挂载
- Skill 同步逻辑改为从 `data/global-skills/` 同步到 per-group
- 容器结束后新增 skill 回同步逻辑（per-group 新增 skill → global-skills）

**更新 CLAUDE.md 模板**：

- 记忆目录结构说明
- 隐私规则（public/pending/private）
- Session-end 总结协议

**聊天记录主动存储**：

- 在 `processGroupMessages` 中追加写入 `groups/{group}/conversations/{date}.md`

### 第四步：多消息类型接收

**重构 `handleInboundEvent`**（在 `feishu-receiver.ts` 中实现 `parseMessage`）：

- **text**：直接提取
- **post（富文本）**：递归解析为 Markdown，保留加粗/斜体/链接/代码块（参考 NeoClaw 的 `extractRichText`）
- **image**：提取 `image_key`，通过 `im.messageResource.get` 下载为 Buffer，保存到 group 工作目录，路径传给 agent
- **file**：提取 `file_key`，下载并保存
- **audio/video/sticker**：占位符 `[语音消息]` / `[视频]` 等
- **引用消息**：通过 `parent_id` 获取被引用消息内容，拼接到 text 前面：`[回复: "原文内容"]\n\n新消息`

**消息去重**：实现 `markSeen(messageId)` 机制（参考 NeoClaw），内存 Map + TTL，防止 WebSocket 重连时重复处理。

**修改 `[src/types.ts](src/types.ts)`**：`NewMessage` 增加 `attachments?: Attachment[]` 字段。

### 第五步：用户名解析

- 通过 `Lark.Client` 的 contact API 获取用户真实姓名
- 内存 LRU 缓存（Map + TTL 1 小时），避免重复请求
- `sender_name` 从 `open_id` 改为真实姓名
- 群聊中 agent 看到的消息格式：`张三: @Andy 帮我查一下日志`

### 第六步：表情 Reaction 确认

- 收到消息后自动添加 `HOURGLASS`（沙漏）表情，表示正在处理
- 处理完成后移除沙漏表情
- `Channel` 接口新增可选方法：`addReaction?(messageId, emoji): Promise<string | null>` 和 `removeReaction?(messageId, reactionId): Promise<void>`

### 第七步：流式卡片升级（Cardkit API）

升级为飞书 Cardkit API（JSON 2.0 schema）：

- `streaming_mode: true` + `cardkit.v1.cardElement.content` 逐步更新，实现真正的打字机效果
- Thinking 内容放在可折叠的 `collapsible_panel` 中
- 通过 `cardkit.v1.card.create` 创建卡片实体，获取 `card_id`，然后通过引用发送
- 处理完成后 `closeCardStreaming` 关闭流式模式

### 第八步：增强发送能力

- **图片发送**：`POST /im/v1/images` 上传获取 `image_key`，再发送 image 类型消息
- **富文本 (post) 发送**：支持带链接、图片、代码块的消息
- **Markdown 到 lark_md 转换优化**

### 第九步：syncGroups

实现 `syncGroups` 方法，调用 `GET /im/v1/chats` 获取 bot 所在的所有群聊列表及名称。

---

## 文件变更清单


| 操作  | 文件                                | 说明                                                                |
| --- | --------------------------------- | ----------------------------------------------------------------- |
| 新建  | `src/channels/feishu-types.ts`    | 飞书事件/消息完整类型定义                                                     |
| 新建  | `src/channels/feishu-sender.ts`   | 发送辅助：卡片构建、Reaction、流式更新                                           |
| 新建  | `src/channels/feishu-receiver.ts` | 接收辅助：消息解析、富文本提取、附件下载、去重                                           |
| 新建  | `data/global-memory/`             | Bot 的全局记忆（SOUL.md、USER.md、knowledge/、episodes/）                   |
| 新建  | `data/global-skills/`             | 全局 Skill 目录                                                       |
| 重构  | `src/channels/feishu.ts`          | Channel 主逻辑，三种交互类型                                                |
| 修改  | `src/types.ts`                    | Channel 接口增加 addReaction/removeReaction；NewMessage 增加 attachments |
| 修改  | `src/index.ts`                    | context/session/reply 闭包；聊天记录主动存储                                 |
| 修改  | `src/container-runner.ts`         | global-memory 挂载 + global-skills 同步 + skill 回同步                   |
| 修改  | CLAUDE.md 模板                      | 记忆目录 + 隐私规则 + session-end 协议                                      |
| 不变  | `src/task-scheduler.ts`           | sendMessage 自然发到触发会话顶层                                            |
| 不变  | `src/db.ts`                       | thread_sessions 表保留，仅话题群使用                                        |


## 实施优先级

按依赖关系和影响力排序：

1. **SDK Client + 类型定义 + API 辅助函数**（架构基础）
2. **三种交互类型的 Context + 回复路由**（解决 thread 混乱）
3. **记忆体系 + Skill 全局化**（全局 SOUL/USER + 隐私控制 + 全局 Skill + 聊天记录）
4. **多消息类型接收 + 附件下载 + 去重**（功能缺口）
5. **用户名解析**（体验改善）
6. **表情 Reaction 确认**（用户反馈）
7. **流式卡片升级**（输出体验）
8. **增强发送能力**（agent 输出）
9. **syncGroups**（运维便利）

