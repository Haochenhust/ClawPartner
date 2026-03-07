---
name: feishu_main context structure
overview: 在 data/sessions/feishu_main/.claude/ 下集中建立完整的两层上下文结构（CLAUDE.md + rules/ + memory/ + agents/），精简项目级 CLAUDE.md，确保 Agent 知道在 ~/.claude/ 下自主更新记忆。
todos:
  - id: create-claude-md
    content: 创建 data/sessions/feishu_main/.claude/CLAUDE.md 占位文件（含目录结构说明和更新协议）
    status: completed
  - id: create-rules-dir
    content: 创建 data/sessions/feishu_main/.claude/rules/ 目录
    status: completed
  - id: create-memory-dir
    content: 创建 data/sessions/feishu_main/.claude/memory/ 目录（SOUL.md + USER.md）
    status: completed
  - id: create-agents-dir
    content: 创建 data/sessions/feishu_main/.claude/agents/ 目录
    status: completed
  - id: slim-project-claude-md
    content: 精简 groups/feishu_main/CLAUDE.md，只保留 group 基本信息
    status: completed
  - id: verify-structure
    content: 验证完整目录结构，确认容器内加载正确
    status: completed
isProject: false
---

# feishu_main 两层上下文 — 集中式结构

## 设计原则

所有上下文集中在 `data/sessions/feishu_main/.claude/`（容器内 `~/.claude/`），方便统一审查和管理。Agent 通过 CLAUDE.md 中的更新协议知道在 `~/.claude/` 下自主维护记忆。

## 最终目录结构

```
data/sessions/feishu_main/.claude/         # → /home/node/.claude/ (容器内 ~/.claude/)
├── CLAUDE.md              # Layer 1: 操作手册 + 更新协议（自动加载）
├── rules/                 # Layer 1: 行为规则（自动加载）
│   └── .gitkeep
├── memory/                # 动态记忆（CLAUDE.md 中指示 Agent 读写）
│   ├── SOUL.md            # Agent 身份、原则、能力
│   └── USER.md            # 用户偏好、上下文、历史
├── skills/                # Layer 2: 能力模块（已存在，自动同步 + 可追加）
│   └── agent-browser/     # 已存在
├── agents/                # Layer 2: 自定义 Subagent
│   └── .gitkeep
└── settings.json          # 已存在，无需改动

groups/feishu_main/                        # → /workspace/group/ (容器 cwd)
├── CLAUDE.md              # 精简为仅 group 基本信息
└── conversations/         # 对话历史（已有机制）

groups/global/CLAUDE.md                    # → systemPrompt.append（不变）
```

## 自动加载机制

Claude Code SDK 对 `~/.claude/` 的天然行为：

- `CLAUDE.md` — 每次会话自动加载
- `rules/*.md` — 每次会话自动加载
- `skills/` — 通过 Skill 工具按需发现
- `agents/` — 通过 Task 工具调用时发现

`memory/` 不是 Claude Code 内置目录，需要在 CLAUDE.md 中明确写入更新协议：

- 每次启动时读取 `~/.claude/memory/SOUL.md` 和 `USER.md`
- Session End Protocol：更新 memory 中的变化
- 每个文件控制在 1000 tokens 以内

## 操作步骤

1. 创建 `data/sessions/feishu_main/.claude/CLAUDE.md`
  - 先放骨架：目录结构说明 + memory 读写协议 + Session End Protocol
  - 具体内容（设计哲学、工作流程等）后续讨论填充
2. 创建 `data/sessions/feishu_main/.claude/rules/.gitkeep`
3. 创建 `data/sessions/feishu_main/.claude/memory/SOUL.md`（占位）
4. 创建 `data/sessions/feishu_main/.claude/memory/USER.md`（占位）
5. 创建 `data/sessions/feishu_main/.claude/agents/.gitkeep`
6. 精简 `groups/feishu_main/CLAUDE.md`，只保留 group 名称和基本标识信息
7. 验证目录结构

## 注意事项

- `skills/` 每次容器启动由 [container-runner.ts](src/container-runner.ts) 从 `container/skills/` 同步，不会删除已有的专属 skill
- `groups/global/CLAUDE.md` 通过 agent-runner 的 `systemPrompt.append` 注入，不受本次改动影响
- `memory/` 的自动更新依赖 CLAUDE.md 中的指令，不是 Claude Code 的内置机制
- CLAUDE.md 内容填充作为下一步单独讨论

