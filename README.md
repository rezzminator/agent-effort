<div align="center">

# agent-effort

**Set each Claude Code sub-agent's reasoning effort per spawn: start the Agent prompt with `[effort: low|medium|high|xhigh|max]`.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-19%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
Agent({
  subagent_type: "general-purpose",
  prompt: "[effort: low]\nList every file under src/ that imports lodash."
})
```

<sup>The sub-agent runs every model request at `low`, whatever the session's `/effort` or the agent definition's `effort:` says.</sup>

## 🤔 Why

Claude Code lets you set effort for the session (`/effort`) and per agent type (`effort:` in an agent's frontmatter). Neither lets the model choose effort for one dispatch. The Agent tool takes a `model`, but not an `effort`. An orchestrator that sends a grep-and-list job and an architecture review to the same agent type pays the same thinking budget for both.

With this plugin, the model that writes the dispatch also picks the effort.

## 🚀 Quick start

Function hooks are experimental; turn them on first:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Then install:

```text
/plugin marketplace add rezzminator/agent-effort
/plugin install agent-effort@agent-effort
```

The Agent tool's description now tells the model about the tag, so no prompt change is needed on your side.

## 🧠 How it works

| Hook | What it does |
| --- | --- |
| `tool.describe` | Appends the tag's usage to the Agent tool's description. |
| `agent.spawn` | Reads the tag at the very start of the prompt. An unknown level refuses the spawn, and the model sees why. A valid tag is removed from the prompt, so the sub-agent never sees it, and recorded against the new sub-agent's id. |
| `turn.step` | Before each of that sub-agent's model requests, sets the request's `effort` to the tagged level. |

- The tag counts only as the prompt's first non-blank text. `[effort: high]` later in the prompt is ordinary prose.
- Levels are case-insensitive: `low`, `medium`, `high`, `xhigh`, `max`.
- Without a tag, nothing changes: the agent's frontmatter `effort:` applies, else the session's.
- The sub-agent reads its prompt without the tag. Effort lives in memory for the session, so a sub-agent resumed in a new session runs at its own effort.
- A model that takes no effort setting (such as Haiku) is sent none, whatever the tag says.
- Only sub-agents are affected. The main chat keeps `/effort`.

## ❓ FAQ

**Does it cost anything when unused?** No. An untagged spawn passes straight through; a request waits only when its sub-agent's spawn is still returning.

**Does it survive compaction?** Yes. Effort is recorded per sub-agent id when it spawns, not read from the transcript.

**Can the main chat set its own effort this way?** No; use `/effort`.

## 🛠️ Development

```bash
npm install
npm test               # vitest, the tag parser and the effort book
npm run typecheck      # src and the hooks module against the plugin API types
npm run validate:plugin
```

A live run loads the checkout with `claude --plugin-dir plugins/agent-effort`, with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

| Module | Role |
| --- | --- |
| `src/effort.ts` | The tag parser, the deny text, the description line, the per-agent effort book |
| `hooks/agent-effort.ts` | The adapter: the three hooks, and the only file that touches `$` |

## 🎓 Built with Professor

agent-effort is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. This plugin came out of it: Professor's orchestrators choose an effort for every dispatch, and this plugin makes that choice apply.

## License

MIT

<sub>Keywords: Claude Code sub-agent effort · per-agent reasoning effort · subagent thinking budget · Agent tool effort parameter · output_config effort · Claude Code plugin · function hooks · Claude Mods · multi-agent orchestration token cost</sub>
