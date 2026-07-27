// Wrapper around the WASM compiler module.
// The WASM artifacts live in public/wasm/ and are served statically.
// wasm-pack --target web produces:
//   riddle_compiler_wasm.js       (ES module glue)
//   riddle_compiler_wasm_bg.wasm  (binary)

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'note' | 'help';
  message: string;
  start: number;
  end: number;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  code?: string;
}

export interface CompileOutput {
  success: boolean;
  diagnostics: Diagnostic[];
  c_source?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasm: any = null;
let loading: Promise<void> | null = null;

export async function loadCompiler(): Promise<void> {
  if (wasm) return;
  if (loading) return loading;

  loading = (async () => {
    // webpackIgnore keeps Next.js from trying to bundle the WASM glue.
    // webpackIgnore keeps Next.js from bundling the WASM glue.
    // We alias `module` to avoid the next/no-assign-module-variable lint rule.
    const wasmModule = await import(
      /* webpackIgnore: true */ `${BASE}/wasm/riddle_compiler_wasm.js`
    );
    await wasmModule.default({
      module_or_path: `${BASE}/wasm/riddle_compiler_wasm_bg.wasm`,
    });
    wasm = wasmModule;
    // Expose globally so riddleExtension.ts can call WASM functions
    // without re-importing (avoids circular imports).
    (globalThis as Record<string, unknown>).__riddleWasm = wasm;
  })();

  return loading;
}

export async function checkSource(source: string): Promise<CompileOutput> {
  await loadCompiler();
  return wasm.riddle_check(source) as CompileOutput;
}

export async function compileSource(source: string): Promise<CompileOutput> {
  await loadCompiler();
  return wasm.riddle_compile(source) as CompileOutput;
}
