#!/usr/bin/env node
// PreToolUse hook: block `git commit` when manifest.json / package.json /
// versions.json versions are out of sync, or when main.js is stale relative
// to main.ts. Allows other Bash commands through.
//
// Exit codes per Claude Code hook protocol:
//   0  → allow tool call
//   2  → block tool call; stderr is fed back to Claude
//   any other non-zero → non-blocking error
//
// All subprocess invocations use spawnSync with an args array (no shell), so
// arguments are never interpolated into a shell command line.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: projectDir, encoding: "utf8" });

const gitOk = (args) => run("git", args).status === 0;
const gitOut = (args) => {
  const r = run("git", args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
};

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const cmd = payload?.tool_input?.command ?? "";

// Only inspect git commit invocations. Match `git commit` as a whole word so
// `git commit-tree`, `echo 'git commit'`, etc. pass through.
if (!/(^|[\s;&|`(])git\s+commit(\s|$)/.test(cmd)) {
  process.exit(0);
}

if (/--no-verify\b|(^|\s)-n(\s|$)/.test(cmd)) {
  console.error(
    "Refusing `git commit --no-verify` in this repo. Pre-commit checks must run. " +
    "If a check is wrong, fix the hook in .claude/hooks/check-version-sync.mjs.",
  );
  process.exit(2);
}

const read = (rel) => {
  const p = path.join(projectDir, rel);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

let manifest, pkg, versions;
try {
  manifest = read("manifest.json");
  pkg = read("package.json");
  versions = read("versions.json");
} catch (err) {
  console.error(`Pre-commit hook could not read a file: ${err.message}`);
  process.exit(2);
}

const errors = [];

// --- version sync ---------------------------------------------------------

if (manifest.version !== pkg.version) {
  errors.push(
    `manifest.json version (${manifest.version}) !== package.json version (${pkg.version})`,
  );
}

if (!Object.prototype.hasOwnProperty.call(versions, manifest.version)) {
  errors.push(
    `versions.json is missing an entry for ${manifest.version}. ` +
    `Add "${manifest.version}": "${manifest.minAppVersion}" (or the appropriate minAppVersion).`,
  );
} else if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(
    `versions.json["${manifest.version}"] = ${versions[manifest.version]} ` +
    `but manifest.json minAppVersion = ${manifest.minAppVersion}. ` +
    `Reconcile them (usually by updating versions.json).`,
  );
}

// --- main.js staleness ----------------------------------------------------
//
// Rules:
//   1. If main.ts is staged, main.js must also be staged.
//   2. If both are staged AND main.ts has no unstaged edits, run a fresh
//      build and verify the staged main.js byte-matches it. If main.ts has
//      unstaged edits, we can't reliably check (build runs on the working
//      tree, not the index) — warn but don't block.

let staged = [];
try {
  staged = gitOut(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
} catch (err) {
  errors.push(`Could not read staged files: ${err.message}`);
}

const tsStaged = staged.includes("main.ts");
const jsStaged = staged.includes("main.js");

if (tsStaged && !jsStaged) {
  errors.push(
    "main.ts is staged but main.js is not. Run `npm run build` and `git add main.js` " +
    "so the committed bundle reflects the committed source.",
  );
}

if (tsStaged && jsStaged) {
  const mainTsClean = gitOk(["diff", "--quiet", "--", "main.ts"]);

  if (!mainTsClean) {
    console.error(
      "Note: main.ts has unstaged edits, so the strict build comparison was skipped. " +
      "Verify manually that the staged main.js matches the staged main.ts.",
    );
  } else {
    const build = run("npm", ["run", "build"]);
    if (build.status !== 0) {
      errors.push(
        `\`npm run build\` failed (exit ${build.status}). Output:\n${build.stderr || build.stdout}`,
      );
    } else {
      // After a fresh build, working-tree main.js is the source-of-truth bundle.
      // If staged main.js matches working-tree main.js, `git diff` is empty.
      const fresh = gitOk(["diff", "--quiet", "--", "main.js"]);
      if (!fresh) {
        errors.push(
          "Staged main.js does not match a fresh build of main.ts. " +
          "Run `npm run build && git add main.js` and try the commit again.",
        );
      }
    }
  }
}

if (errors.length) {
  console.error("Pre-commit checks failed:\n  - " + errors.join("\n  - "));
  console.error(
    "\nFix the issue(s), re-stage the affected files, and try the commit again. " +
    "See CLAUDE.md → 'Before every commit'.",
  );
  process.exit(2);
}

process.exit(0);
