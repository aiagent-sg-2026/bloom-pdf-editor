# Engine entrypoints

`src/engine/index.ts` is the broad compatibility and test API. The browser
product under `src/app` and `src/lib` must import from
`src/engine/browser-core.ts` instead. `browser-core.ts` is an explicit
allowlist boundary for the APIs actually used by the browser product; add new
exports there deliberately when product code needs them.
