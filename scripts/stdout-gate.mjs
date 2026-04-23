#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const FORBIDDEN = /console\.(log|info|debug|dir|trace|group)|process\.stdout/;
const SRC_DIR = resolve(process.argv[2] ?? "src");

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
  const contents = await readFile(file, "utf8");
  contents.split(/\r?\n/).forEach((line, index) => {
    if (FORBIDDEN.test(line)) {
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
