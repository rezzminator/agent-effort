# effort-live-control

Set each Claude Code sub-agent's reasoning effort per spawn, and let an orchestrator's effort follow its own trouble while it works.

**The tag.** Make `[effort: low|medium|high|xhigh|max]` the first non-blank text of the Agent prompt, on one line (a markdown link `[effort: …](…)` is not a tag). The tag is removed before the sub-agent reads its prompt, and its own model requests run at that level. The tag also wins over a type definition's own `effort:` (a steered agent starts at the tag held within its floor and ceiling); `parentTag: ignore` pins the definition's. An untagged sub-agent is pinned to the effort of its first request, so a mid-run `/effort` change never reaches it; a pin clears when the sub-agent finishes. An unknown level refuses the spawn. Compaction forks and the agent panel's `agent_summary` request are not pinned (see the repository README).

**Live control.** An agent definition with `effortControl: on` (or nested `floor`, `ceiling`, `landing`, `judge`, `tripwires`, `enabled`) is steered: its effort rises one step when its own test run fails (the first failing run, the 2nd in a row, then every even count), when a sub-agent returns `FAIL`, `BLOCKED` or another red word, or when a red result is sent back, and returns to normal when the trouble is resolved. The judge is off by default: on 258 recorded tripwires a Haiku judge could not tell trouble that continues from trouble that ends, and raising one step at every tripwire beat every judge variant (replay loss 0.283 against 0.517). Turn it on (`judge`, or `effortControl.judge: on`) and one cheap call per tripwire, never awaited, estimates the chance the trouble continues; the effort rises only at `judgeRaiseAt` or above. Agents also get `effort_up` and `effort_down` tools; a steered agent moves its own effort, any other is refused. The main chat is steered too (`mainChat`): with the default `reader`, a cheap model reads each new prompt and the end of the previous reply and sets the turn's effort, and the same tripwires raise it mid-turn; `tripwires` keeps your `/effort` as its home, `off` leaves it alone. Do not enable another plugin that steers the main chat at the same time. Every decision is written to a per-session JSONL log.

It requires function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and is tested on Claude Code 2.1.283. Install it with `/plugin install effort-live-control@effort-live-control` after `/plugin marketplace add rezzminator/effort-live-control`. Remove it with `claude plugin uninstall effort-live-control@effort-live-control`. The full documentation lives in the repository: https://github.com/rezzminator/effort-live-control

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `floor` | `medium` | Lowest effort a steered agent is sent. `effortControl.floor` overrides it. |
| `ceiling` | `xhigh` | Highest effort a steered agent is sent. `effortControl.ceiling` overrides it. |
| `parentTag` | `honor` | `honor`: a tag on the Agent prompt wins over the `effort:` of the agent's definition, and a steered agent starts at the tag held within its floor and ceiling. `ignore`: the definition's `effort:` keeps and the tag is ignored. `effortControl.parentTag` overrides it. |
| `models` | `claude-opus-5-5`<br>`claude-fable-5-1`<br>`claude-sonnet-5-5` | Model id prefixes that are steered; `claude-opus-5-5` also matches `claude-opus-5-5[1m]`. Any other model passes untouched. |
| `judge` | `false` | Ask the judge at a tripwire; off raises one step mechanically. `effortControl.judge` overrides it. |
| `judgeRaiseAt` | `25` | With the judge on: a probability (0 to 100) at or above this raises the effort one step; below it the effort holds. |
| `tripwires` | `fail1,fail2,red,redispatch` | The armed tripwires, comma-separated: `fail1` (the first failing test run), `fail2` (the 2nd in a row, then every even count), `red` (a sub-agent returned red), `redispatch` (a red result sent back). A disarmed one is still counted and read by the judge but raises nothing; empty arms none. `effortControl.tripwires` overrides it. |
| `judgeModel` | `haiku` | The judge call's model. |
| `judgeEffort` | `xhigh` | The judge call's own effort. |
| `judgeTimeoutMs` | `45000` | Milliseconds before an unanswered judge call is dropped and the effort rises one step. |
| `mainChat` | `reader` | Steering of the main chat: `off` leaves it untouched, `tripwires` steers it like a steered agent at the level each request asks for, `reader` also lets the prompt reader set the level at each new prompt ([Main chat](#-main-chat)). |
| `casebookFile` | `~/.local/state/effort-live-control/casebook.jsonl` | The prompt reader's casebook, JSONL, one past turn per line; a leading `~` is your home directory; empty or missing: the reader runs without one. |
| `promptModel` | `haiku` | The prompt reader's model. |
| `promptEffort` | `xhigh` | The prompt reader call's own effort. |
| `promptTimeoutMs` | `10000` | Milliseconds before an unanswered reader call is dropped and the turn goes at the level its first request asks for. |
| `buttons` | `true` | Register the `effort_up` and `effort_down` tools. |
| `announce` | `true` | Tell a steered agent, in its next tool result, when its effort changes. |
| `testCommandPatterns` | `\bgo\s+(-C\s+\S+\s+)?test\b`<br>`\b(npm\|pnpm\|yarn\|bun)\s+(run\s+)?test\b`<br>`\bvitest\b`<br>`\bjest\b`<br>`\bpytest\b`<br>`\bpython(\d(\.\d+)?)?\s+-m\s+unittest\b`<br>`\bnode\s+(--test\|--test-only)\b`<br>`\bcargo\s+(test\|nextest)\b`<br>`\bmake\b[^;&\|\n]*?\b(test\|check\|verify)\b`<br>`\bjust\b[^;&\|\n]*?\b(test\|check)\b`<br>`\b(mvn\|gradle\|gradlew)\b[^;&\|\n]*?\btest\b`<br>`\bdotnet\s+test\b`<br>`\bdeno\s+test\b`<br>`\bswift\s+test\b`<br>`\bmix\s+test\b`<br>`\b(rspec\|phpunit\|ctest\|tox\|nox)\b`<br>`\bscripts?/test[\w.-]*\.sh\b` | Regular expressions (case-sensitive); a foreground Bash call is a test run when a command it runs matches any (never a heredoc body, see `readOnlyCommands`). |
| `readOnlyCommands` | `cat`<br>`grep`<br>`egrep`<br>`fgrep`<br>`rg`<br>`ag`<br>`ack`<br>`echo`<br>`printf`<br>`sed`<br>`awk`<br>`head`<br>`tail`<br>`less`<br>`more`<br>`ls`<br>`find`<br>`fd`<br>`git`<br>`wc`<br>`which`<br>`type`<br>`man`<br>`file`<br>`stat`<br>`diff`<br>`jq`<br>`yq`<br>`sort`<br>`uniq`<br>`cut`<br>`tr`<br>`tee`<br>`test`<br>`[`<br>`[[`<br>`cd`<br>`pushd`<br>`popd`<br>`mkdir`<br>`rm`<br>`cp`<br>`mv`<br>`touch`<br>`chmod`<br>`ln`<br>`basename`<br>`dirname`<br>`realpath`<br>`readlink`<br>`date`<br>`sleep`<br>`true`<br>`false`<br>`export`<br>`read`<br>`wait`<br>`kill` | Program names whose commands never count as a test run, whatever they mention: a search, a print, a read, a file operation. A command is split at `;`, `&`, `\|` and newline, and only the segments whose program is not listed are matched against `testCommandPatterns`. `source` and `.` are not listed, because they execute. |
| `failurePatterns` | `--- FAIL`<br>`FAIL(ED)?`<br>`(?<!\d)[1-9]\d* (failed\|failing)`<br>`AssertionError`<br>`panic:`<br>`Traceback` | Regular expressions (case-sensitive); a test run whose result is an error or matches any fails. |
| `redWords` | `FAIL`<br>`FAILED`<br>`BLOCKED`<br>`PARTIAL`<br>`SPEC-DRIFT` | Words that open a failed return line. |
| `greenWords` | `DONE`<br>`PASS`<br>`FIXED` | Words that open a return line that clears an earlier red one. |
| `agentDirs` | *(none)* | Extra directories searched for agent definitions, after the project, config and home `.claude/agents`. |
| `logFile` | `~/.local/state/effort-live-control/decisions.jsonl` | The decision log, one file per session (session id before the extension); a leading `~` is your home directory; empty turns it off. |
| `logPackets` | `false` | Put the judge's and the prompt reader's snapshot and answer in their log rows. |

Built and maintained with [Professor](https://github.com/rezzminator/professor).
