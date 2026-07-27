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

const diagnosticSource = `// 中文
struct Point { value: i32 }
fun main() {
    let point = Point { value: 1 };
    let moved = point;
    let reused = point;
}
`;
const diagnostic = wasm.riddle_check(diagnosticSource).diagnostics
  .find((item) => item.code === 'E0100');
const expectedStart = diagnosticSource.lastIndexOf('point;');
assert.equal(diagnostic.start, expectedStart);
assert.equal(diagnostic.end, expectedStart + 'point'.length);
assert.equal(diagnostic.startLine, 5);
assert.equal(diagnostic.startCharacter, 17);
assert.equal(diagnostic.endLine, 5);
assert.equal(diagnostic.endCharacter, 22);

console.log('riddle-lsp WASM smoke check passed');
