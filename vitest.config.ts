import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    testTimeout: 10_000,
    pool: "threads",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        // CLI entry — top-level await + try/catch wrapper around main().
        // Its behaviour is fully exercised by test/main.test.ts (subprocess)
        // and test/main.unit.test.ts (in-process); the 6-line glue here
        // is not meaningfully coverable by vitest's v8 instrumentation.
        "src/index.ts",
      ],
      thresholds: {
        // Lines stay at 100 — no dead code; every line runs somewhere
        // in the suite. Functions at 95 leaves a one-function buffer
        // for setTimeout/abort arrow callbacks whose only trigger is
        // a real 10s timer; exercising them via vi.advanceTimersByTime
        // leaks an "unhandled rejection" on CI across Node 22 runners
        // and is not worth fighting for a single anonymous arrow.
        // Statements at 99 leaves a one-line buffer for the build-time
        // __PKG_VERSION__ / __PKG_NAME__ default fallbacks that tsup's
        // define inlines at build. Branches at 90 leaves room for
        // `??` / `||` defaults on values always defined at runtime.
        lines: 100,
        functions: 95,
        statements: 99,
        branches: 90,
      },
    },
  },
});
