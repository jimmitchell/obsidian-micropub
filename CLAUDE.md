# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A single-file Obsidian community plugin that publishes the active note to a
Micropub endpoint as an `h-entry`, uploading embedded images along the way.
Source lives in [main.ts](main.ts); [main.js](main.js) is the bundled artifact
shipped to users. Built and primarily tested against
[clodd-cms](https://github.com/jimmitchell/clodd-cms)'s `micropub.php`.

`isDesktopOnly` is `false` in [manifest.json](manifest.json). Anything you reach
for that's desktop-only (Node `fs`, `child_process`, `path`, raw `require`)
breaks mobile installs — flag it before using it.

## Before every commit

This repo has a PreToolUse hook in
[.claude/settings.json](.claude/settings.json) that blocks `git commit` if any
of the version checks below fail. Treat the checklist as the canonical list,
and don't bypass the hook with `--no-verify`.

1. **Versions in lockstep.** [manifest.json](manifest.json) `version`,
   [package.json](package.json) `version`, and a key in
   [versions.json](versions.json) must all match.
2. **`versions.json` maps version → minAppVersion.** Obsidian's plugin loader
   reads this for compatibility. New entries should use the current
   `manifest.json.minAppVersion` unless you're intentionally raising it.
3. **Bump policy** (semver, user-visible behavior):
   - **patch** — bug fixes, error-message tweaks, no surface change.
   - **minor** — new command, new setting, new frontmatter key, new optional
     Micropub feature.
   - **major** — removed/renamed setting, vault-layout assumption change,
     anything that breaks an existing user's working configuration.
   - Pure docs / `.claude/` / CI changes don't require a bump — but the three
     version fields must still agree.
4. **Rebuild [main.js](main.js).** Run `npm run build` and commit the result.
   Obsidian installs the artifact directly; un-rebuilt `main.js` ships stale
   code. If you changed [main.ts](main.ts), `main.js` should be in the same
   commit.
5. **README in sync.** If you added/changed a command, setting, frontmatter
   key, or limitation, update [README.md](README.md). The "Limitations" section
   should reflect the current version.
6. **Don't touch `manifest.json.id`.** Renaming it after release breaks every
   existing install.

## Code shape

- One file: [main.ts](main.ts). Don't propose splitting into `src/` without
  asking — the bundle stays trivial and reviewable as long as it's one file.
- Bundle with [esbuild.config.mjs](esbuild.config.mjs) via `npm run build`
  (production) or `npm run dev` (watch).
- No runtime dependencies beyond `obsidian` (peer). Every `dependencies` entry
  ships to users in `main.js` — push back hard before adding one.

## Micropub assumptions worth knowing

- Auth is a static bearer token. IndieAuth is **not** implemented; don't
  scaffold it speculatively.
- Photos currently POST to the main endpoint as `file` (multipart). A separate
  `media-endpoint` discovered via `q=config` is **not** yet routed to.
- Updates send `replace` only — no per-property `add`/`delete` ops are
  exposed.
- On update, the original `published` date is preserved server-side;
  `published:` in frontmatter is honored only for new posts.

If you change any of these, update both [README.md](README.md) "Limitations"
and bump the minor version.

## What not to do

- Don't add `dependencies` (devDependencies for build tooling are fine).
- Don't introduce platform-specific Node APIs without gating on
  `Platform.isDesktopApp`.
- Don't reformat [main.ts](main.ts) wholesale alongside a behavior change —
  keep diffs reviewable.
- Don't `git commit --no-verify` to skip the version-check hook. If it's
  blocking you, fix the underlying drift.
