'use client';

import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Decoration, DecorationSet } from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import type { RiddleFn } from '@/lib/cJump';
import { findFunctionLine } from '@/lib/cJump';

// ---------------------------------------------------------------------------
// Jump highlight decoration (brief flash on the target line)
// ---------------------------------------------------------------------------
const setJumpHighlight = StateEffect.define<DecorationSet>();
const clearJumpHighlight = StateEffect.define();

const jumpHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setJumpHighlight)) return e.value;
      if (e.is(clearJumpHighlight)) return Decoration.none;
    }
    return decos.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

const jumpHighlightTheme = EditorView.theme({
  '.rl-jump-line': {
    background: 'rgba(97, 175, 239, 0.18)',
    transition: 'background 1s ease-out',
  },
  '.rl-jump-line-fading': {
    background: 'transparent',
    transition: 'background 1s ease-out',
  },
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface COutputProps {
  cSource?: string;
  loading: boolean;
  compileError?: string;
  functions?: RiddleFn[];
}

export default function COutput({ cSource, loading, compileError, functions = [] }: COutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef      = useRef<EditorView | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selected, setSelected] = useState('');

  // Build / update the editor when cSource changes
  useEffect(() => {
    if (!containerRef.current || !cSource) return;

    const state = EditorState.create({
      doc: cSource,
      extensions: [
        basicSetup,
        cpp(),
        oneDark,
        jumpHighlightField,
        jumpHighlightTheme,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.theme({
          '&': { height: '100%', fontSize: '12.5px', background: 'var(--bg-panel)' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
          '.cm-gutters': { background: 'var(--bg-panel-header)', borderRight: '1px solid var(--border)' },
          '.cm-activeLineGutter': { background: 'transparent' },
          '.cm-cursor, .cm-dropCursor': { display: 'none' },
        }),
      ],
    });

    if (viewRef.current) {
      viewRef.current.setState(state);
    } else {
      viewRef.current = new EditorView({ state, parent: containerRef.current });
    }
  }, [cSource]);

  // Destroy editor when cSource is cleared
  useEffect(() => {
    if (!cSource && viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
  }, [cSource]);

  // Jump to function + flash animation
  useEffect(() => {
    if (!selected || !cSource || !viewRef.current) return;
    const lineIdx = findFunctionLine(cSource, selected);
    if (lineIdx < 0) return;

    const view    = viewRef.current;
    const lineObj = view.state.doc.line(lineIdx + 1); // 1-based

    // Clear any pending highlight timer
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);

    // 1. Scroll and apply the highlight decoration
    const deco = Decoration.set([
      Decoration.line({ class: 'rl-jump-line' }).range(lineObj.from),
    ]);
    view.dispatch({
      selection: { anchor: lineObj.from },
      effects: [
        EditorView.scrollIntoView(lineObj.from, { y: 'center', yMargin: 80 }),
        setJumpHighlight.of(deco),
      ],
    });

    // 2. After 150ms swap to fading class (triggers CSS transition)
    highlightTimerRef.current = setTimeout(() => {
      if (!viewRef.current) return;
      const fadeDeco = Decoration.set([
        Decoration.line({ class: 'rl-jump-line-fading' }).range(
          viewRef.current.state.doc.line(lineIdx + 1).from,
        ),
      ]);
      viewRef.current.dispatch({
        effects: setJumpHighlight.of(fadeDeco),
      });

      // 3. Remove decoration entirely after the 1s CSS transition completes
      highlightTimerRef.current = setTimeout(() => {
        viewRef.current?.dispatch({ effects: clearJumpHighlight.of(null) });
      }, 1000);
    }, 150);
  }, [selected, cSource]);

  // Cleanup timer on unmount
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  // ── Loading / error / empty states ──────────────────────────────────────
  // Rendered as an overlay, never by unmounting the editor container: React
  // removing that div would detach the CodeMirror DOM, and the build effect
  // above won't re-attach it when the recompiled C source is byte-identical.
  const overlay = loading ? (
    <>
      <Spinner />
      <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 8 }}>Compiling…</span>
    </>
  ) : compileError ? (
    <span style={{ alignSelf: 'stretch', padding: 16, color: 'var(--error)', fontSize: 12, fontFamily: 'var(--font-mono)', overflow: 'auto' }}>
      {compileError}
    </span>
  ) : !cSource ? (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 22, opacity: 0.3 }}>▶</span>
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Press Run to compile to C</span>
    </div>
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Jump bar */}
      {cSource && functions.length > 0 && (
        <div style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          height: 32,
          background: 'var(--bg-panel-header)',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>Jump to</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{
              flex: 1,
              maxWidth: 280,
              background: 'var(--bg-active)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              padding: '2px 6px',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="">— select function —</option>
            {functions.map((fn) => (
              <option key={fn.cName} value={fn.cName}>
                {fn.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* CodeMirror C editor */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
        {overlay && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-panel)',
          }}>
            {overlay}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: 10,
      height: 10,
      border: '1.5px solid var(--border)',
      borderTopColor: 'var(--accent)',
      borderRadius: '50%',
      animation: 'rl-spin 0.7s linear infinite',
    }} />
  );
}
