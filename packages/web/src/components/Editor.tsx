'use client';

import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { setDiagnostics } from '@codemirror/lint';
import type { Diagnostic as CmDiag } from '@codemirror/lint';
import type { Diagnostic } from '@/lib/compiler';
import { riddleExtensions } from '@/lib/riddleExtension';

interface EditorProps {
  initialValue?: string;
  onChange?: (value: string) => void;
  diagnostics?: Diagnostic[];
  onViewReady?: (view: EditorView) => void;
}

export default function Editor({
  initialValue = '',
  onChange,
  diagnostics = [],
  onViewReady,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Create editor once
  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          basicSetup,
          oneDark,
          ...riddleExtensions(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChange?.(update.state.doc.toString());
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
            // Remove basicSetup's generic highlighting so riddle tokens win
            '.cm-content': { caretColor: '#528bff' },
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    onViewReady?.(view);

    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push diagnostics into the editor (from Check / Run button clicks)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const cmDiags: CmDiag[] = diagnostics.map((d) => ({
      from:     d.start,
      to:       d.end,
      severity: d.severity === 'warning' ? 'warning'
               : d.severity === 'error'   ? 'error'
               : 'info',
      message: d.code ? `[${d.code}] ${d.message}` : d.message,
    }));

    view.dispatch(setDiagnostics(view.state, cmDiags));
  }, [diagnostics]);

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'hidden' }} />
  );
}
