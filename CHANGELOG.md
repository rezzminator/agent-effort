# Changelog

Every release of agent-effort. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `agent-effort--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

## [0.1.0] — 2026-09-27

### Added
- `[effort: low|medium|high|xhigh|max]` at the start of an Agent prompt sets that sub-agent's effort for every model request it makes.
- An unknown level refuses the spawn with a message naming the valid levels.
- The Agent tool's description teaches the tag.
