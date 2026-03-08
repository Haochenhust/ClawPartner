# 飞书 Channel 系统优化 — 测试方案

> 对应方案：`.cursor/plans/飞书_channel_系统优化_5182b57d.plan.md`
> 测试时间：2026-03-08

---

## 测试环境准备

```bash
# 1. 确保服务正在运行
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 2. 实时查看日志
launchctl stdout gui/$(id -u)/com.nanoclaw 2>&1 | tail -f
# 或者如果是 dev 模式
npm run dev

# 3. 确认环境变量已配置
cat .env | grep FEISHU
```

**需要准备的飞书场景：**
- 一个与 Bot 的**私聊**会话
- 一个有 Bot 的**普通群**（自己和 Bot）
- 一个有 Bot 的**话题群**（飞书中的 "话题" 类型群）

---

## TC-01：SDK Client + 类型安全（架构基础）

**目标**：验证用 `Lark.Client` 替代手写 fetch 正常工作，Token 自动管理。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 1.1 | 重启服务，观察启动日志 | 日志中有 `Feishu long connection (WSClient) started`，无 token 相关错误 |
| 1.2 | 在私聊发送 `@Bot 你好` | Bot 正常回复，无 `401 Unauthorized` 或 `invalid token` 错误 |
| 1.3 | 让服务运行超过 2 小时后再发消息 | Token 自动刷新，Bot 仍能正常回复（无需重启） |

**验证方式**：日志中不出现 `ensureToken` / `token refresh` 等旧有手动 token 管理痕迹。

---

## TC-02：三种交互类型——私聊（p2p）

**目标**：私聊使用 group-level session，直接回复（无 reply-to 定位）。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 2.1 | 私聊发送 `你好，我是 chenhao` | Bot 直接回复到私聊，无 thread/话题嵌套 |
| 2.2 | 继续发送 `我刚才说了什么？` | Bot 记得上一句话（同一 session 连续对话） |
| 2.3 | 发送 `今天天气怎么样？` | 回复出现在私聊顶层，不创建新话题 |

**验证方式**：日志中 `interactionType: 'p2p'`，`threadRootId` 为空。

---

## TC-03：三种交互类型——普通群（group）

**目标**：普通群使用 group-level session，Bot 回复是对触发消息的 reply（quoted 引用样式）。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 3.1 | 普通群发送 `@Bot 帮我写个 Hello World` | Bot 的回复以 **quoted reply** 样式出现（引用了触发消息） |
| 3.2 | 不 @ Bot 直接发消息 | Bot 不回复（`requiresTrigger: true`） |
| 3.3 | 另一人发 `@Bot 你好` | Bot 能识别出是另一个人发的，回复中 sender_name 显示正确 |
| 3.4 | 快速连发两条 `@Bot` 消息 | Bot 只处理一次（无 race condition），回复正确定位 |

**验证方式**：飞书界面中 Bot 的消息带有引用气泡；日志中 `interactionType: 'group'`。

---

## TC-04：三种交互类型——话题群（thread_group）

**目标**：话题群每个话题独立 session，Bot 在话题内回复。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 4.1 | 话题群发一条 `@Bot 介绍一下自己` | Bot 的回复出现在**同一话题内**（reply_in_thread=true） |
| 4.2 | 在**不同话题**发 `@Bot 你刚才说了什么？` | Bot 不记得另一个话题的内容（session 隔离） |
| 4.3 | 在同一话题继续追问 | Bot 记得本话题的上下文 |
| 4.4 | 话题被删除后，Bot 尝试在该话题内回复 | Bot 优雅降级，回复发到群顶层（fallback to sendToChat） |

**验证方式**：日志中 `interactionType: 'thread_group'`，`threadRootId` 有值；飞书界面中回复在话题内。

---

## TC-05：消息去重（Deduplication）

**目标**：WebSocket 重连时，同一消息不被重复处理。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 5.1 | 发一条消息触发处理 | Bot 回复一次 |
| 5.2 | 立即重启服务（模拟 WS 重连）| Bot **不再**重复回复已处理的消息 |
| 5.3 | 等待 6 分钟后重启（超过 5min TTL） | 同一消息被重新处理（dedup TTL 已过期，属预期行为） |

**验证方式**：日志中出现 `duplicate message, skipping`；用户不会收到重复回复。

---

## TC-06：用户名解析（User Name Resolution）

**目标**：`sender_name` 显示真实姓名而非 `open_id`。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 6.1 | 在群里发 `@Bot 你好` | 日志中 `senderName` 是真实姓名（如 `陈浩`），不是 `ou_xxx` 格式 |
| 6.2 | Bot 的回复中如果引用发送者，显示的是真名 | agent 收到的消息格式为 `陈浩: @Bot 你好` |
| 6.3 | 同一用户连续发 5 条消息 | 不会重复请求 contact API（只有第一次请求，后续命中缓存） |
| 6.4 | 等待 1 小时后再发消息 | 缓存过期，重新请求 contact API（正常） |

**验证方式**：日志中 `senderName` 字段值；contact API 调用次数（看日志中 getUserInfo 出现频率）。

**潜在问题**：如果 Bot 没有 `contact:user.base:readonly` 权限，`getUserInfo` 会失败，fallback 到 `open_id`——需确认飞书应用权限配置。

---

## TC-07：表情 Reaction 确认（Hourglass）

**目标**：收到消息加 ⏳ 沙漏表情，处理完成后移除。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 7.1 | 发送 `@Bot 请做一个复杂任务（耗时较长）` | 消息上立即出现 ⏳ 表情 |
| 7.2 | 等待 Bot 完成回复 | ⏳ 表情消失 |
| 7.3 | Bot 处理过程中服务崩溃重启 | 消息的 ⏳ 表情可能残留（可接受，属边界情况） |

**验证方式**：飞书界面中消息旁边的表情变化。

---

## TC-08：多消息类型接收

**目标**：支持 text/post/image/file/audio/video/sticker，不再丢弃非文本消息。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 8.1 | 发送一张图片（不 @Bot） | Bot 不处理（未触发） |
| 8.2 | 发送图片并 @Bot | agent 收到 `[图片]` 占位符，Bot 能基于此回复 |
| 8.3 | 发送一个文件并 @Bot | agent 收到 `[文件: 文件名.pdf]` 占位符 |
| 8.4 | 发送语音消息并 @Bot | agent 收到 `[语音消息 X秒]` 占位符 |
| 8.5 | 发送视频并 @Bot | agent 收到 `[视频 X秒]` 占位符 |
| 8.6 | 发送表情包（sticker）并 @Bot | agent 收到 `[表情包]` 占位符 |
| 8.7 | 发送富文本（post）消息并 @Bot | 加粗、链接、代码块等格式被正确转为 Markdown |

**验证方式**：日志中 `msgType` 字段；agent 的处理结果是否基于正确的消息内容。

**关键验证点**：旧代码中 `if (!text) return` 会直接丢弃——新代码对空 text 有占位符 fallback，所有消息类型都能进入处理流程。

---

## TC-09：流式卡片（Cardkit API）

**目标**：回复使用 Cardkit 流式打字机效果，带可折叠的 Thinking 面板。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 9.1 | 发送一个需要较长思考的问题 | 飞书中出现一张卡片，内容逐渐显示（打字机效果） |
| 9.2 | 卡片上方有 `💭 思考中...` 折叠面板 | 点击可展开查看思考过程 |
| 9.3 | 最终回复完成后 | 流式模式关闭（streaming indicator 消失） |
| 9.4 | Cardkit API 不可用时（模拟故障） | 降级为普通 PATCH 卡片，回复仍能发出 |

**验证方式**：飞书界面中卡片的视觉效果；日志中 `Cardkit creation failed, falling back` 在降级时出现。

**潜在问题**：
- `cardkit.v1.card.create` 和 `cardkit.v1.cardElement.content` 是较新的 API，需确认飞书应用已开通 Cardkit 权限
- `sequence` 单调递增逻辑：每次 update 步进 2（progress + result），需验证并发更新不会乱序

---

## TC-10：Markdown 转 lark_md 格式

**目标**：agent 输出的 Markdown 被正确转换为飞书 lark_md 格式渲染。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 10.1 | 让 Bot 输出带 `**加粗**` 的回复 | 飞书中显示加粗（`*加粗*` 格式） |
| 10.2 | 让 Bot 输出带 `[链接](https://...)` 的回复 | 飞书中显示可点击链接（`<url\|text>` 格式） |
| 10.3 | 让 Bot 输出带 `## 标题` 的回复 | 标题被转为加粗（`*标题*`，lark 不支持 heading） |
| 10.4 | 让 Bot 输出代码块 | 代码块正常显示 |

---

## TC-11：全局记忆体系（Global Memory）

**目标**：SOUL.md 和 USER.md 对所有群/私聊共享，跨群记忆一致。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 11.1 | 检查 `data/global-memory/` 目录 | 存在 `SOUL.md`、`USER.md`、`knowledge/`、`episodes/` |
| 11.2 | 在私聊告诉 Bot 一个关于自己的信息（如 `我喜欢用 Go 语言`） | Bot 将其记录到 `USER.md` 或 `knowledge/` |
| 11.3 | 在另一个群的容器启动时，检查 `/workspace/memory` 挂载 | Bot 能读取私聊中学到的信息 |
| 11.4 | 在群 A 告诉 Bot 一个 `[隐私: pending]` 信息 | 在群 B 中 Bot 不直接引用，而是先询问主人是否授权 |

**验证方式**：检查 `data/global-memory/` 文件内容；容器日志中 `/workspace/memory` 挂载确认。

---

## TC-12：全局 Skill（Global Skills）

**目标**：在任意群创建的 Skill 自动对所有场景可用。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 12.1 | 检查 `data/global-skills/` | 存在 `agent-browser/` 等内置 skill |
| 12.2 | 在私聊中让 Bot 创建一个自定义 skill | 容器退出后，`data/global-skills/` 中出现新 skill |
| 12.3 | 在另一个群启动容器，检查其 `~/.claude/skills/` | 包含上一步创建的 skill |
| 12.4 | 在群 B 使用该 skill | Skill 正常工作 |

**验证方式**：`data/global-skills/` 目录变化；日志中 `New skill promoted to global-skills`。

---

## TC-13：聊天记录主动存储

**目标**：每条消息被追加写入 `groups/{group}/conversations/YYYY-MM-DD.md`。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 13.1 | 在群里发几条消息并 @Bot | `groups/{folder}/conversations/2026-03-08.md` 文件被创建/更新 |
| 13.2 | 打开该文件 | 格式为 `[HH:MM] 姓名: 消息内容` |
| 13.3 | 第二天发消息 | 创建新的 `2026-03-09.md` 文件 |

**验证方式**：直接查看文件系统。

---

## TC-14：定时任务回复路由

**目标**：定时任务在哪里触发就在哪里回复（私聊触发→私聊，群触发→群顶层）。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 14.1 | 在私聊中设置一个 30 秒后执行的定时任务 | 30 秒后，回复出现在私聊 |
| 14.2 | 在普通群中设置一个 30 秒后执行的定时任务 | 30 秒后，回复出现在**群顶层**（不进任何 thread） |
| 14.3 | 在话题群中设置定时任务 | 回复出现在话题群顶层（自动成为新话题） |

**验证方式**：飞书界面观察回复位置；这由 `task.chat_jid` 决定，`sendMessage` 不传 `replyToMessageId`，自然发到顶层。

---

## TC-15：syncGroups

**目标**：能获取 Bot 所在的所有群聊列表及名称。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 15.1 | 服务启动后，检查数据库中的 chat 记录 | Bot 所在的群聊被正确同步（包含名称） |
| 15.2 | Bot 加入一个新群后，触发 syncGroups | 新群出现在列表中 |

---

## TC-16：回复路由——无 Race Condition

**目标**：验证闭包绑定回复路由，并发消息不会导致回复发错位置。

| # | 测试步骤 | 期望结果 |
|---|---------|---------|
| 16.1 | 在普通群快速发两条 `@Bot` 消息（间隔 < 1秒） | 每条回复正确 reply 到各自的触发消息 |
| 16.2 | 两个不同用户同时 @Bot | 两个回复都正确定位，不混淆 |

**验证方式**：飞书界面中 reply 的引用气泡是否指向正确的触发消息。

---

## 已知潜在问题 / 待验证点

### 问题 1：thread_group 判断逻辑差异
- **代码实现**：`resolveInteractionType` 使用 `message.root_id` 判断是否为话题群
- **设计方案**：方案中提到使用 `message.thread_id` 字段
- **风险**：`root_id` 在普通群的**回复消息**中也会有值（被引用的消息），可能误判为 `thread_group`
- **测试**：在普通群里回复一条已有消息（引用），观察 `interactionType` 是否被误判为 `thread_group`

### 问题 2：进度消息回复位置
- **现象**：`sendMessageGetId` 在 progress 事件中被调用，但用的是 `channel.sendMessageGetId(chatJid, text)`，不带 reply 上下文
- **风险**：在普通群场景中，进度卡片会发到群顶层，而不是 reply 到触发消息
- **影响**：流式打字机卡片的初始位置可能不正确（在 `group` 类型中不是 quoted reply）

### 问题 3：Cardkit API 权限
- 需要确认飞书应用开通了 `cardkit` 相关 API 权限，否则每次都会 fallback 到普通 PATCH

### 问题 4：contact API 权限
- 用户名解析需要 `contact:user.base:readonly` 权限，如未开通则 fallback 到 `open_id`

---

## 快速冒烟测试清单

最小化验证核心功能是否正常，适合每次发版后快速跑一遍：

- [ ] 服务启动无报错，日志出现 `Feishu long connection (WSClient) started`
- [ ] 私聊发 `@Bot 你好` → 收到回复
- [ ] 普通群发 `@Bot 你好` → 收到带引用气泡的回复
- [ ] 回复消息上有 ⏳ 表情，回复完成后消失
- [ ] 发送者显示真实姓名（非 `ou_xxx`）
- [ ] 回复内容在卡片中正确显示（Markdown 渲染）
- [ ] `data/global-memory/` 目录存在且包含 `SOUL.md`、`USER.md`
- [ ] `data/global-skills/` 目录包含内置 skill（如 `agent-browser`）
- [ ] 群聊消息被写入 `groups/{folder}/conversations/`

---

## 日志过滤命令参考

```bash
# 查看飞书相关日志
journalctl --user -u nanoclaw -f | grep -i feishu

# 查看 interactionType 分布
journalctl --user -u nanoclaw | grep "interactionType"

# 查看 reaction 操作
journalctl --user -u nanoclaw | grep -E "addReaction|removeReaction"

# 查看 Cardkit 操作
journalctl --user -u nanoclaw | grep -i cardkit

# 查看用户名解析
journalctl --user -u nanoclaw | grep "getUserInfo\|senderName"

# 查看 skill 同步
journalctl --user -u nanoclaw | grep "global-skills\|promoted to global"
```
