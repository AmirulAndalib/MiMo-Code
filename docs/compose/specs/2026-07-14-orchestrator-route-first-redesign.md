---
date: 2026-07-14
topic: orchestrator-route-first-redesign
revisions:
  - date: 2026-07-15
    change: "AI-route revision: removed tool-level matching (findBestMatch/heuristic/embedding). Route decision is entirely AI-side — harness injects <active-sessions>, prompt guides AI to route-first, AI uses existing session send/create directly. No new route tool operation."
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

### Why Tool-Level Matching Also Cannot Work

初版设计曾提出 `session route` 操作, 内置 `findBestMatch` (启发式/embedding/LLM-assisted) 做自动匹配。这也是错的:

- **Orchestrator 本身就是 AI** — 它能理解语义、判断相关性、权衡上下文。让工具层用机械匹配替代 AI 的语义判断, 是倒退。
- **匹配逻辑无法覆盖所有场景**: "这个任务该交给谁" 取决于任务内容、会话历史、用户意图、依赖关系 — 这些是 AI 的强项, 不是算法的强项。
- **增加一层抽象但没有增加能力**: 工具层匹配只是把 AI 的路由决策权抢走, 然后用一个更差的决策替代。

**正确分工**: 工具层提供 **信息** (活会话清单) 和 **执行** (send/create), AI 做 **决策** (路由到谁)。

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

Target:   user task → AI reads <active-sessions> → route (send) or create
                                    ↑ AI 做路由决策, 工具只提供清单+执行
```

### 类比: 人如何管理多会话

一个人面对多个聊天窗口时:
1. 看一眼所有活跃窗口 (自动注入的清单)
2. 根据消息内容判断该发给谁 (AI 的语义判断)
3. 如果没有合适的窗口, 新开一个 (create as fallback)

人不会: 收到消息 → 新建窗口 → 给窗口打标签 → 期望下次能按标签找到。
人也不会: 收到消息 → 让算法自动匹配 → 发给匹配结果。

人会: 看一眼列表, 自己决定发给谁。

## Target Design

### Core Principle: AI Routes, Tools Provide + Execute

整个设计的核心原则:

> **路由决策是 AI 的职责。工具层只负责两件事: (1) 提供活会话清单作为 AI 的决策输入; (2) 执行 AI 选定的 send/create 操作。**

没有独立的 `route` 工具操作。没有 `findBestMatch`。没有启发式匹配。没有 embedding 相似度。AI 看着清单, 自己决定 send 给谁。

这意味着:
- **不需要新的 tool verb** — AI 直接用现有的 `session send` 和 `session create`
- **不需要工具层的匹配逻辑** — 路由决策完全在 prompt + AI 层
- **最小化代码变更** — 核心变更是 (1) context injection, (2) prompt rewrite

### R1: Harness 注入活会话清单

Orchestrator 的 system prompt 需要注入 **活会话上下文**, 像人看聊天列表一样:

**注入内容** (每次 Orchestrator turn 开始时, 极简摘要格式):

```xml
<active-sessions>
  ses_abc123 | Fix login bug | build | progressing
  ses_def456 | Design billing schema | compose | idle
  ses_ghi789 | Triage repo issues | build | stalled
</active-sessions>
```

每个会话一行: `id | title | mode | status`。只有 4 个字段, 没有 dir 和最近任务详情。AI 需要详情时, 自己调用 `session ask` 或 `session status` 按需查询。详见 R1.1 注入策略。

**注入位置**: `packages/opencode/src/session/llm.ts:240-306` (`buildSystemArray`)。在 agent prompt 组装完成后、plugin transform 前, 注入一个 `<active-sessions>` block。这个 block 由 `session list` 的数据自动生成, 不需要 Orchestrator 主动调用。

**内容来源**:
- `sessions.children(ctx.sessionID)` 获取子会话列表
- `actorReg.get()` 获取 actor 状态 (mode, agent type)
- `deriveLiveness()` 计算进度状态 (progressing/stalled/idle/terminal)
- Terminal 状态 (success/failed/cancelled) 的会话不注入 — 只列活跃会话


### R1.1: `<active-sessions>` Injection Strategy

R1 描述了注入什么, 但没有回答 **怎么注入** — 特别是: 是每轮全量注入, 还是有更聪明的策略? 这个问题在会话数增长后变得关键。

#### 问题: 全量详情注入的代价

如果每轮 turn 都把完整的 `<active-sessions>` (含 dir、最近任务详情等) 注入 system prompt:
- **Context 膨胀**: N 个会话 × 每个 ~100 tokens = N×100 tokens, 每轮重复。20 个会话就是 ~2000 tokens/轮。
- **重复浪费**: 大部分 turn (正和某子会话对话、做非路由工作) 根本不需要全量清单。Orchestrator 和 child A 对话时, B/C/D/E 的详情是噪音。
- **Cache 失效**: prompt cache 依赖 system prompt 前缀稳定; 清单每轮变 (状态/新会话) 导致 cache 频繁失效。

#### 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A: 按需拉取** | 不注入, 提供轻量 `session list` 动作让 AI "要路由才查" | 零常驻开销 | 回到靠 LLM 自觉去查 — 用户已批评过依赖自觉; AI 可能忘记查就直接 create |
| **B: 全量详情注入** | 每轮注入完整清单 (id/title/mode/status/dir/最近任务) | AI 始终有完整信息 | Context 膨胀; 大部分 turn 浪费; cache 失效 |
| **C: 极简摘要注入** | 每轮注入极简清单 (id/title/mode/status, 一行一会话, 无 dir/详情) | 低成本 (N 行 ≈ N×30 tokens); AI 有足够信息做路由决策; 需要详情时自己 ask | 信息密度低于 B, 但路由决策通常不需要 dir/详情 |
| **D: 条件注入** | 只在"新工作到达需路由决策"的 turn 注入, 非每轮 | 精准 | 需要判定"何时该注入" — 增加判定逻辑复杂度 |
| **E: 增量注入** | 只注入变化 (新会话/状态变更), 非每轮全量 | 低带宽 | 需要 diff 逻辑; AI 可能丢失已消失会话的信息; 实现复杂 |

#### 推荐: 极简摘要 + 按需详情 (C 为主, A 为辅)

**默认注入极简摘要** (方案 C), AI 需要详情时 **按需查询** (方案 A 作为补充):

```xml
<active-sessions>
  ses_abc123 | Fix login bug | build | progressing
  ses_def456 | Design billing schema | compose | idle
  ses_ghi789 | Triage repo issues | build | stalled
</active-sessions>
```

**为什么这组最优**:

1. **极简摘要足够做路由决策**: 路由只需要 "谁在线、在做什么、什么模式"。id + title + mode + status 四个字段覆盖了 90% 的路由判断。Dir 和最近任务详情是 "确认级" 信息, 不是 "决策级" 信息 — AI 先凭摘要选定目标, 需要确认时再 `session ask` 或 `session status` 查详情。

2. **成本可控**: 一行 ~30 tokens。10 个会话 = ~300 tokens, 20 个会话 = ~600 tokens。相比全量详情 (10 个会话 ~1000 tokens) 小一个数量级。即使 50 个会话也只 ~1500 tokens, 可接受。

3. **天然过滤已归档会话**: 只列非 terminal 状态 (progressing/stalled/idle) 的会话。已 success/failed/cancelled 的会话不注入 — 它们不需要路由, 且会无限膨胀清单。需要查询已归档会话时, AI 自己 `session list` 或 `session ask`。

4. **不依赖 LLM 自觉**: 与方案 A 纯按需不同, 极简摘要是 **默认注入** — AI 每轮 turn 都能看到清单, 不需要记住去查。只是清单是精简版, 不是完整版。

5. **Prompt cache 友好**: 极简摘要变化频率低于全量详情 (status 变化 < 详情变化)。且因为体量小, 即使 cache 失效, 重建成本也低。

**AI 需要详情时的按需路径**:

```
AI 看极简摘要 → 选定目标会话 → 需要确认细节?
  ├─ 不需要 → session send <id> <task>  (直接路由)
  └─ 需要 → session status <id> 或 session ask <id>  (按需查详情)
```

**实现**: `buildActiveSessionsContext` 函数输出极简格式 (一行一会话, 只含 id/title/mode/status), 过滤 terminal 状态。注入位置不变 (`buildSystemArray`, orchestrator agent 类型)。


### R2: orchestrator.txt 决策指引重写

orchestrator.txt 的核心变化 — 让 AI 自己做路由决策:

| Section | Before | After |
|---------|--------|-------|
| 核心循环 | decompose → dispatch (create) | understand → **route** (AI reads list, decides send or create) → yield → integrate → report |
| session tool 参考 | create 是主要操作 | **send 是主要操作**, create 是 fallback |
| 复用指引 | "reuse a standing session per theme" via topic | "see `<active-sessions>` in your context — pick the best match and `session send`" |
| 新增 Route Decision | — | AI 如何从清单中选择: 看 title/mode/status/dir, 结合任务语义判断 |

**orchestrator.txt 新增 Route Decision section 的内容指引**:

```
## Routing: route to existing sessions first

Your system prompt contains an <active-sessions> block listing your live
child sessions in compact format: id | title | mode | status.
This is your fleet — use it.

When a new task arrives, your FIRST action is to decide: does an existing session
already own this work? Look at <active-sessions> and evaluate:
- Which session's title/theme matches this task's domain?
- Which session's mode (build/plan/compose) is appropriate?
- Is the session idle (ready for new work) or progressing (can accept follow-up)?

If you need more detail about a session (its directory, recent commits, etc.),
use `session status <id>` or `session ask <id>` — the compact list gives you
enough to route; details are on-demand.

If you find a good match → `session send <id> <task>` (route to existing).
If no session fits → `session create <task>` (create as fallback).

DO NOT create a new session when an existing one can handle the work.
One session serving multiple related tasks is the norm, not the exception.
```

### R3: create 降级为 fallback

`session create` 保留但语义变化:

- **之前**: create 是默认操作, Orchestrator 的第一反应
- **之后**: create 是 "AI 判断没有合适会话时的 fallback"
- `--topic` 机制保留但降级为可选的 hint, 不再是路由的核心

Orchestrator 的决策流程变为:

```
1. 收到用户任务
2. 看 <active-sessions> (自动注入, 不需要 list 调用)
3. AI 判断: 有没有一个现有会话适合处理这个任务?
   ├─ Yes → session send <sessionID> <task>  (AI 自己选 ID)
   └─ No  → session create <task>            (AI 自己决定参数)
4. 返回结果给用户
```

## Code Impact Analysis

### 1. session 工具: 无新 verb, 仅清理

**File**: `packages/opencode/src/tool/session.ts`

| Current | Change | Impact |
|---------|--------|--------|
| `create` (line 613-739) | 保留, 移除 topic find-or-reuse 逻辑 (lines 621-661), 降级为纯创建 | 中等 — topic 逻辑移出 |
| `send` (line 742-810) | 保留不变, 成为主要操作 | 无 |
| `list` (line 813-883) | 保留, 新增 `summary` 返回格式供 context 注入使用 | 低 — 新增输出格式 |
| `topicOf` (line 187) | 保留但标记 deprecated; 不再是路由核心 | 低 |
| `tagTitle` (line 192) | 保留但标记 deprecated | 低 |

**关键: 没有新的 tool verb**。AI 直接用 `session send` 执行路由, 用 `session create` 作为 fallback。工具层零新增 API。

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

`buildActiveSessionsContext` 是一个新函数, 复用 `list` 操作的数据获取逻辑 (lines 820-826), 输出极简 XML 格式 (一行一会话, 只含 id/title/mode/status), 过滤 terminal 状态会话。详见 R1.1 注入策略。

**注入时机**: 每次 Orchestrator 发起 LLM 请求时, system prompt 中包含最新的活会话快照。这意味着 Orchestrator 在做路由决策时, **不需要调用 `session list`** — 清单已经在上下文里了。

### 3. orchestrator.txt 决策指引

**File**: `packages/opencode/src/session/prompt/orchestrator.txt`

核心重写部分:

- **Line 1-5 (Identity)**: 强调 "route-first coordinator", 而非 "decompose-and-dispatch leader"
- **Line 22-30 (The loop)**: 循环改为 "understand → route (AI reads list, decides send or create) → yield → integrate → report"
- **Line 48-59 (session tool reference)**: `send` 提升为主要操作, `create` 标注为 fallback
- **Line 82-88 (Reuse section)**: 从 "reuse per theme via topic" 改为 "see `<active-sessions>` — pick the best match and send"
- **新增 Route Decision section**: 指导 AI 如何利用 `<active-sessions>` 上下文做路由决策 (见 R2)

### 4. 涉及文件汇总

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/opencode/src/session/llm.ts` | **修改** | `buildSystemArray` 中注入 `<active-sessions>` context |
| `packages/opencode/src/session/prompt/orchestrator.txt` | **修改** | 决策指引从 create-first 改为 route-first; 新增 Route Decision section |
| `packages/opencode/src/tool/session.ts` | **修改** | `create` 中移除 topic find-or-reuse; `list` 新增 summary 格式 |
| `packages/opencode/src/session/prompt.ts` | **小改** | `buildActiveSessionsContext` 新函数 (可放此处或 llm.ts) |

**注意**: 没有新增 Zod schema, 没有新增 KNOWN_VERBS, 没有新增 tool verb。核心变更是 context injection + prompt rewrite。

## Implementation Roadmap

### Phase 1: Context Injection (harness 层, 不改产品行为)

**Goal**: Orchestrator 的 system prompt 中自动包含活会话清单, 但不改变任何路由行为。

1. 在 `llm.ts:buildSystemArray` 中, 对 orchestrator agent 注入 `<active-sessions>` XML block
2. 数据来源复用 `sessions.children` + `actorReg.get` + `deriveLiveness` (已有逻辑)
3. Orchestrator 现在能"看到"活会话列表, 但仍使用旧的 create-first 流程
4. **验证**: Orchestrator 的回复中能引用具体会话 ID 和状态 (证明它看到了清单)

**风险**: 注入增加 system prompt 大小。需要监控 token 使用。活会话数量通常 <10, 增量 <500 tokens。

### Phase 2: orchestrator.txt 重写 (prompt 层, 改变行为)

**Goal**: 通过 prompt 引导, 让 AI 优先 route-to-existing 而非 create。这是 **主体工作**。

1. 重写 orchestrator.txt 的核心循环和决策指引
2. 新增 "Route Decision" section: AI 如何从 `<active-sessions>` 中选择目标
3. 将 `send` 提升为主要操作, `create` 标注为 fallback
4. 移除旧的 topic-based reuse 指引
5. **验证**: Orchestrator 面对同主题的第二个任务时, 优先 `session send` 到已有会话

**风险**: prompt 引导是"软约束" — LLM 可能仍然偶尔 create。但这是 AI 路由的正确模型: 不是强制, 而是引导。如果引导不够强, 迭代 prompt (加 more explicit examples/constraints) 而非引入工具层匹配。

### Phase 3: 可选加强 (如果 Phase 2 的 prompt 引导不够)

**Goal**: 如果纯 prompt 引导后 Orchestrator 仍然过度 create, 加强引导而非引入匹配。

可能的加强手段 (按优先级):
1. **更强的 prompt 约束**: 在 orchestrator.txt 中加明确的 "MUST check active-sessions before create" + 反面示例
2. **create 前拦截**: 在 `session create` 的工具实现中, 如果 `<active-sessions>` 中有高度相关的会话, 返回 warning 而非直接创建 (注意: 这仍然是 AI 看到 warning 后自己决定, 不是工具自动匹配)
3. **指标监控**: 跟踪 create vs send 比率, 如果 create 率过高则迭代 prompt

**不做的事**: 启发式匹配、embedding 相似度、工具层自动路由。这些都违反 "AI routes" 原则。

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

- **AI 路由, 工具不匹配**: 路由决策完全由 AI 做 — 基于注入的 `<active-sessions>` 清单和任务语义。工具层不实现任何匹配逻辑 (findBestMatch/heuristic/embedding)。AI 是最好的路由器。
- **不需要新的 route 工具操作**: AI 直接用现有的 `session send` 执行路由, 用 `session create` 作为 fallback。最小化代码变更。
- **context injection 而非 on-demand query**: 活会话清单注入 system prompt, 让 Orchestrator 每次 turn 都能看到全貌, 而非需要主动调用 list — 降低认知负担
- **prompt 引导而非硬编码**: 路由行为通过 prompt 迭代优化, 而非工具层强制。如果引导不够, 加强 prompt 而非引入匹配算法。

## Dependencies / Assumptions

- Orchestrator 当前是 experimental (flag-gated), 本 redesign 在 experimental 阶段实施, 无需 migration
- `sessions.children` + `actorReg.get` + `deriveLiveness` 已经提供了足够的会话状态数据
- 活会话数量通常 <20, context injection 的 token 开销可接受

## References

- `packages/opencode/src/tool/session.ts` — session tool 实现 (create/send/list/topicOf/tagTitle)
- `packages/opencode/src/session/prompt/orchestrator.txt` — orchestrator 系统提示词
- `packages/opencode/src/session/llm.ts:240-306` — system prompt 组装 (buildSystemArray)
- `packages/opencode/src/agent/agent.ts:231-251` — orchestrestrator agent 定义
- `docs/harness/MiMo Orchestrator Mode.md` — orchestrator 模式文档
- PR #1727 — 去掉 topic 字符串匹配 (止血, 非本 redesign)
