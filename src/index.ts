import { main } from "./main.js";

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[snapper-mcp] fatal: ${message}\n`);
  process.exit(1);
}
