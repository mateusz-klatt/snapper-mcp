import { checkMain } from "./check.js";
import { doctorMain } from "./doctor.js";
import { hookMain } from "./hook.js";
import { integrateMain } from "./integrate.js";
import { writeStderr } from "./logger.js";
import { main } from "./main.js";
import { watchMain } from "./watch.js";

try {
  const argv = process.argv.slice(2);
  if (argv[0] === "watch") {
    await watchMain({ argv: argv.slice(1), stdout: process.stdout });
  } else if (argv[0] === "check") {
    const code = await checkMain({ argv: argv.slice(1) });
    process.exit(code);
  } else if (argv[0] === "integrate") {
    const code = await integrateMain({ argv: argv.slice(1), stdout: process.stdout });
    process.exit(code);
  } else if (argv[0] === "doctor") {
    const code = await doctorMain({ argv: argv.slice(1), stdout: process.stdout });
    process.exit(code);
  } else if (argv[0] === "hook") {
    await hookMain({
      argv: argv.slice(1),
      stdin: process.stdin,
      stdout: process.stdout,
    });
    process.exit(0);
  } else {
    await main({ argv });
  }
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  writeStderr(`[snapper-mcp] fatal: ${message}\n`);
  process.exit(1);
}
