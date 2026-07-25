// CodeMirror 6 Riddle extensions:
//   1. Immediate StreamLanguage fallback (keywords/strings visible instantly)
//   2. Semantic token overlay via WASM (precise highlighting once loaded)
//   3. Autocompletion
//   4. Inlay type hints

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { Extension, StateEffect, StateField, Range, Text } from '@codemirror/state';
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  Completion,
} from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { loadCompiler } from './compiler';

// ---------------------------------------------------------------------------
// One-Dark palette
// ---------------------------------------------------------------------------
const C = {
  keyword:   '#c678dd',
  comment:   '#5c6370',
  string:    '#98c379',
  number:    '#d19a66',
  operator:  '#56b6c2',
  fn:        '#61afef',
  method:    '#61afef',
  variable:  '#abb2bf',
  mut:       '#e06c75',
  type:      '#e5c07b',
  property:  '#e06c75',
  namespace: '#e5c07b',
  param:     '#e06c75',
  inlay:     '#4b5263',
};

// ---------------------------------------------------------------------------
// 1. StreamLanguage fallback — instant keyword/string/comment highlighting
//    (active until WASM tokens override the same ranges)
// ---------------------------------------------------------------------------

const RIDDLE_KEYWORDS = new Set([
  'let','fun','struct','if','else','while','break','continue','return',
  'as','self','mod','use','mut','pub','super','crate','enum','trait',
  'impl','match','const','type','extern','unsafe','safe','for','in',
  'where','true','false',
]);

const RIDDLE_TYPES = new Set([
  'bool','char','str','i8','i16','i32','i64','isize',
  'u8','u16','u32','u64','usize','f32','f64',
]);

const riddleFallbackLang = StreamLanguage.define<{ inStr: boolean; inChar: boolean }>({
  name: 'riddle-fallback',
  startState: () => ({ inStr: false, inChar: false }),
  token(stream, state) {
    // Multi-char string
    if (state.inStr) {
      if (stream.next() === '"') state.inStr = false;
      return 'string';
    }
    // Line comment
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    // String start
    if (stream.peek() === '"') { stream.next(); state.inStr = true; return 'string'; }
    // Char literal
    if (stream.match(/'([^'\\]|\\.)'/)) return 'string';
    // Numbers
    if (stream.match(/[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?(i8|i16|i32|i64|isize|u8|u16|u32|u64|usize|f32|f64)?/))
      return 'number';
    // Identifiers / keywords
    if (stream.match(/[a-zA-Z_][a-zA-Z0-9_]*/)) {
      const word = stream.current();
      if (RIDDLE_KEYWORDS.has(word)) return 'keyword';
      if (RIDDLE_TYPES.has(word))    return 'keyword';
      return null;
    }
    stream.next();
    return null;
  },
  blankLine() {},
  copyState: s => ({ ...s }),
  indent: () => null,
  languageData: { commentTokens: { line: '//' } },
});

// ---------------------------------------------------------------------------
// 2. Theme — all rl-* classes + fallback token colors
// ---------------------------------------------------------------------------
export const riddleTheme = EditorView.theme({
  // fallback StreamLanguage tokens (low-specificity baseline)
  '& .tok-keyword':  { color: C.keyword },
  '& .tok-comment':  { color: C.comment, fontStyle: 'italic' },
  '& .tok-string':   { color: C.string },
  '& .tok-number':   { color: C.number },

  // semantic overlay tokens (higher specificity, override fallback)
  '& .rl-keyword':   { color: C.keyword },
  '& .rl-comment':   { color: C.comment, fontStyle: 'italic' },
  '& .rl-string':    { color: C.string },
  '& .rl-number':    { color: C.number },
  '& .rl-operator':  { color: C.operator },
  '& .rl-fn':        { color: C.fn },
  '& .rl-method':    { color: C.method },
  '& .rl-variable':  { color: C.variable },
  '& .rl-mut':       { color: C.mut, fontStyle: 'italic' },
  '& .rl-type':      { color: C.type },
  '& .rl-property':  { color: C.property },
  '& .rl-namespace': { color: C.namespace },
  '& .rl-param':     { color: C.param },
  '& .rl-inlay': {
    color: C.inlay,
    fontStyle: 'italic',
    pointerEvents: 'none',
    userSelect: 'none',
  },
});

// ---------------------------------------------------------------------------
// 3. Semantic token types (indices match TT_* in lib.rs)
// ---------------------------------------------------------------------------
interface SemToken {
  deltaLine: number;
  deltaStart: number;
  length: number;
  tokenType: number;
  tokenModifiersBitset: number;
}
interface WasmInlayHint { line: number; character: number; label: string; }
interface WasmCompletion {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  labelDetails?: { detail?: string; description?: string };
}

const TOKEN_CLASSES: (string | null)[] = [
  'rl-keyword',   // 0  keyword
  'rl-comment',   // 1  comment
  'rl-string',    // 2  string
  'rl-number',    // 3  number
  'rl-operator',  // 4  operator
  'rl-fn',        // 5  function
  'rl-method',    // 6  method
  'rl-variable',  // 7  variable (immutable)
  'rl-type',      // 8  type alias
  'rl-type',      // 9  struct
  'rl-type',      // 10 enum
  'rl-type',      // 11 interface/trait
  'rl-property',  // 12 field/property
  'rl-namespace', // 13 module/namespace
  'rl-param',     // 14 parameter
];

// ---------------------------------------------------------------------------
// 4. Semantic token state
// ---------------------------------------------------------------------------
const setSemanticDecos = StateEffect.define<DecorationSet>();

const semanticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setSemanticDecos)) return e.value;
    }
    return decos.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

function buildSemanticDecos(tokens: SemToken[], doc: Text): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let line = 0;
  let character = 0;
  for (const tok of tokens) {
    line += tok.deltaLine;
    character = tok.deltaLine === 0 ? character + tok.deltaStart : tok.deltaStart;
    if (line >= doc.lines) continue;
    const docLine = doc.line(line + 1);
    const from = docLine.from + character;
    const to = from + tok.length;
    if (from >= to || to > docLine.to) continue;
    const isMut = (tok.tokenModifiersBitset & 2) !== 0;
    const cls = isMut ? 'rl-mut' : (TOKEN_CLASSES[tok.tokenType] ?? null);
    if (!cls) continue;
    ranges.push(Decoration.mark({ class: cls }).range(from, to));
  }
  // Deduplicate / remove overlaps (keep first at each position)
  const sorted = ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const deduped: Range<Decoration>[] = [];
  let lastTo = -1;
  for (const r of sorted) {
    if (r.from < lastTo) continue; // overlaps previous
    deduped.push(r);
    lastTo = r.to;
  }
  return Decoration.set(deduped, true);
}

// ---------------------------------------------------------------------------
// 5. Inlay hints
// ---------------------------------------------------------------------------
class InlayWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: InlayWidget) { return this.text === other.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'rl-inlay';
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

const setInlayDecos = StateEffect.define<DecorationSet>();

const inlayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setInlayDecos)) return e.value;
    }
    return decos.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

function buildInlayDecos(hints: WasmInlayHint[], doc: Text): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const h of hints) {
    if (h.line >= doc.lines) continue;
    const line = doc.line(h.line + 1);
    const offset = line.from + h.character;
    if (offset > line.to) continue;
    ranges.push(
      Decoration.widget({ widget: new InlayWidget(h.label), side: 1 }).range(offset),
    );
  }
  return Decoration.set(ranges, true);
}

// ---------------------------------------------------------------------------
// 6. View plugin — debounced WASM refresh (instance timer, not module-level)
// ---------------------------------------------------------------------------
const riddleHighlightPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null; // INSTANCE variable

    constructor(private view: EditorView) {
      this.schedule(0); // fire immediately on mount
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.schedule(300);
    }

    private schedule(ms: number) {
      if (this.timer != null) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), ms);
    }

    private async refresh() {
      const source = this.view.state.doc.toString();
      try {
        await loadCompiler();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wasm = (globalThis as any).__riddleWasm as Record<string, (...args: unknown[]) => unknown> | undefined;
        if (!wasm) return;

        const semTokens  = wasm.riddle_semantic_tokens(source) as SemToken[];
        const inlayHints = wasm.riddle_inlay_hints(source) as WasmInlayHint[];
        const doc = this.view.state.doc;

        this.view.dispatch({
          effects: [
            setSemanticDecos.of(buildSemanticDecos(semTokens, doc)),
            setInlayDecos.of(buildInlayDecos(inlayHints, doc)),
          ],
        });
      } catch (e) {
        console.warn('[riddle] semantic tokens error:', e);
      }
    }

    destroy() {
      if (this.timer != null) clearTimeout(this.timer);
    }
  },
);

// ---------------------------------------------------------------------------
// 7. Autocompletion source
// ---------------------------------------------------------------------------
const KIND_LABELS: Record<number, string> = {
  1: 'text', 2: 'method', 3: 'function', 4: 'function', 5: 'property',
  6: 'variable', 7: 'class', 8: 'interface', 9: 'namespace', 10: 'property',
  12: 'constant', 13: 'enum', 14: 'keyword', 20: 'enum', 21: 'constant',
  22: 'class', 25: 'type',
};

async function riddleCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wasm = (globalThis as any).__riddleWasm as Record<string, (...args: unknown[]) => unknown> | undefined;
    if (!wasm) return null;
    const source = ctx.state.doc.toString();
    const line = ctx.state.doc.lineAt(ctx.pos);
    const rawItems = wasm.riddle_completions(
      source,
      line.number - 1,
      ctx.pos - line.from,
    ) as WasmCompletion[];
    if (!rawItems?.length) return null;
    const wordMatch = ctx.matchBefore(/[\w_]+/);
    const from = wordMatch ? wordMatch.from : ctx.pos;
    const options: Completion[] = rawItems.map(item => ({
      label:  item.label,
      type:   item.kind == null ? 'text' : (KIND_LABELS[item.kind] ?? 'text'),
      detail: [item.labelDetails?.detail, item.labelDetails?.description, item.detail]
        .filter(Boolean)
        .join(' '),
      apply: item.insertText ?? item.label,
    }));
    return { from, options, validFor: /^[\w_]*$/ };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function riddleExtensions(): Extension[] {
  return [
    riddleFallbackLang,   // instant keyword/string/comment colors
    semanticField,        // semantic overlay (applied after WASM loads)
    inlayField,
    riddleTheme,
    riddleHighlightPlugin,
    autocompletion({ override: [riddleCompletionSource], closeOnBlur: false }),
  ];
}
