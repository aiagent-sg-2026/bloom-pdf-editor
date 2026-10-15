import { describe, expect, it } from 'vitest';
import { resolveInitialTheme } from './initialTheme';

describe('resolveInitialTheme', () => {
  it.each([null, '', 'invalid', 'system', 'DARK'])('defaults to light for %j', (stored) => {
    expect(resolveInitialTheme(stored)).toBe('light');
  });

  it.each(['dark', 'light'] as const)('respects a stored %s preference', (stored) => {
    expect(resolveInitialTheme(stored)).toBe(stored);
  });
});
