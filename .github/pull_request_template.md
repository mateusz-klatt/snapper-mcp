<!-- Thanks for your contribution. Please run through the checklist before requesting review. -->

## Summary

<!-- 1-2 sentences on what changes and why. -->

## Public-repo hygiene checklist (MUST tick before merge)

- [ ] No real Snapper IDs (`wallet_public_id`, `operator_public_id`, `user_public_id`) in this PR.
- [ ] No real JWT / API keys / passwords in this PR — ran `gitleaks protect --staged -v --config=.gitleaks.toml` locally.
- [ ] No paste from proprietary Snapper-core modules (`src/snapper/application/*`, `proprietary/*`).
- [ ] `.env.example` remains the only committed env file.
- [ ] Pre-commit hook ran (or I manually ran `gitleaks protect --staged` and reviewed output).

## Quality gate checklist

- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run stdout-gate` passes — no forbidden stdout patterns in `src/`.
- [ ] `npm run build` produces `dist/index.js` with `#!/usr/bin/env node` shebang on line 1.
- [ ] `npm test` passes (vitest).
- [ ] CI matrix green across Node 18 / 20 / 22 × ubuntu / macos / windows.

## Additional notes

<!-- Breaking changes? Deprecations? Upstream dependency bumps? -->
