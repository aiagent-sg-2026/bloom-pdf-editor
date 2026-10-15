export const STORAGE_KEY = 'pdf-editor-theme';

export function resolveInitialTheme(stored: string | null): 'light' | 'dark' {
  return stored === 'light' || stored === 'dark' ? stored : 'light';
}
