const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** Resolve a public asset without depending on the app or Next router internals. */
export function assetUrl(path: string): string {
  return `${basePath}/${path.replace(/^\/+/, '')}`;
}
