# GitHub Pages demo

1. In repository **Settings > Pages**, set **Source** to **GitHub Actions**. Private repositories require a paid GitHub plan with Pages support; check access settings before publishing a demo.
2. Push to `main`, or run **Deploy GitHub Pages** from the Actions tab. The workflow builds, verifies, and deploys `out/` to `https://<owner>.github.io/<repo>/`.

The workflow sets `NEXT_PUBLIC_BASE_PATH=/<repo>` at build time. For a repository named `<owner>.github.io`, it uses an empty base path and deploys at the site root. Changing the prefix requires rebuilding.

After `deploy`, the `smoke` job runs `scripts/smoke-pages.sh` with the deploy job's `page_url` output. It requires HTTP 200 for the site root, `editor/`, `icon.png`, and `brand/paperloom-logo.svg`, retrying curl failures for up to approximately two minutes per URL while Pages becomes available. A failed request or non-200 response fails the job with the affected URL and HTTP status.

Always use `npm run build` (`next build --webpack`). Plain `next build` uses Turbopack and can emit an unusable PDF worker; see [PDF_WORKER.md](PDF_WORKER.md).

## Local sub-path simulation

Use Node.js 22 and run from the repository root:

```bash
npm ci
NEXT_PUBLIC_BASE_PATH=/bloom-pdf-editor npm run build
npm run verify:pdf-worker
npm run verify:browser-only
npm run verify:browser-core
NEXT_PUBLIC_BASE_PATH=/bloom-pdf-editor npm run verify:base-path
```

Serve the export under the same prefix, not directly at the server root. For example, stage it in a temporary directory and use a static HTTP server:

```bash
demo_dir=$(mktemp -d)
cp -R out "$demo_dir/bloom-pdf-editor"
python3 -m http.server 8080 --directory "$demo_dir"
```

Open `http://localhost:8080/bloom-pdf-editor/`. Upload a disposable PDF, open the editor, and export text using a bundled font to check lazy asset loading. Stop the server and remove the temporary directory when finished.

`verify:base-path` scans the built `out/` HTML and JavaScript for unprefixed root `/fonts/` and `/brand/` URL literals, including escaped URLs. Set `NEXT_PUBLIC_BASE_PATH` to the same value used for the build. Missing or empty output fails the check; an empty base path skips it. This is a literal-URL guard, not a browser navigation test or an evaluator of arbitrary computed URLs. CI checks both root and `/bloom-pdf-editor` exports.

The bundled fonts total approximately **27 MB**. They are fetched lazily when needed, not downloaded on the initial page load.
