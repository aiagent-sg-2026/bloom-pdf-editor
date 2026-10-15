import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SCRIPT_FONTS, type ShapingFontId, type ScriptFontId } from '../fonts/script-fonts';

export const shapingCases: readonly { id: ShapingFontId; text: string }[] = [
  { id: 'thai', text: 'สวัสดีครับ ภาษาไทย' },
  { id: 'devanagari', text: 'नमस्ते दुनिया क्षत्रिय' },
  { id: 'bengali', text: 'বাংলা ভাষা' },
  { id: 'tamil', text: 'தமிழ் மொழி' },
  { id: 'telugu', text: 'తెలుగు భాష' },
  { id: 'kannada', text: 'ಕನ್ನಡ ಭಾಷೆ' },
  { id: 'malayalam', text: 'മലയാളം ഭാഷ' },
  { id: 'gujarati', text: 'ગુજરાતી ભાષા' },
  { id: 'gurmukhi', text: 'ਪੰਜਾਬੀ ਭਾਸ਼ਾ' },
];
const sources: Partial<Record<ScriptFontId, Uint8Array>> = {};
export function shapingFontBytes(id: ScriptFontId): Uint8Array {
  return sources[id] ??= new Uint8Array(readFileSync(new URL(`../../../public/fonts/${basename(SCRIPT_FONTS[id].assetPath)}`, import.meta.url)));
}
