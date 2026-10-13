export type EditorKeyboardAction =
  | { type: 'undo' | 'redo' | 'search' | 'zoom-in' | 'zoom-out' | 'navigate-prev' | 'navigate-next' | 'validate-signatures' }
  | { type: 'tool'; tool: 'select' | 'text' | 'addtext' | 'highlight' | 'draw' | 'erase' | 'sign' | 'watermark' | 'security' }
  | { type: 'nudge'; target: 'embedded-image' | 'floating-image' | 'floating-text'; dx: number; dy: number }
  | { type: 'delete'; target: 'embedded-image' | 'floating-image' | 'floating-text' | 'signature' }
  | { type: 'escape-floating-text' }
  | null;

export interface EditorKeyboardContext {
  selectedDisplayItem: 'image' | 'path' | null;
  activeFloatingImage: boolean;
  activeFloatingText: boolean;
  selectedSignature: boolean;
  activeTool: string;
}

export interface EditorKeyboardEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Pure keyboard policy shared by the browser handler and unit tests. */
export function editorKeyboardAction(
  event: EditorKeyboardEvent,
  context: EditorKeyboardContext,
): EditorKeyboardAction {
  const modified = !!event.ctrlKey || !!event.metaKey || !!event.altKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (event.ctrlKey || event.metaKey) {
    if (key === 'z' && !event.shiftKey) return { type: 'undo' };
    if (key === 'y' || (key === 'z' && !!event.shiftKey)) return { type: 'redo' };
    if (key === 'f') return { type: 'search' };
    if ((key === '+' || key === '=') && !event.shiftKey) return { type: 'zoom-in' };
    if (key === '-') return { type: 'zoom-out' };
    return null;
  }

  if (event.altKey) return null;

  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
    const step = event.shiftKey ? 10 : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? step : key === 'ArrowDown' ? -step : 0;
    if (context.selectedDisplayItem === 'image') return { type: 'nudge', target: 'embedded-image', dx, dy };
    if (context.activeFloatingImage) return { type: 'nudge', target: 'floating-image', dx, dy };
    if (context.activeFloatingText) return { type: 'nudge', target: 'floating-text', dx, dy };
    return { type: key === 'ArrowLeft' || key === 'ArrowUp' ? 'navigate-prev' : 'navigate-next' };
  }

  if (key === 'Delete' || key === 'Backspace') {
    if (context.selectedSignature) return { type: 'delete', target: 'signature' };
    if (context.activeFloatingImage) return { type: 'delete', target: 'floating-image' };
    if (context.activeFloatingText) return { type: 'delete', target: 'floating-text' };
    if (context.selectedDisplayItem === 'image') return { type: 'delete', target: 'embedded-image' };
    return null;
  }

  if (key === 'Escape' && context.activeFloatingText) return { type: 'escape-floating-text' };

  // Shift+letter and all other modified letter shortcuts preserve native/editor semantics.
  if (modified || event.shiftKey) {
    if (key === 'v' && event.shiftKey && context.activeTool === 'sign') return { type: 'validate-signatures' };
    return null;
  }

  const tools: Record<string, Exclude<EditorKeyboardAction, null> & { type: 'tool' }> = {
    v: { type: 'tool', tool: 'select' }, t: { type: 'tool', tool: 'text' },
    a: { type: 'tool', tool: 'addtext' }, h: { type: 'tool', tool: 'highlight' },
    l: { type: 'tool', tool: 'text' }, d: { type: 'tool', tool: 'draw' },
    e: { type: 'tool', tool: 'erase' }, s: { type: 'tool', tool: 'sign' },
    w: { type: 'tool', tool: 'watermark' }, x: { type: 'tool', tool: 'security' },
  };
  return tools[key] ?? null;
}
