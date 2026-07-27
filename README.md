# Riddle Playground

An in-browser playground for the [Riddle language](https://github.com/riddle-lang/riddle),
powered by the compiler and browser-safe analysis modules from `riddle-lsp`, compiled to
WebAssembly.

**Live:** https://riddle-lang.github.io/playground/

## Repository layout

```
packages/
  compiler/   Rust → WASM adapter over riddlec and riddle-lsp
  web/        Next.js frontend (CodeMirror 6 editor)
.github/
  workflows/
    deploy.yml  clone riddle → build WASM + web → deploy a Pages artifact
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

## Deployment

Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
No deployment branch is used: builds upload `packages/web/out` as a Pages artifact and
deploy it directly.

Pushes to this repository's `main` branch deploy with the latest Riddle `main`.
Manual runs can select a Riddle branch, tag, or commit SHA with `riddle_ref`.
