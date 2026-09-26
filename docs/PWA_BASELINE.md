# PWA-001 Baseline

## Repository identity

- Upstream repository: `https://github.com/stemlen/bloom-pdf-editor.git`
- Pinned upstream commit: `452c5ed39aa2818e6566ffffd5b5c298bdab1c80`
- Current branch: `pwa-v1`
- HEAD at baseline capture: `452c5ed39aa2818e6566ffffd5b5c298bdab1c80`

This document records the pre-refactor baseline. No product/server code was changed for PWA-001.

## Commands and results

Commands were run from the repository root unless noted.

| Command | Result |
| --- | --- |
| `npm ci` | **BLOCKED**: npm could not resolve `registry.npmjs.org` (`EAI_AGAIN`) while fetching `zustand-5.0.13.tgz`; the root `postinstall` therefore did not complete. |
| `npm ci` (retry) | **BLOCKED**: same registry DNS failure for `zustand-5.0.13.tgz`. |
| `npm ci` in `server/` | **BLOCKED**: same registry DNS failure while fetching `why-is-node-running-2.3.0.tgz`. |
| `npm test` | **NOT RUN**: dependency installation was incomplete; shell reported `vitest: Permission denied`. **0 tests executed; pass/fail counts unavailable.** |
| `npm run server:test` | **NOT RUN**: dependency installation was incomplete; shell reported `vitest: Permission denied`. **0 tests executed; pass/fail counts unavailable.** |
| `npm run build:next` | **BLOCKED** in its `npm run server:install` prerequisite by the same `EAI_AGAIN` registry failure. Next production build did not start. |
| `git diff --check` | Passed with no whitespace errors. |
| `git status --short --branch` | Clean except for this new baseline document before commit. |

The test and build gates could not produce test counts or a build result because the lockfile installs were blocked by the environment's registry DNS failure. No baseline/environment fix was applied because the failure is external to product behavior.

## Server-coupled surfaces

The current application remains coupled to the server conversion engine through:

- `/api/bloom/*`: Next route handlers for health, conversion, job status/cancellation, and downloads under `src/app/api/bloom/`.
- `bloom-api`: browser client in `src/lib/bloom-api.ts`, which calls the `/api/bloom/*` routes.
- `bloom-server`: server bridge in `src/lib/bloom-server.ts`, importing the compiled server entry point from `server/dist/lib-entry.js`.
- `server/`: the TypeScript document engine and its own lockfile/test suite; root scripts install and build it before the Next build.

These surfaces are intentionally unchanged by PWA-001.

## PWA-002/003 invariants

Future work must preserve:

- parser and content-stream editing;
- annotations;
- IndexedDB input/session behavior;
- `saveQuick` and `saveOptimized`;
- browser rendering and export.

