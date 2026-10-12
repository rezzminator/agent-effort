# Changelog

Every release of effort-live-control (named agent-effort through 0.1.3). Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `effort-live-control--v<version>` (`agent-effort--v<version>` through 0.1.3), with a GitHub release carrying the section below.

## [Unreleased]

### Added
- Live effort control. An agent definition with `effortControl` (bare `on`, or nested `floor`, `ceiling`, `landing`, `judge`, `enabled`) is steered: its requests go at a level that rises at a tripwire (its own test run failing twice in a row, a sub-agent returning `FAIL`, `FAILED`, `BLOCKED`, `PARTIAL` or `SPEC-DRIFT`, a red result sent back to a sub-task) and returns to the level it had once a test run passes and no unit is red. One Haiku call per tripwire (never awaited, so no request waits) names the level; a call that times out, fails or answers off-format raises one step instead.
- The `effort_up` and `effort_down` tools: a steered agent moves its own effort one step within its range; any other caller is refused.
- The agent is told of each change in its next tool result (`announce`).
- A landing step: spawning a type listed in `effortControl.landing` lowers the agent one step below its home level.
- Sixteen plugin options (`floor`, `ceiling`, `models`, `judge`, `judgeModel`, `judgeEffort`, `judgeTimeoutMs`, `buttons`, `announce`, `testCommandPatterns`, `failurePatterns`, `redWords`, `greenWords`, `agentDirs`, `logFile`, `logPackets`) and a per-session JSONL decision log, with no prompt or tool-result text unless `logPackets` is on.

### Changed
- A sub-agent whose definition sets `effort:` to a level keeps it: a valid `[effort: …]` tag is still stripped from the prompt but ignored, and a `tag-ignored` row says so. A malformed tag still refuses the spawn. The Agent tool's description says so.
- Renamed from agent-effort to effort-live-control. Migration: uninstall `agent-effort@agent-effort`, install `effort-live-control@effort-live-control` (`/plugin marketplace add rezzminator/effort-live-control`). The host-state key changed from `agent-effort` to `effort-live-control`, so the pins of a running session are dropped: its sub-agents run unpinned until their next spawn or first request.

## [0.1.3] — 2026-10-12

### Fixed
- A tagged sub-agent whose run ends while its own background child, shell or monitor still runs keeps its pin, so the run that work's notification wakes stays at the tagged effort. The engine reports such an agent as `waiting`, which used to clear the pin.
- The README says the panel's `agent_summary` request carries the effort the sub-agent's definition declares; it said the session's.

## [0.1.2] — 2026-09-28

### Fixed
- Removing the tag keeps the next line's indentation: only the spaces after the tag on its own line and one line break are removed.
- A markdown link opening the prompt (`[effort: high](…)`) and brackets spanning a line break are no longer read as a tag.
- An interrupted turn ends a sub-agent request's wait for its spawn at once, and the wait's timer is cancelled however the wait ends.
- The release check exits 2 with a clear error when a manifest cannot be read, accepts prerelease versions in the badge and compares versions by semver, escapes the version in its patterns, and fails on an unchecked `cd`.
- The release workflow refuses a tag whose version differs from the plugin manifest at the tagged commit.
- CI pins its GitHub actions by commit SHA and the Claude Code CLI by version.

### Changed
- The READMEs say the tag is the prompt's first non-blank text on one line and that a markdown link is not one, name the requests that are not pinned (compaction forks, `agent_summary`), and add the requirement, the tested Claude Code version and how to uninstall.
- The gitter agent states that only a release reaches installed copies.

## [0.1.1] — 2026-09-27

### Added
- Every sub-agent is pinned: an untagged one runs at the effort of its first request, so a mid-run `/effort` change never reaches it. A pin clears when the sub-agent finishes; a run that ends while it still waits on its own background task keeps it.
- A prompt that is only an effort tag is refused.

### Known limits
- The agent panel's progress summary (`agent_summary`, a short request about every 30 seconds per background sub-agent) passes through no plugin hook and runs at the session's effort.

### Fixed
- A sub-agent's first request waits only for its own spawn, not every spawn in flight, and its log no longer misreports the effort sent.
- A loop no spawn names (compaction and memory forks) waits at most once instead of on every request during fan-out.
- Pins live in Claude Code's session state and survive a plugin reload.
- The release check fails when `main`'s manifest cannot be read, instead of passing against version 0.0.0, and checks `package-lock.json`'s version.

### Changed
- The Agent tool's description line is one sentence and names the pinning.

## [0.1.0] — 2026-09-27

### Added
- `[effort: low|medium|high|xhigh|max]` at the start of an Agent prompt sets that sub-agent's effort for every model request it makes.
- The tag is removed from the prompt before the sub-agent reads it.
- An unknown level refuses the spawn with a message naming the valid levels.
- The Agent tool's description teaches the tag.
