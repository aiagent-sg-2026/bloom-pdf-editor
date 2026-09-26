# Contributing to Bloom PDF Editor

Thank you for considering contributing to Bloom. Contributions are welcome for the browser editor, PDF engine, documentation, tests, and accessibility.

## Getting Started

```bash
git clone https://github.com/<your-username>/bloom-pdf-editor.git
cd bloom-pdf-editor
npm install
npm run dev
```

### Available Scripts

| Command | What It Does |
|---------|-------------|
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the static export into `out/` |
| `npm test` | Run client engine tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint |
| `npm run verify:browser-only` | Check for server-runtime regressions |

## Project Structure

- `src/engine/` — browser-native PDF parser, renderer, editor, annotations, forms, and writer
- `src/app/` — Next.js application and editor UI
- `src/lib/pdfStorage.ts` — IndexedDB document persistence
- `docs/` — engine documentation

The application runtime is browser-only. Production builds are static exports in `out/`; do not add server conversion routes or packages that require a server runtime.

Keep browser behavior local and preserve the engine boundaries. Changes must not bypass native content-stream editing, annotations, forms, page operations, PDF save paths, renderer behavior, or IndexedDB storage without a focused design discussion.

## Code Style

- Use strict TypeScript and explicit exported types.
- Prefer immutable data and avoid `any`; use `unknown` with narrowing.
- Use `kebab-case` filenames and descriptive names.
- Add tests beside the code they cover where practical.

## Testing and Review

Before opening a pull request, run:

```bash
npm test
npm run lint
npm run build
npm run verify:browser-only
```

Document behavior changes and preserve existing attribution. Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0. See [LICENSE](LICENSE).
