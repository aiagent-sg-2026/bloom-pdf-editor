import { describe, expect, it } from 'vitest';
import { initialFloatingTextSelection } from './floatingTextSelection';

describe('new floating text selection', () => {
  it('selects the entire initial placeholder so typing replaces it', () => {
    const text = 'New Text';
    const selection = initialFloatingTextSelection('new-box', 'new-box', text);
    expect(selection).toEqual([0, 8]);
    const [start, end] = selection!;
    expect(text.slice(0, start) + 'ABC 计算机科学 DEF' + text.slice(end)).toBe('ABC 计算机科学 DEF');
  });

  it('leaves existing boxes alone, even when their text is New Text', () => {
    expect(initialFloatingTextSelection('new-box', 'existing-box', 'New Text')).toBeNull();
    expect(initialFloatingTextSelection(null, 'existing-box', 'User text')).toBeNull();
  });

  it('does not reselect an originally new box after its creation selection is consumed', () => {
    expect(initialFloatingTextSelection(null, 'new-box', 'New Text')).toBeNull();
    expect(initialFloatingTextSelection(null, 'new-box', '计算机科学')).toBeNull();
  });
});
