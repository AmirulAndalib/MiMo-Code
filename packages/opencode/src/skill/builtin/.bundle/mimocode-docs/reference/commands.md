# MiMoCode Commands Reference

## CLI (`mimo <command>`)

Invoked from the shell. `mimo` with no command opens the TUI.

| Command | Purpose |
|---------|---------|
| `mimo` | Launch the interactive TUI |
| `mimo run` | Headless, non-interactive run (scripting/eval) |
| `mimo mcp` | Manage / inspect MCP servers |
| `mimo agent` | Manage agents |
| `mimo models` | List available models |
| `mimo providers` | List / manage providers |
| `mimo account` (console) | Account / login console |
| `mimo upgrade` | Update to the latest version |
| `mimo uninstall` | Uninstall MiMoCode |
| `mimo serve` | Run the server |
| `mimo stats` | Usage statistics |
| `mimo export` / `mimo import` | Export / import sessions |
| `mimo session` | Manage sessions |
| `mimo github` / `mimo pr` | GitHub / pull-request integration |
| `mimo generate` | Code generation entry |
| `mimo plugin` (plug) | Manage plugins |
| `mimo db` | Database utilities |
| `mimo acp` / `mimo attach` | ACP / attach to a running session |
| `mimo debug` | Debug utilities |
| `mimo completion` | Generate shell completion script |

Run `mimo <command> --help` for flags on any command.

Notable TUI flags: `--continue`/`-c` (resume last session), `--session`/`-s`, `--model`/`-m`, `--agent`, `--never-ask`, `--trust`, and `--dangerously-skip-permissions` (auto-approve everything not explicitly denied; prompts once for confirmation — see permissions.md).

## Slash commands (inside the TUI)

| Command | Purpose |
|---------|---------|
| `/goal` | Set a stop condition; a judge model verifies it's truly met before the agent halts (prevents premature stops in autonomous work) |
| `/dream` | Scan recent traces, extract durable knowledge into project memory, prune stale entries |
| `/distill` | Detect repeated manual workflows and package high-confidence ones into skills/subagents/commands |
| `/voice` | Toggle streaming voice input (needs `sox`; MiMo-logged-in users) |
| `/loop` | `[interval] <prompt>` — schedule a repeating prompt (also runs once now); maps the interval to a cron job |
| `/loops` | List scheduled cron/loop jobs; `/loops cancel <id>` stops one |
| `/rebuild` | Rebuild the conversation context now from the latest checkpoint — frees context on demand instead of waiting for the automatic overflow trigger. Keeps recent messages verbatim; earlier context collapses to the checkpoint summary. Waits (bounded) for an in-flight checkpoint writer first |
| `/connect` | Sign in to a provider (e.g. OpenRouter; OAuth logins include Xiaomi MiMo, Codex/ChatGPT, xAI/Grok) |
| `/modalities` | Configure a custom model's input modalities (image/audio/video/pdf) via multi-select dialog; persists to `provider.<id>.models.<id>.modalities` in global config |
| `/skip-permissions` | Toggle auto-allow for permission asks at runtime (instance-wide, inherited by subagents). `deny` rules still block; forced-ask operations (destructive bash etc.) auto-reject after 60s with actionable feedback instead of hanging |
| `/compose-next` | Recommended spec→ship feature delivery skill; hidden from model auto-discovery — invoke explicitly |
| `/<skill-name>` | Invoke any available skill directly by name. Mentioning 2+ skills in one message auto-loads them (up to 3) and injects a multi-skill orchestration plan |

## Keybindings

- `Tab` — cycle primary agents (build → plan → compose). After the first message the mode locks: Build and Plan can still switch between each other, but Compose is isolated — it can't be entered mid-session, and a session started in Compose stays there. (Many models ignore tools injected mid-conversation; a fixed skill/tool set from session start improves tool-call reliability.)
- Other keybinds are configurable; the keybinds config module governs them.

## Notes

- The web command is currently disabled; TUI is the supported interface.
- Voice ASR (`mimo-v2.5-asr`) is MiMo-platform only; voice control (`mimo-v2.5`) also runs on OpenRouter and compatible relays via the `voice` config (see config.md and the README voice section).
