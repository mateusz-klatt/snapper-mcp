#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const FORBIDDEN = /console\.(log|info|debug|dir|trace|group)|process\.stdout/;
const SRC_DIR = resolve(process.argv[2] ?? "src");

/*
 * Paths (relative to SRC_DIR, posix slashes) where `process.stdout`
 * is the legitimate output channel — NOT the JSON-RPC stream of the
 * proxy bridge:
 *
 *   - index.ts — entry shim that dispatches subcommands; the watch
 *     subcommand needs the real stdout reference.
 *   - watch.ts — emits JSONL frames to the Claude Code Monitor
 *     primitive; stdout is the documented contract for that flow.
 *
 * The allowlist is keyed by relative path rather than basename so a
 * future `src/foo/watch.ts` cannot accidentally inherit the
 * exemption. `console.*` is still forbidden everywhere — there is no
 * legitimate use of those methods, and the logger module is the
 * single source of stderr writes.
 */
const STDOUT_ALLOWLIST = new Set(["index.ts", "watch.ts"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const hits = [];
for await (const file of walk(SRC_DIR)) {
  const relPath = relative(SRC_DIR, file).split("\\").join("/");
  const allowStdout = STDOUT_ALLOWLIST.has(relPath);
  const pattern = allowStdout
    ? /console\.(log|info|debug|dir|trace|group)/
    : FORBIDDEN;
  const contents = await readFile(file, "utf8");
  contents.split(/\r?\n/).forEach((line, index) => {
    if (pattern.test(line)) {
      hits.push({ file, line: index + 1, text: line.trim() });
    }
  });
}

if (hits.length > 0) {
  for (const hit of hits) {
    process.stderr.write(`${hit.file}:${hit.line}: ${hit.text}\n`);
  }
  process.stderr.write(
    `\nstdout-gate: ${hits.length} forbidden stdout-writing call(s) in ${SRC_DIR}.\n` +
      "Bridge stdout is reserved for JSON-RPC frames. Use the stderr logger (src/logger.ts) instead.\n",
  );
  process.exit(1);
}
