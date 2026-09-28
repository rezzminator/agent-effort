# Changelog

Every release of agent-effort. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `agent-effort--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

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
