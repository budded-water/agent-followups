import { StringDecoder } from 'node:string_decoder';
import { MAX_JSON_BYTES } from './io.js';

// One bounded object at a time. Validate the entire array, including its closing
// bracket and trailing bytes, before the caller can authorize an external write.
export function jsonObjectArray(consume: (value: unknown) => void) {
  const decoder = new StringDecoder('utf8');
  let state: 'start' | 'first' | 'next' | 'object' | 'separator' | 'end' = 'start';
  let depth = 0, quoted = false, escaped = false, bytes = 0;
  let parts: string[] = [];
  function append(text: string) {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_JSON_BYTES) throw new Error('JSON array item exceeded limit');
    parts.push(text);
  }
  function text(input: string) {
    let start = state === 'object' ? 0 : -1;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      if (state === 'object') {
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
        if (depth === 0) {
          append(input.slice(start, i + 1)); start = -1;
          consume(JSON.parse(parts.join(''))); parts = []; bytes = 0;
          state = 'separator';
        }
        continue;
      }
      if (/^[\t\n\r ]$/.test(ch)) continue;
      if (state === 'start' && ch === '[') state = 'first';
      else if ((state === 'first' || state === 'next') && ch === '{') {
        state = 'object'; start = i; depth = 1; quoted = false; escaped = false;
      } else if ((state === 'first' || state === 'separator') && ch === ']') state = 'end';
      else if (state === 'separator' && ch === ',') state = 'next';
      else throw new Error('Invalid JSON object array');
    }
    if (start !== -1) append(input.slice(start));
  }
  return {
    push(chunk: Buffer) { text(decoder.write(chunk)); },
    finish() { text(decoder.end()); if (state !== 'end') throw new Error('Incomplete JSON object array'); },
  };
}
