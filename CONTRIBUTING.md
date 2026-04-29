# Contributing to @mateusz-klatt/snapper-mcp

Thanks for your interest. This package is a public-facing bridge — quality bar is high.

## Dev setup

```bash
# 1. Clone + install (postinstall hooks include `simple-git-hooks` setup).
git clone https://github.com/mateusz-klatt/snapper-mcp.git
cd snapper-mcp
npm install

# 2. Verify the toolchain.
npm run build
npm run lint
npm run typecheck
npm run stdout-gate
npm test
```

Minimum Node version is `>=22.0.0` (matches Claude Desktop's embedded Node and vitest 4's `node:util` usage).

## Integration test against a local Snapper instance

```bash
# In a separate terminal, boot a local Snapper backend (e.g. via `make dev-backend` in your Snapper deployment).
make dev-backend

# Back here, run the manual integration test.
# The test is NOT in the default CI gate — it requires a live local backend.
SNAPPER_BASE_URL=http://localhost:8000/api/mcp \
  SNAPPER_ACCESS_TOKEN=$(...) \
  SNAPPER_REFRESH_TOKEN=$(...) \
  npx vitest run test/integration
```

Generate tokens via the Snapper UI's AI Delegates wizard.

## Pre-commit hook

`simple-git-hooks` wires a `pre-commit` hook on `npm install`. The hook runs
[`gitleaks`](https://github.com/gitleaks/gitleaks) against staged files.

If you ever need to skip it (e.g. while debugging a hook regression), use
`git commit --no-verify` and include a justification in the commit message.
Do not make skipping a habit — the hook catches leaks before they reach the
public repo.

## Public-repo hygiene — MUST READ

- **Zero secrets / real IDs.** No real JWTs, wallet/operator/user IDs. Use
  `jwt-placeholder`, `wallet-demo-01`, etc. — these are allowlisted in
  `.gitleaks.toml`.
- **No paste from upstream private modules.** This repo is MIT-licensed
  and public on GitHub + published on npm. Keep it vendor-neutral.
- **`.env.example` only.** Never commit a real `.env`.
- **Reviewer pair is expected for non-trivial changes** — at minimum
  one human reviewer plus one model-assisted review pass before merge.

The PR template embeds a hygiene checklist; please honour it.

## Logging discipline

MCP stdio uses **stdin/stdout for protocol traffic**. Any byte written to stdout
outside of a valid JSON-RPC frame corrupts the stream and Claude Desktop
disconnects.

- Every log line goes to **stderr** via `process.stderr.write` or
  `console.error`.
- `eslint`'s `no-console` rule allows only `console.error` and `console.warn`.
- The `stdout-gate` npm script (a small cross-platform Node scanner
  under `scripts/stdout-gate.mjs`) walks `src/` for forbidden patterns;
  CI enforces it.
- A runtime stdout-hijack test in CI asserts every stdout line from the
  subprocess parses as JSON-RPC.

## Releasing

Releases are via `workflow_dispatch` from the Actions tab — never on tag push.
See `.github/workflows/publish.yml` for the full guardrail set.
