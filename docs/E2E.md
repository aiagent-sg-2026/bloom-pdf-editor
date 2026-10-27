# End-user stories

The Playwright suite exercises the built static export in Chromium, headlessly.
It does not start the Next.js development server or call editor internals.
Vitest excludes `e2e/**`; existing unit tests continue to run with `npm test`.

## Run locally

Use Node.js 22:

```sh
npm ci
npx playwright install --with-deps chromium
# Debian/Ubuntu; macOS: brew install poppler
sudo apt-get install poppler-utils
npm run build
npm run test:e2e
```

`npm run test:e2e` runs `pretest:e2e` to generate three synthetic PDFs, starts
the tiny static server when needed, and runs the stories. Playwright also runs
`e2e/global-setup.ts` before any story, so direct `npx playwright test` invocations
and runs against an existing or remote server generate fixtures too. Both entry
points run `e2e/fixtures/make-fixtures.mjs`; generation overwrites the same files
and is safe to repeat. Run `npm run test:e2e` locally; this project does not use GitHub Actions for E2E.

The suite does not build the application. Rebuild after production changes.
Generated PDFs, downloads, screenshots, traces, and reports are ignored by Git.
Never add real customer documents, invoices, purchase orders, signatures, or
personal data to fixtures or artifacts.

The fixtures are generated with the existing `pdf-lib` and `@pdf-lib/upng`
dependencies: a two-page letter document, a raster illustration, and an AcroForm
text field. The signature story types an invented demonstration mark.
The `.mjs` generator loads `@pdf-lib/upng` through `createRequire` and reads its
CommonJS `default` export explicitly; Node's ESM default import is the wrapper,
not the encoder.

```sh
npm run test:e2e -- e2e/stories/images.spec.ts
npm run test:e2e -- --headed
npm run test:e2e -- --trace on
npx playwright show-report
npx playwright show-trace test-results/<test-directory>/trace.zip
```

Traces are recorded on the first retry; local retries default to zero. Use
`--trace on` for a local first-attempt trace. Failed runs leave the HTML report
and `test-results/` (traces, failure screenshots, exported synthetic PDFs) on
disk. Install Poppler (`poppler-utils`) locally so export assertions do not skip.

`pdf-lib` reads page boxes, rotation, AcroForm `/V`, and image placement operators
(including Form XObjects) independently of the app. `pdftotext` checks visible
text appearances and password opening. `pdftoppm` checks rendered pixel equality
across annotation/undo transitions, rather than unstable serialized PDF bytes.
If a required Poppler executable is missing, affected stories skip with an
explicit installation message; other stories still run. PDF parsing, download,
and Poppler processing errors are failures, not skips.

### Base paths and other servers

Default URL: `http://127.0.0.1:4173/`. The URL must point to the application root,
not `/editor/`. Its trailing slash is normalized by the Playwright configuration.
The server removes the mount prefix before resolving files inside `out/`,
serves directory `index.html` files, and supplies JavaScript/worker/font MIME
types. It does not implement an SPA fallback that could hide missing assets.

Build and serve with the same base path:

```sh
NEXT_PUBLIC_BASE_PATH=/paperloom npm run build
NEXT_PUBLIC_BASE_PATH=/paperloom npm run test:e2e
# Equivalent explicit URL (also selects the local server port and mount point):
E2E_BASE_URL=http://127.0.0.1:4180/paperloom/ npm run test:e2e
```

For manual inspection:

```sh
E2E_BASE_URL=http://127.0.0.1:4180/paperloom/ npm run test:e2e:serve
```

Loopback URLs use Playwright's managed static server; a running local server
may be reused locally. Non-loopback `E2E_BASE_URL` values use the already
hosted static site, with no local server startup. Only use a site you control
and synthetic data.

## Add a story

1. Add `e2e/stories/<user-goal>.spec.ts` with an English header:

   ```ts
   /**
    * Persona: who is using the editor.
    * Goal: the concrete outcome they need.
    * Steps: the mouse/keyboard actions, in order.
    * Assertions: the visible and exported evidence that proves the outcome.
    */
   ```

2. Reuse `openPdf`, `download`, and geometry helpers from `e2e/helpers/ui.ts`.
   For encrypted exports use `uploadPdf`, enter the password, then
   `waitForEditor`. Keep exports in `testInfo.outputPath`; `download` also
   attaches them to the report.
3. Act through visible controls, real mouse/keyboard input, or file inputs.
   Prefer roles, accessible names, titles, and existing `data-handle` attributes.
   Read the component before choosing a selector. Add production `data-testid`
   only when no durable user-facing selector exists. Do not use `force`,
   synthetic dispatched drag events, engine calls, injected app state, or storage
   seeding. Read-only DOM geometry, selection inspection, screenshots, and
   `document.elementsFromPoint` are allowed observations.
4. Assert a consumer-visible outcome in the downloaded PDF as well as the UI
   where relevant. Rendered hashes prove undo equivalence; raw file hashes do
   not. For image placement compare PDF-point bounds with a rounding tolerance.
5. Run the focused story against a fresh static build, then the complete suite.

## Flake policy

- No sleeps or `waitForTimeout`. Wait for locators, enabled controls, download
  events, and `expect.poll` on observed state. Register download/dialog listeners
  before clicking their triggers.
  For edits that re-render the PDF, use `renderAfter` to observe replacement of
  the old canvas before checking editor readiness. A hidden `Rendering...` badge
  alone does not prove that an asynchronous commit has completed.
- Every story gets its own browser context. No shared mutable documents,
  dependence on test order, external network services, or golden screenshots
  tied to a particular workstation.
- Keep coordinates in synthetic PDF points and derive screen positions from
  the current canvas; do not hard-code screen pixels for document locations.
- A retry is diagnostic evidence, not a fix. Inspect the trace and fix the
  synchronization or application defect. Do not increase retry counts or hide
  assertions to make a run pass.
- An unsupported or genuinely unstable story stays in the suite as
  `test.fixme` with a one-line reason and its intended scenario. Remove the
  marker when the behavior can actually be exercised and verified.

### Known limitations

The Security and signature-dialog layering subcases are `test.fixme` because
`EmbeddedImageOverlay` in `src/app/editor/page.tsx` only mounts in Select mode.
Opening either tool unmounts the frame, handles, and Replace toolbar, so their
coexistence/occlusion cannot be asserted through the current UI. The Export
layering subcase is active and checks all ten control hit stacks against its
drawer/backdrop. No production behavior was changed to manufacture coexistence.
