#!/usr/bin/env node
// Backs up the phone-remote PWA source as a timestamped tar.gz archive,
// skipping generated and bulky files (build output, dependencies,
// editor/OS noise) that can be regenerated or are not project content.
// Mirrors `Desktop/scripts/backup.mjs`.
//
// Usage:  pnpm backup [destDir]
// Env:    PHONE_REMOTE_BACKUP_DIR overrides the destination directory.
// Default destination is ../backups next to the phone-remote project.

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const destRoot = path.resolve(
  process.argv[2] ??
    process.env.PHONE_REMOTE_BACKUP_DIR ??
    path.join(projectRoot, "..", "backups"),
);

if (destRoot === projectRoot || destRoot.startsWith(projectRoot + path.sep)) {
  console.error(
    "Backup destination must be outside the phone-remote folder so the archive never contains itself.",
  );
  process.exit(1);
}

// Anything that can be rebuilt or regenerated is not backup material:
// - node_modules   is reproducible from pnpm-lock.yaml
// - build          is the static site output of `pnpm build` (adapter-static)
// - .svelte-kit    is SvelteKit's generated dev/cache directory
// - graphify-out   is regenerable tool output, not app source
// - editor/OS noise adds nothing
const EXCLUDED = [
  ".DS_Store",
  ".git",
  ".idea",
  ".vscode",
  "*.local",
  "*.log",
  ".svelte-kit",
  "build",
  "graphify-out",
  "logs",
  "node_modules",
];

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);
const archivePath = path.join(destRoot, `phone-remote-${timestamp}.tar.gz`);

mkdirSync(destRoot, { recursive: true });

const args = ["-czf", archivePath, "-C", projectRoot, "--exclude-vcs"];
for (const pattern of EXCLUDED) args.push("--exclude", pattern);
args.push(".");

try {
  execFileSync("tar", args, { stdio: "inherit" });
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
}

const size = statSync(archivePath).size;
const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean).length;

console.log(
  `Created ${archivePath} (${(size / 1024 / 1024).toFixed(2)} MB, ${entries} entries).`,
);
