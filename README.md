# Riddle Playground

An in-browser playground for the [Riddle language](https://github.com/riddle-lang/riddle),
powered by a WebAssembly-compiled compiler.

**Live:** https://riddle-lang.github.io/playground/

## Repository layout

```
packages/
  compiler/   Rust → WASM crate (wraps riddlec pipeline)
  web/        Next.js frontend (CodeMirror 6 editor)
.github/
  workflows/
    build-compiler.yml  Manual: clone riddle → compile WASM → commit
    deploy.yml          Auto:   push to main → deploy to GitHub Pages
```

## Local development

### Build the WASM compiler

```bash
# Clone the main riddle repo next to packages/
git clone --depth=1 https://github.com/riddle-lang/riddle.git packages/riddle-src

# Build (requires wasm-pack)
wasm-pack build packages/compiler --target web --out-dir ../web/public/wasm --release
```

### Run the frontend

```bash
cd packages/web
npm install
npm run dev
```

## Updating the compiler

Trigger the **Build WASM Compiler** workflow manually from the Actions tab,
optionally specifying a branch/tag/SHA of the riddle repo.
