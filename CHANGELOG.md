# Changelog

Every release of agent-effort. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `agent-effort--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

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
