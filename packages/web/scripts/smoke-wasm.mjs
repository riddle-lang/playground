import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import init, * as wasm from '../public/wasm/riddle_compiler_wasm.js';

const binary = await readFile(
  new URL('../public/wasm/riddle_compiler_wasm_bg.wasm', import.meta.url),
);
await init({ module_or_path: binary });

const source = 'fun main() {\n    let answer = 42;\n}\n';
assert.equal(wasm.riddle_check(source).success, true);
const [token] = wasm.riddle_semantic_tokens(source);
assert.equal(typeof token.deltaLine, 'number');
assert.equal(typeof token.tokenType, 'number');
const hint = wasm.riddle_inlay_hints(source).find((item) => item.label.includes('i32'));
assert.equal(typeof hint.line, 'number');
assert.equal(typeof hint.character, 'number');

const completionSource = 'fun main() {\n    ret\n}\n';
const completion = wasm.riddle_completions(completionSource, 1, 7)
  .find((item) => item.label === 'return');
assert.equal(typeof completion.kind, 'number');

console.log('riddle-lsp WASM smoke check passed');
