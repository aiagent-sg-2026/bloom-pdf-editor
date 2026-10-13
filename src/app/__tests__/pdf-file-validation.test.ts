import { describe, expect, it } from 'vitest';
import { isPdfFile } from '../pdf-file-validation';

describe('isPdfFile', () => {
  it('accepts a PDF by its header when metadata has no type or extension', () => {
    expect(isPdfFile('download', '', new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
  });

  it('accepts case-insensitive PDF extensions and rejects mislabeled content', () => {
    expect(isPdfFile('FORM.PDF', '', new Uint8Array())).toBe(true);
    expect(isPdfFile('photo.jpg', 'image/jpeg', new TextEncoder().encode('%PDF-'))).toBe(true);
    expect(isPdfFile('photo.jpg', 'image/jpeg', new TextEncoder().encode('\xff\xd8\xff'))).toBe(false);
    expect(isPdfFile('notes.txt', 'text/plain', new TextEncoder().encode('hello'))).toBe(false);
  });
});
