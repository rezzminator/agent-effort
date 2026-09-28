# agent-effort

Set each Claude Code sub-agent's reasoning effort per spawn: make `[effort: low|medium|high|xhigh|max]` the first non-blank text of the Agent prompt, on one line (a markdown link `[effort: …](…)` is not a tag). The tag is removed before the sub-agent reads its prompt, and its own model requests run at that level; its compaction forks and the agent panel's `agent_summary` request are not pinned (see the repository README). An untagged sub-agent is pinned to the effort of its first request, so a mid-run `/effort` change never reaches it; a pin clears when the sub-agent finishes. An unknown level refuses the spawn.

It requires function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and is tested on Claude Code 2.1.283. Remove it with `claude plugin uninstall agent-effort@agent-effort`. The full documentation lives in the repository: https://github.com/rezzminator/agent-effort

Built and maintained with [Professor](https://github.com/rezzminator/professor).
