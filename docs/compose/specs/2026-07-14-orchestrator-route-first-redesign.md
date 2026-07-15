---
date: 2026-07-14
topic: orchestrator-route-first-redesign
---

# Orchestrator Route-First Redesign

## Problem Frame

The MiMoCode Orchestrator (`src/agent/agent.ts:231`, gated by `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR`) is an experimental persistent coordinator that delegates work to background child sessions via the `session` tool. Its current architecture suffers from a **create-first default** that causes session explosion.

### Symptom: Session Explosion

In practice, the Orchestrator面对同一条主题的反复工作请求时, 每次都倾向于 `session create` 新建子会话, 而不是复用已有的。一个典型场景:

1. 用户说 "fix the login bug" → Orchestrator creates child A for "fix login bug"
2. 用户说 "also handle the signup flow" → Orchestrator creates child B (could have been routed to A)
3. 用户 says "one more thing about auth" → Orchestrator creates child C (again, A or B could handle this)

结果: 三个子会话做本质上同主题的工作, 每个都有独立的上下文和内存, 没有共享任何进展。

### Root Cause: create 耦合了路由和创建

当前 `session create` 命令同时承担两个职责:
- **路由决策**: 这条任务该交给哪个已存在的会话?
- **创建行为**: 如果没有合适的, 新建一个

`--topic` 机制是对此的修补 — 它在 create 内部加了一层 find-or-reuse, 但:
1. **topic 字符串匹配不可靠**: LLM 传什么 topic 取决于 prompt engineering, 语义漂移是必然的 (PR #1727 去掉了严格 topic 字符串匹配, 是止血不是根本解)
2. **topic 必填只保证"有值"不保证"语义正确"**: Orchestrator 可以给同一个主题传不同的 topic 值, 匹配就失效了
3. **复用 ≠ 给 create 找一个 key**: 真正的复用是"从现有会话里选一个最合适的发过去", 不是"给新会话打个标签以便下次匹配"

### Why Topic Matching Cannot Work (Any Variant)

| Variant | Why It Fails |
|---------|-------------|
| Exact string match | LLM 不可能每次都传完全相同的字符串 |
| Fuzzy / semantic match | 需要 embedding 或 LLM 判断, 增加延迟和复杂度, 且仍然依赖 LLM 正确提取"主题" |
| Topic 必填 | 保证有值, 不保证语义正确; LLM 会乱传 |
| Task-ID 绑定 | task 是廉价的, 一个 session 本该服务多个 task; task↔session 非一一对应 |
| Topic hierarchy | 过度工程; 真正需要的只是"看一眼活会话列表, 选一个发过去" |

**核心洞察**: 所有 topic 变体都错在同一个假设 — 把复用当成"给 create 找一个 key"。但真正的复用模式是 **人看聊天列表选一个发消息** — 你不会给每个聊天窗口打标签然后按标签匹配, 你看一眼列表就知道该发给谁。

## First-Principles Analysis

### Orchestrator 的本质: 传声筒/路由器

Orchestrator 不是 "decompose → dispatch (create)" 模型。它的本质是:

> **面对一条工作, 决定"传给哪个已存在的会话"**

这个决策的输入是:
- 活会话清单 (谁在线, 在做什么, 做到哪了)
- 当前任务的语义
- 会话之间的依赖关系

决策的输出是:
- route-to-existing: 把任务发给某个已有会话 (`session send`)
- create-as-fallback: 清单里没合适的 → 新建一个, 加入清单

### 当前模型 vs 目标模型

```
Current:  user task → decompose → create (default) → (maybe topic reuse)
                                    ↑ create 是一等操作

Target:   user task → route-to-existing (default) → create (fallback only)
                                    ↑ route/send 是一等操作
```

### 类比: 人如何管理多会话

一个人面对多个聊天窗口时:
1. 看一眼所有活跃窗口 (session list)
2. 根据消息内容判断该发给谁 (route decision)
3. 如果没有合适的窗口, 新开一个 (create as fallback)

人不会: 收到消息 → 新建窗口 → 给窗口打标签 → 期望下次能按标签找到。

## Target Design

### R1: 一等 route 原语

新增 `session route` 操作, 作为 Orchestrator 的 **默认第一动作**:

```
session route <task>
```

**行为**:
1. 自动获取活会话清单 (内置于 route 实现, 不需要 Orchestrator 手动 list)
2. 基于任务语义 + 会话清单, 由 harness 注入的上下文辅助决策
3. 如果匹配到合适的已有会话 → `session send` 到该会话, 返回路由结果
4. 如果没有合适的 → 返回 "no match, recommend create" + 建议的 mode/dir 参数

**关键区别**: route 是 **决策操作**, 不是创建操作。它的输出是 "我选了会话 X, 因为 Y" 或 "没有合适的, 建议新建"。

### R2: Harness 注入活会话清单

Orchestrator 的 system prompt 需要注入 **活会话上下文**, 像人看聊天列表一样:

**注入内容** (每次 Orchestrator turn 开始时):

```xml
<active-sessions>
  <session id="ses_abc123" title="Fix login bug" mode="build" status="progressing" dir="/repo1" last_turn="2min ago">
    Working on: OAuth token refresh logic. 3 commits on mimocode/fix-login.
  </session>
  <session id="ses_def456" title="Design billing schema" mode="compose" status="idle" dir="/repo2">
    Completed: schema设计完成, 等待用户确认后实施。
  </session>
  <session id="ses_ghi789" title="Triage repo issues" mode="build" status="stalled" dir="/repo3">
    Last activity: 15min ago. May need nudge.
  </session>
</active-sessions>
```

**注入位置**: `packages/opencode/src/session/llm.ts:240-306` (`buildSystemArray`)。在 agent prompt 组装完成后、plugin transform 前, 注入一个 `<active-sessions>` block。这个 block 由 `session list` 的数据自动生成, 不需要 Orchestrator 主动调用。

**内容来源**:
- `sessions.children(ctx.sessionID)` 获取子会话列表
- `actorReg.get()` 获取 actor 状态 (mode, status, last turn time)
- `deriveLiveness()` 计算进度状态
- 每个会话的最近任务摘要 (从 session title + last message 提取)

### R3: create 降级为 fallback

`session create` 保留但语义变化:

- **之前**: create 是默认操作, Orchestrator 的第一反应
- **之后**: create 是 "route 发现没有合适会话时的 fallback"
- `--topic` 机制保留但降级为可选的 hint, 不再是路由的核心

Orchestrator 的决策流程变为:

```
1. 收到用户任务
2. 看 <active-sessions> (自动注入, 不需要 list 调用)
3. 判断: 有没有一个现有会话适合处理这个任务?
   ├─ Yes → session send <sessionID> <task>
   └─ No  → session create <task> [新建后加入清单]
4. 返回结果给用户
```

### R4: orchestrator.txt 决策指引重写

orchestrator.txt 的核心变化:

| Section | Before | After |
|---------|--------|-------|
| 核心循环 | decompose → dispatch (create) | route → (create only if none fits) |
| session tool 参考 | create 是主要操作 | send 是主要操作, create 是 fallback |
| 复用指引 | "reuse a standing session per theme" via topic | "route to existing sessions" — 看清单选一个 |
| 新增 | — | "route decision" section: 如何从活会话清单中选择 |

## Code Impact Analysis

### 1. session 工具原语重排

**File**: `packages/opencode/src/tool/session.ts`

| Current | Change | Impact |
|---------|--------|--------|
| `create` (line 613-739) | 保留, 移除 topic find-or-reuse 逻辑 (lines 621-661), 降级为纯创建 | 中等 — topic 逻辑移出 |
| `send` (line 742-810) | 保留不变, 成为主要操作 | 无 |
| `list` (line 813-883) | 保留, 新增 `summary` 返回格式供 context 注入使用 | 低 — 新增输出格式 |
| `topicOf` (line 187) | 保留但标记 deprecated; 不再是路由核心 | 低 |
| `tagTitle` (line 192) | 保留但标记 deprecated | 低 |
| **新增** `route` | 新操作: 获取清单 → 匹配 → send 或 recommend create | 高 — 核心新逻辑 |

`route` 操作的伪代码:

```typescript
if (op.action === "route") {
  // 1. Get active sessions (same enrichment as list)
  const children = yield* sessions.children(ctx.sessionID)
  const enriched = yield* Effect.forEach(children, ...)
  const peers = enriched.filter(/* real peers only */)

  // 2. Build routing context
  const sessions Summary = peers.map(({ child, actor }) => ({
    id: child.id,
    title: child.title,
    mode: actor?.agent,
    status: deriveLiveness(actor, now),
    dir: child.directory,
  }))

  // 3. LLM-assisted matching (or heuristic)
  const match = findBestMatch(op.task, sessionsSummary)

  if (match) {
    // 4a. Route to existing
    yield* inboxSvc.send({ receiverSessionID: match.id, ... content: op.task })
    return { output: `Routed to ${match.id} (${match.title})`, ... }
  } else {
    // 4b. No match — recommend create
    return {
      output: `No existing session matches. Recommend: session create with mode=${op.suggestedMode}, dir=${op.suggestedDir}`,
      metadata: { recommendCreate: true, ... }
    }
  }
}
```

### 2. Harness 向 Orchestrator 注入活会话清单

**File**: `packages/opencode/src/session/llm.ts:240-306` (`buildSystemArray`)

在 `buildSystemArray` 中, 对 orchestrator agent 类型, 注入 `<active-sessions>` block:

```typescript
// After agent prompt assembly (line 260), before plugin transform (line 292)
if (input.agent.name === "orchestrator") {
  const sessionCtx = yield* buildActiveSessionsContext(input.sessionID)
  if (sessionCtx) system.push(sessionCtx)
}
```

`buildActiveSessionsContext` 是一个新函数, 复用 `list` 操作的数据获取逻辑 (lines 820-826), 但输出为 XML 格式而非人类可读的列表。

**注入时机**: 每次 Orchestrator 发起 LLM 请求时, system prompt 中包含最新的活会话快照。这意味着 Orchestrator 在做路由决策时, **不需要调用 `session list`** — 清单已经在上下文里了。

### 3. orchestrator.txt 决策指引

**File**: `packages/opencode/src/session/prompt/orchestrator.txt`

核心重写部分:

- **Line 1-5 (Identity)**: 强调 "route-first coordinator", 而非 "decompose-and-dispatch leader"
- **Line 22-30 (The loop)**: 循环改为 "understand → route (to existing or create) → yield → integrate → report"
- **Line 48-59 (session tool reference)**: `send` 提升为主要操作, `create` 标注为 fallback
- **Line 82-88 (Reuse section)**: 从 "reuse per theme via topic" 改为 "route to existing — see active-sessions context"
- **新增 Route Decision section**: 指导 Orchestrator 如何利用 `<active-sessions>` 上下文做路由决策

### 4. 涉及文件汇总

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/opencode/src/tool/session.ts` | **修改** | 新增 `route` 操作; `create` 中移除 topic find-or-reuse; `list` 新增 summary 格式 |
| `packages/opencode/src/session/llm.ts` | **修改** | `buildSystemArray` 中注入 `<active-sessions>` context |
| `packages/opencode/src/session/prompt/orchestrator.txt` | **修改** | 决策指引从 create-first 改为 route-first |
| `packages/opencode/src/session/prompt.ts` | **小改** | `buildActiveSessionsContext` 新函数 (可放此处或 session.ts) |
| `packages/opencode/src/tool/session.ts` (schemas) | **修改** | Zod schema 新增 `routeOperation` |
| `packages/opencode/src/tool/session.ts` (KNOWN_VERBS) | **修改** | 加入 `"route"` |

## Implementation Roadmap

### Phase 1: Context Injection (harness 层, 不改产品行为)

**Goal**: Orchestrator 的 system prompt 中自动包含活会话清单, 但不改变任何路由行为。

1. 在 `llm.ts:buildSystemArray` 中, 对 orchestrator agent 注入 `<active-sessions>` XML block
2. 数据来源复用 `sessions.children` + `actorReg.get` + `deriveLiveness` (已有逻辑)
3. Orchestrator 现在能"看到"活会话列表, 但仍使用旧的 create-first 流程
4. **验证**: Orchestrator 的回复中能引用具体会话 ID 和状态 (证明它看到了清单)

**风险**: 注入增加 system prompt 大小。需要监控 token 使用。活会话数量通常 <10, 增量 <500 tokens。

### Phase 2: orchestrator.txt 重写 (prompt 层, 改变行为)

**Goal**: 通过 prompt 引导, 让 Orchestrator 优先 route-to-existing 而非 create。

1. 重写 orchestrator.txt 的核心循环和决策指引
2. 新增 "Route Decision" section: 如何从 `<active-sessions>` 中选择目标
3. 将 `send` 提升为主要操作, `create` 标注为 fallback
4. **验证**: Orchestrator 面对同主题的第二个任务时, 优先尝试 `session send` 到已有会话

**风险**: prompt 引导是"软约束" — LLM 可能仍然偶尔 create。Phase 3 通过硬编码 route 原语来加强。

### Phase 3: route 原语 (工具层, 硬编码路由)

**Goal**: 新增 `session route` 操作, 将路由逻辑从 prompt 引导提升为工具级实现。

1. 在 `session.ts` 新增 `route` verb 和对应的 Zod schema
2. 实现: 获取清单 → 匹配 (可先用启发式, 后续可用 LLM) → send 或 recommend-create
3. route 操作内置于工具, 不依赖 LLM 做路由决策 (消除 LLM 传错 topic 的问题)
4. **验证**: `session route "fix login bug"` 自动选择正确的已有会话

**可选增强**:
- Phase 3a: 启发式匹配 (基于 title 关键词 + mode + dir)
- Phase 3b: LLM-assisted matching (把任务 + 清单交给 LLM 做选择, 更准确但有延迟)

### Phase 4: 清理 deprecated 路径

1. `--topic` 参数标记 deprecated, 保留向后兼容但不再推荐
2. `topicOf` / `tagTitle` 辅助函数标记 deprecated
3. orchestrator.txt 中移除旧的 topic-based reuse 指引
4. 更新 harness 文档 (`docs/harness/MiMo Orchestrator Mode.md`)

## Scope Boundaries

- **本设计不涉及**: 并发路由冲突处理 (多个 Orchestrator 实例路由到同一会话)、跨 Orchestrator 会话路由、session 持久化 schema 变更
- **本设计不实现**: 只出设计文档 + 实施路线, 不改产品代码
- **向后兼容**: `session create` 保持可用, `--topic` 保留但 deprecated, 现有 Orchestrator 行为在 Phase 1-2 期间不变

## Key Decisions

- **route 作为一等操作**: 路由逻辑内置于工具层, 不依赖 LLM 正确传 topic — 消除了 topic 匹配的根本不可靠性
- **context injection 而非 on-demand query**: 活会话清单注入 system prompt, 让 Orchestrator 每次 turn 都能看到全貌, 而非需要主动调用 list — 降低认知负担
- **分阶段实施**: Phase 1-2 是 prompt/harness 层变更, 风险低; Phase 3 是工具层变更, 需要更多测试; Phase 4 是清理

## Dependencies / Assumptions

- Orchestrator 当前是 experimental (flag-gated), 本 redesign 在 experimental 阶段实施, 无需 migration
- `sessions.children` + `actorReg.get` + `deriveLiveness` 已经提供了足够的会话状态数据
- 活会话数量通常 <20, context injection 的 token 开销可接受

## References

- `packages/opencode/src/tool/session.ts` — session tool 实现 (create/send/list/topicOf/tagTitle)
- `packages/opencode/src/session/prompt/orchestrator.txt` — orchestrator 系统提示词
- `packages/opencode/src/session/llm.ts:240-306` — system prompt 组装 (buildSystemArray)
- `packages/opencode/src/agent/agent.ts:231-251` — orchestrator agent 定义
- `docs/harness/MiMo Orchestrator Mode.md` — orchestrator 模式文档
- PR #1727 — 去掉 topic 字符串匹配 (止血, 非本 redesign)
