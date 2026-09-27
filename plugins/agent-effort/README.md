# agent-effort

Set each Claude Code sub-agent's reasoning effort per spawn: start the Agent prompt with `[effort: low|medium|high|xhigh|max]` on its first line. The tag is removed before the sub-agent reads its prompt, and every model request it makes runs at that level; an untagged spawn keeps the agent's own effort, and an unknown level refuses the spawn.

It requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The full documentation lives in the repository: https://github.com/rezzminator/agent-effort

Built and maintained with [Professor](https://github.com/rezzminator/professor).
