import { main } from "./main.js";
import { watchMain } from "./watch.js";

try {
  const argv = process.argv.slice(2);
  if (argv[0] === "watch") {
    await watchMain({ argv: argv.slice(1), stdout: process.stdout });
  } else {
    await main();
  }
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[snapper-mcp] fatal: ${message}\n`);
  process.exit(1);
}
