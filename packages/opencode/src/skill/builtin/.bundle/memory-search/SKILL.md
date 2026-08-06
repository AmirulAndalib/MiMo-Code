---
name: "memory-search"
description: "Advanced memory and trajectory search techniques. Use when the built-in memory tool returns 0 results, when you need to search raw conversation history in the SQLite database, or when you need to locate specific past commands, tool outputs, decisions, or user statements across sessions. Covers: BM25 query optimization, scope escalation (session → project → global → raw DB), SQLite schema and query templates for the trajectory database, and strategies for finding repeated patterns, decisions, and errors."
---

# Memory Search Skill

Techniques for searching mimocode's memory system and raw trajectory database when the built-in `memory` tool alone is insufficient.

## When to use this skill

- The `memory` tool returned 0 results for several query attempts.
- You need verbatim recall of a specific command, path, token, or connection string that the curated memory may have paraphrased.
- You need to find patterns across multiple sessions (repeated errors, recurring workflows, user preferences stated long ago).
- You want to verify whether something was actually said/done in a past session.

## Memory system architecture

```
<DATA>/memory/
├── projects/
│   ├── global/MEMORY.md                      # cross-project user preferences
│   └── <project_id>/                         # per-project (UUID from .git/mimocode-project-id)
│       ├── MEMORY.md                         # project-level durable knowledge
│       └── MEMORY-*.md                       # spillover files when main exceeds budget
└── sessions/<session_id>/
    ├── checkpoint.md                         # structured session state (11 sections)
    ├── notes.md                              # free-form scratchpad
    └── tasks/<task_id>/progress.md           # per-task subagent findings
```

`<DATA>` is the mimocode data directory (typically `~/.local/share/mimocode/`).

## Step 1: Optimize memory tool queries

The `memory` tool uses BM25 (OR-joined, relevance-ranked). Common mistakes:

- **Too many generic words**: "config params database connection" — every word dilutes. Pick the 1-3 rarest, most specific terms.
- **Punctuation in queries**: `.`, `-`, `/`, `:` are stripped during tokenization. `postgres://host:5433` becomes tokens `postgres`, `host`, `5433`. Search one of those, not the full URL.
- **Wrong scope**: default is current session. Widen progressively: `scope: "sessions"` → `scope: "projects"` → `scope: "global"` → `scope: "cc"` (Claude Code imported memories, if cc_index is enabled).

Good queries: `"T5.3 closure"`, `"permission deadlock"`, `"drizzle inArray"`, a function name, an error code.

## Step 2: Use the history tool

When memory search misses (curated summaries may have dropped the literal), fall back to `history`:

```
history({ operation: "search", query: "the exact keyword" })
```

This searches raw conversation messages (user text, assistant text, tool inputs/outputs). Hits include `message_id` — use `history({ operation: "around", message_id: "..." })` to get surrounding context.

## Step 3: Query the raw trajectory database

When history search also misses, or you need cross-session analysis, query the SQLite database directly.

### Locating the database

```bash
# The DB path is derived from the memory root visible in system instructions.
# Typically: ~/.local/share/mimocode/mimocode.db
# If MIMOCODE_DB is set in the environment, it overrides.
ls ~/.local/share/mimocode/mimocode.db
```

### Schema

Key tables:

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `session` | Session metadata | `id`, `project_id`, `title`, `time_created`, `parent_id` |
| `message` | User/assistant turns | `id`, `session_id`, `agent_id`, `time_created`, `data` (JSON: `$.role`) |
| `part` | Message parts (text, tool calls, steps) | `id`, `message_id`, `session_id`, `time_created`, `data` (JSON) |
| `task` | Task tree | `id`, `session_id`, `summary`, `status` |
| `task_event` | Task state transitions | `id`, `session_id`, `task_id`, `at`, `kind`, `summary` |
| `actor_registry` | Subagent/peer history | `session_id`, `actor_id`, `agent`, `mode`, `status`, `description` |

### Part types in `part.data`

- `{"type":"text","text":"..."}` — agent text output
- `{"type":"tool","tool":"<name>","callID":"...","state":{"status":"completed","input":{...},"output":"..."}}` — tool call + result
- `{"type":"step-start"}` / `{"type":"step-finish","tokens":...}` — step boundaries
- `{"type":"compaction","auto":true/false}` — compaction boundary (the summary text is in the following assistant message, not this part)
- `{"type":"checkpoint",...}` — checkpoint/rebuild boundary

`agent_id = 'main'` = main agent; any other value = subagent (e.g. `"explore-1"`, `"general-1"`).

### Query templates

**List recent sessions for this project:**

```sql
SELECT id, title, time_created,
       datetime(time_created/1000, 'unixepoch', 'localtime') as created
FROM session
WHERE project_id = '<PROJECT_ID>'
  AND parent_id IS NULL
ORDER BY time_created DESC
LIMIT 20;
```

**Find user messages containing a keyword:**

```sql
SELECT m.session_id, m.id,
       substr(json_extract(p.data, '$.text'), 1, 200) as preview
FROM message m
JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
WHERE json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text'
  AND json_extract(p.data, '$.text') LIKE '%keyword%'
ORDER BY m.time_created DESC
LIMIT 10;
```

**Find tool calls by tool name (output only exists for status=completed):**

```sql
SELECT m.session_id, m.id, m.agent_id,
       json_extract(p.data, '$.tool') as tool,
       json_extract(p.data, '$.state.status') as status,
       substr(COALESCE(json_extract(p.data, '$.state.output'), json_extract(p.data, '$.state.error')), 1, 300) as result_preview
FROM message m
JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.tool') = '<TOOL_NAME>'
  AND m.session_id = '<SESSION_ID>'
ORDER BY m.time_created DESC
LIMIT 20;
```

**View a session's full assistant execution chain:**

```sql
SELECT m.id, m.agent_id,
       json_extract(p.data, '$.type') as part_type,
       json_extract(p.data, '$.tool') as tool,
       substr(p.data, 1, 800) as preview
FROM message m
JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
WHERE m.session_id = '<SESSION_ID>'
  AND json_extract(m.data, '$.role') = 'assistant'
ORDER BY m.time_created, p.time_created;
```

**Find repeated errors across sessions (last 7 days):**

Note: Tool failures (exceptions, aborts) store the error in `$.state.error` with `$.state.status = "error"`, NOT in `$.state.output` (which only exists for completed calls). This query finds completed bash calls whose stdout contains "error"; to find actual tool failures, query `$.state.error` instead.

```sql
-- Completed bash calls with "error" in stdout (last 7 days)
SELECT json_extract(p.data, '$.state.output') as error_output,
       COUNT(*) as occurrences,
       GROUP_CONCAT(DISTINCT m.session_id) as sessions
FROM part p
JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
WHERE json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.tool') = 'bash'
  AND json_extract(p.data, '$.state.status') = 'completed'
  AND json_extract(p.data, '$.state.output') LIKE '%error%'
  AND m.time_created > (strftime('%s', 'now') - 7*86400) * 1000
GROUP BY substr(json_extract(p.data, '$.state.output'), 1, 200)
HAVING occurrences > 1
ORDER BY occurrences DESC
LIMIT 10;
```

**Find actual tool failures (any tool, last 7 days):**

```sql
SELECT json_extract(p.data, '$.tool') as tool,
       json_extract(p.data, '$.state.error') as error_msg,
       COUNT(*) as occurrences,
       GROUP_CONCAT(DISTINCT m.session_id) as sessions
FROM part p
JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
WHERE json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.state.status') = 'error'
  AND m.time_created > (strftime('%s', 'now') - 7*86400) * 1000
GROUP BY json_extract(p.data, '$.tool'), substr(json_extract(p.data, '$.state.error'), 1, 200)
HAVING occurrences > 1
ORDER BY occurrences DESC
LIMIT 10;
```

### Search strategies for common goals

| Goal | Strategy |
|------|----------|
| Find a user's stated rule/preference | Search `LIKE '%always%'`, `'%never%'`, `'%remember%'`, `'%rule%'` in user text parts |
| Find a design decision | Search `'%decided%'`, `'%tradeoff%'`, `'%reason%'` |
| Find a specific file path or command | Use exact substring LIKE match on tool output |
| Find repeated workflows | Group tool call sequences by session, look for recurring patterns |
| Verify a memory claim | Find the session_id in the memory entry `[ses_xxx]`, then query its full execution chain |

## Important constraints

- **Read-only**: Never modify the database. Use `sqlite3` in read-only mode or just SELECT queries.
- **Performance**: The database can be large. Always use LIMIT, filter by session_id or time range when possible.
- **Privacy**: Raw trajectory contains everything the user typed. Treat it with care.
- **Encoding**: Part data is JSON-in-a-column. Always use `json_extract()` for structured access.
