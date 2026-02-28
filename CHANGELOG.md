# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.14.0](https://github.com/monotykamary/pi-messenger-swarm/compare/v0.13.0...v0.14.0) (2026-02-28)


### ⚠ BREAKING CHANGES

* **swarm:** Previously joined agents will need to rejoin as state
location has changed from global to project-scoped.

### Features

* **swarm:** add file-based locking with await using support ([dcf9184](https://github.com/monotykamary/pi-messenger-swarm/commit/dcf91844e70c979faeb6c9261846e91888d0d2da))


### Bug Fixes

* **swarm:** make project-scoped isolation the default ([11ace61](https://github.com/monotykamary/pi-messenger-swarm/commit/11ace61cfe678e535b094bf451440736e5c17b86))

## [0.13.0](https://github.com/monotykamary/pi-messenger-swarm/compare/v0.12.1...v0.13.0) (2026-02-28)


### ⚠ BREAKING CHANGES

* **swarm:** legacy crew source tree and crew-specific test suites are removed; internal imports must use router/action-types/swarm modules and skill path is now skills/pi-messenger-swarm.

### Features

* **overlay:** repurpose f toggle to swarm session list ([7be929d](https://github.com/monotykamary/pi-messenger-swarm/commit/7be929dff1537f3f86ddeb43fb37a3b8c9427d41))
* **swarm:** add role-based system prompt for spawned agents ([e020703](https://github.com/monotykamary/pi-messenger-swarm/commit/e020703da8e25fe34d8173c74caf9ae2cca1715e))
* **swarm:** pivot messenger to swarm-first orchestration ([5686cac](https://github.com/monotykamary/pi-messenger-swarm/commit/5686cacb4cb5281aa2774eb2b445231e37f73b29))


### Bug Fixes

* **crew:** respect crew.models config override for agent models ([47b3f25](https://github.com/monotykamary/pi-messenger-swarm/commit/47b3f25445e351d0b3360b9cc89069de83c48c37))
* **feed:** sanitize multiline previews to prevent overlay layout breakage ([d3fa74f](https://github.com/monotykamary/pi-messenger-swarm/commit/d3fa74fdc304e213789db2a3d013e7592eb8bdb0))
* **overlay:** clarify task progress icon in status bar ([bed6b3e](https://github.com/monotykamary/pi-messenger-swarm/commit/bed6b3e23f7b5a8f6015247dce2f30dc5a4a1abd))
* **overlay:** improve feed controls and task archiving UX ([c93bbea](https://github.com/monotykamary/pi-messenger-swarm/commit/c93bbea8f4cff06e594045772558d2b8bcbfd189))
* **overlay:** streamline swarm detail and expose full system prompt ([870742d](https://github.com/monotykamary/pi-messenger-swarm/commit/870742d45eb4ebe0e82ba4e9eabe8072c0473fae))
* **status:** format task summary label in messenger status ([ed5fa31](https://github.com/monotykamary/pi-messenger-swarm/commit/ed5fa318d1f262fe6d89425dc182234a850e73e1))
* **swarm:** humanize role labels in UI and system prompts ([41a74d9](https://github.com/monotykamary/pi-messenger-swarm/commit/41a74d9cd2ea8238c22156f173556a8a4c844567))


* **swarm:** remove legacy crew architecture and rename modules ([334a8cb](https://github.com/monotykamary/pi-messenger-swarm/commit/334a8cb7150ffccc5f192ce54792632efcf5d291))

# Changelog

All notable changes to this project will be documented in this file.

This changelog is managed by [standard-version](https://github.com/conventional-changelog/standard-version) from this point forward.

## [Unreleased]
