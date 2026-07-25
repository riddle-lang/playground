'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { EditorView } from '@codemirror/view';
import { checkSource, compileSource, loadCompiler } from '@/lib/compiler';
import type { Diagnostic } from '@/lib/compiler';
import { extractFunctions } from '@/lib/cJump';
import type { RiddleFn } from '@/lib/cJump';
import DiagPanel from '@/components/DiagPanel';
const Editor       = dynamic(() => import('@/components/Editor'),  { ssr: false });
const COutputDynamic = dynamic(() => import('@/components/COutput'), { ssr: false });

// ---------------------------------------------------------------------------
// Default snippet
// ---------------------------------------------------------------------------
const DEFAULT_SOURCE = `struct Point {
    x: i32,
    y: i32,
}

impl Point {
    fun new(x: i32, y: i32) -> Point {
        Point { x, y }
    }
}

enum Shape {
    Circle(i32),
    Rect(Point, Point),
}

fun area(shape: Shape) -> i32 {
    match shape {
        Shape::Circle(r) => r * r,
        Shape::Rect(a, b) => {
            let w = b.x - a.x;
            let h = b.y - a.y;
            w * h
        }
    }
}

fun fib(n: i32) -> i32 {
    if n <= 1 {
        n
    } else {
        fib(n - 1) + fib(n - 2)
    }
}

fun main() {
    let p = Point::new(3, 4);
    let c = Shape::Circle(5);
    let a = area(c);
    let f = fib(10);
}
`;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
type RightTab = 'diag' | 'output';

export default function PlaygroundPage() {
  const [source, setSource]             = useState(DEFAULT_SOURCE);
  const [diagnostics, setDiagnostics]   = useState<Diagnostic[]>([]);
  const [cSource, setCSource]           = useState<string | undefined>();
  const [compileError, setCompileError] = useState<string | undefined>();
  const [functions, setFunctions]       = useState<RiddleFn[]>([]);
  const [checking, setChecking]         = useState(false);
  const [compileLoading, setCompileLoading] = useState(false);
  const [wasmReady, setWasmReady]       = useState(false);
  const [activeTab, setActiveTab]       = useState<RightTab>('diag');

  const sourceRef   = useRef(DEFAULT_SOURCE);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runCheck = useCallback(async (src: string) => {
    if (!wasmReady) return;
    setChecking(true);
    try {
      const out = await checkSource(src);
      setDiagnostics(out.diagnostics);
    } finally {
      setChecking(false);
    }
  }, [wasmReady]);

  // Debounced auto-check on keystroke
  useEffect(() => {
    sourceRef.current = source;
    if (!wasmReady) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runCheck(sourceRef.current), 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [source, wasmReady, runCheck]);

  const handleViewReady = useCallback(async (view: EditorView) => {
    void view;
    try {
      await loadCompiler();
      setWasmReady(true);
      const out = await checkSource(sourceRef.current);
      setDiagnostics(out.diagnostics);
    } catch { setWasmReady(false); }
  }, []);

  const handleRun = useCallback(async () => {
    if (!wasmReady) return;
    setCompileLoading(true);
    setCompileError(undefined);
    setActiveTab('output');
    try {
      const out = await compileSource(sourceRef.current);
      setDiagnostics(out.diagnostics);
      if (out.success && out.c_source) {
        setCSource(out.c_source);
        setFunctions(extractFunctions(sourceRef.current));
      } else {
        setCSource(undefined);
        if (!out.success && out.diagnostics.length === 0)
          setCompileError('Compilation failed with no diagnostics.');
        setActiveTab('diag');
      }
    } catch (err) {
      setCompileError(String(err));
      setActiveTab('output');
    } finally {
      setCompileLoading(false);
    }
  }, [wasmReady]);

  const errors   = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.filter(d => d.severity === 'warning').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* ── Header ── */}
      <header style={{
        height: 'var(--header-h)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        background: 'var(--bg-panel-header)',
        borderBottom: '1px solid var(--border)',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fontSize: 15,
            color: 'var(--accent)',
            letterSpacing: '-0.02em',
          }}>
            riddle
          </span>
          <span style={{ color: 'var(--border)', fontSize: 14 }}>|</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>playground</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Status chip */}
        <StatusChip
          ready={wasmReady}
          checking={checking}
          errors={errors}
          warnings={warnings}
        />

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={!wasmReady || compileLoading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 'var(--radius)',
            border: 'none',
            background: wasmReady && !compileLoading ? 'var(--accent)' : 'var(--bg-active)',
            color: wasmReady && !compileLoading ? '#1e2227' : 'var(--text-dim)',
            fontWeight: 600,
            fontSize: 13,
            cursor: !wasmReady || compileLoading ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s, color 0.15s',
            fontFamily: 'var(--font-ui)',
          }}
        >
          <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor">
            <path d="M0 0L11 6.5L0 13V0Z" />
          </svg>
          {compileLoading ? 'Running…' : 'Run'}
        </button>
      </header>

      {/* ── Main panes ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Editor */}
        <div style={{ flex: '0 0 56%', overflow: 'hidden', background: 'var(--bg-editor)', borderRight: '1px solid var(--border)' }}>
          <Editor
            initialValue={DEFAULT_SOURCE}
            onChange={(s) => { sourceRef.current = s; setSource(s); }}
            diagnostics={diagnostics}
            onViewReady={handleViewReady}
          />
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: 'var(--bg-panel)' }}>

          {/* Tabs */}
          <div style={{
            height: 'var(--tab-h)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'stretch',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel-header)',
          }}>
            <Tab
              active={activeTab === 'diag'}
              onClick={() => setActiveTab('diag')}
              badge={errors > 0 ? errors : warnings > 0 ? warnings : undefined}
              badgeColor={errors > 0 ? 'var(--error)' : 'var(--warning)'}
            >
              Diagnostics
            </Tab>
            <Tab
              active={activeTab === 'output'}
              onClick={() => setActiveTab('output')}
            >
              Generated C
            </Tab>
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflow: 'hidden', display: activeTab === 'diag' ? 'flex' : 'none', flexDirection: 'column' }}>
            <DiagPanel diagnostics={diagnostics} loading={checking} />
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: activeTab === 'output' ? 'flex' : 'none', flexDirection: 'column' }}>
            <COutputDynamic cSource={cSource} loading={compileLoading} compileError={compileError} functions={functions} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusChip
// ---------------------------------------------------------------------------
function StatusChip({
  ready, checking, errors, warnings,
}: { ready: boolean; checking: boolean; errors: number; warnings: number }) {
  if (!ready) {
    return (
      <span style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Spinner size={9} /> Loading compiler…
      </span>
    );
  }
  if (checking) {
    return (
      <span style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Spinner size={9} /> Checking…
      </span>
    );
  }
  if (errors > 0) {
    return (
      <span style={{ fontSize: 11, color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 12 }}>✕</span>
        {errors} error{errors !== 1 ? 's' : ''}
        {warnings > 0 && <span style={{ color: 'var(--warning)', marginLeft: 6 }}>⚠ {warnings}</span>}
      </span>
    );
  }
  if (warnings > 0) {
    return <span style={{ fontSize: 11, color: 'var(--warning)' }}>⚠ {warnings} warning{warnings !== 1 ? 's' : ''}</span>;
  }
  return <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ No issues</span>;
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------
function Tab({
  children, active, onClick, badge, badgeColor,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
  badgeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '0 16px',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        background: 'transparent',
        color: active ? 'var(--text-bright)' : 'var(--text-dim)',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-ui)',
        transition: 'color 0.1s',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      {badge != null && (
        <span style={{
          background: badgeColor ?? 'var(--text-dim)',
          color: '#1e2227',
          borderRadius: 10,
          padding: '0 5px',
          fontSize: 10,
          fontWeight: 700,
          lineHeight: '16px',
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
function Spinner({ size = 10 }: { size?: number }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      border: `${Math.max(1, size / 6)}px solid var(--border)`,
      borderTopColor: 'var(--accent)',
      borderRadius: '50%',
      animation: 'rl-spin 0.7s linear infinite',
      flexShrink: 0,
    }} />
  );
}

// Inject spin keyframes once
if (typeof document !== 'undefined' && !document.getElementById('rl-spin-kf')) {
  const s = document.createElement('style');
  s.id = 'rl-spin-kf';
  s.textContent = '@keyframes rl-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
}
