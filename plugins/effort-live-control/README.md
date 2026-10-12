# effort-live-control

Set each Claude Code sub-agent's reasoning effort per spawn, and let an orchestrator's effort follow its own trouble while it works.

**The tag.** Make `[effort: low|medium|high|xhigh|max]` the first non-blank text of the Agent prompt, on one line (a markdown link `[effort: …](…)` is not a tag). The tag is removed before the sub-agent reads its prompt, and its own model requests run at that level. A type whose definition sets its own `effort:` keeps it and the tag is ignored. An untagged sub-agent is pinned to the effort of its first request, so a mid-run `/effort` change never reaches it; a pin clears when the sub-agent finishes. An unknown level refuses the spawn. Compaction forks and the agent panel's `agent_summary` request are not pinned (see the repository README).

**Live control.** An agent definition with `effortControl: on` (or nested `floor`, `ceiling`, `landing`, `judge`, `enabled`) is steered: its effort rises one step when its own test run fails (the first failing run, the 2nd in a row, then every even count), when a sub-agent returns `FAIL`, `BLOCKED` or another red word, or when a red result is sent back, and returns to normal when the trouble is resolved. The judge is off by default: on 258 recorded tripwires a Haiku judge could not tell trouble that continues from trouble that ends, and raising one step at every tripwire beat every judge variant (replay loss 0.283 against 0.517). Turn it on (`judge`, or `effortControl.judge: on`) and one cheap call per tripwire, never awaited, estimates the chance the trouble continues; the effort rises only at `judgeRaiseAt` or above. Agents also get `effort_up` and `effort_down` tools; a steered agent moves its own effort, any other is refused. Every decision is written to a per-session JSONL log.

It requires function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and is tested on Claude Code 2.1.283. Install it with `/plugin install effort-live-control@effort-live-control` after `/plugin marketplace add rezzminator/effort-live-control`. Remove it with `claude plugin uninstall effort-live-control@effort-live-control`. The full documentation lives in the repository: https://github.com/rezzminator/effort-live-control

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `floor` | `medium` | Lowest effort a steered agent is sent. `effortControl.floor` overrides it. |
| `ceiling` | `xhigh` | Highest effort a steered agent is sent. `effortControl.ceiling` overrides it. |
| `models` | `claude-opus-5-5`<br>`claude-fable-5-1`<br>`claude-sonnet-5-5` | Model id prefixes that are steered; `claude-opus-5-5` also matches `claude-opus-5-5[1m]`. Any other model passes untouched. |
| `judge` | `false` | Ask the judge at a tripwire; off raises one step mechanically. `effortControl.judge` overrides it. |
| `judgeRaiseAt` | `25` | With the judge on: a probability (0 to 100) at or above this raises the effort one step; below it the effort holds. |
| `judgeModel` | `haiku` | The judge call's model. |
| `judgeEffort` | `xhigh` | The judge call's own effort. |
| `judgeTimeoutMs` | `45000` | Milliseconds before an unanswered judge call is dropped and the effort rises one step. |
| `buttons` | `true` | Register the `effort_up` and `effort_down` tools. |
| `announce` | `true` | Tell a steered agent, in its next tool result, when its effort changes. |
| `testCommandPatterns` | `\bgo\s+(-C\s+\S+\s+)?test\b`<br>`\b(npm\|pnpm\|yarn\|bun)\s+(run\s+)?test\b`<br>`\bvitest\b`<br>`\bjest\b`<br>`\bpytest\b`<br>`\bcargo\s+(test\|nextest)\b`<br>`\bmake\b[^;&\|\n]*?\b(test\|check\|verify)\b`<br>`\bjust\b[^;&\|\n]*?\b(test\|check)\b`<br>`\b(mvn\|gradle\|gradlew)\b[^;&\|\n]*?\btest\b`<br>`\bdotnet\s+test\b`<br>`\bdeno\s+test\b`<br>`\bswift\s+test\b`<br>`\bmix\s+test\b`<br>`\b(rspec\|phpunit\|ctest\|tox\|nox)\b`<br>`\bscripts?/test[\w.-]*\.sh\b` | Regular expressions (case-sensitive); a foreground Bash command matching any is a test run. |
| `failurePatterns` | `--- FAIL`<br>`FAIL(ED)?`<br>`(?<!\d)[1-9]\d* (failed\|failing)`<br>`AssertionError`<br>`panic:`<br>`Traceback` | Regular expressions (case-sensitive); a test run whose result is an error or matches any fails. |
| `redWords` | `FAIL`<br>`FAILED`<br>`BLOCKED`<br>`PARTIAL`<br>`SPEC-DRIFT` | Words that open a failed return line. |
| `greenWords` | `DONE`<br>`PASS`<br>`FIXED` | Words that open a return line that clears an earlier red one. |
| `agentDirs` | *(none)* | Extra directories searched for agent definitions, after the project, config and home `.claude/agents`. |
| `logFile` | `~/.local/state/effort-live-control/decisions.jsonl` | The decision log, one file per session (session id before the extension); a leading `~` is your home directory; empty turns it off. |
| `logPackets` | `false` | Put the judge's snapshot and answer in its log rows. |

Built and maintained with [Professor](https://github.com/rezzminator/professor).
