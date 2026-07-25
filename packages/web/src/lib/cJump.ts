/**
 * Mapping Riddle function names to generated C identifiers.
 *
 * MIR naming rules (from crates/mir/src/lower.rs):
 *   Top-level:   fun foo      → MIR: "foo"           → C: riddle_f_<hex("foo")>
 *   Method:      impl T { fun m }  → MIR: "m__T"    → C: riddle_f_<hex("m__T")>
 *   main:                           → C: "main"
 */

// ---------------------------------------------------------------------------
// Internal: Riddle qualified name → MIR name
// ---------------------------------------------------------------------------

function qualifiedToMirName(qualifiedName: string): string {
  // "Type::method" → "method__Type"
  const sep = qualifiedName.indexOf('::');
  if (sep === -1) return qualifiedName;          // top-level function
  const typePart   = qualifiedName.slice(0, sep);
  const methodPart = qualifiedName.slice(sep + 2);
  return `${methodPart}__${typePart}`;
}

// ---------------------------------------------------------------------------
// Public: Riddle qualified name → C identifier
// ---------------------------------------------------------------------------

export function riddleToCName(qualifiedName: string): string {
  if (qualifiedName === 'main') return 'main';
  const mirName = qualifiedToMirName(qualifiedName);
  const bytes   = new TextEncoder().encode(mirName);
  const hex     = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `riddle_f_${hex}`;
}

// ---------------------------------------------------------------------------
// Extract Riddle function names from source text
// ---------------------------------------------------------------------------

export interface RiddleFn {
  /** Display name shown in the jump bar, e.g. "fib" or "Point::new" */
  name: string;
  /** Corresponding generated C identifier */
  cName: string;
}

export function extractFunctions(source: string): RiddleFn[] {
  const fns: RiddleFn[] = [];
  const lines = source.split('\n');

  let currentImpl: string | null = null;
  // Track brace depth relative to the impl opening brace.
  // depth = 0  → outside impl (or impl line before its '{')
  // depth = 1  → directly inside impl block
  // depth > 1  → inside a nested block (function body, etc.)
  let implDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // --- Detect impl block start -------------------------------------------
    // "impl TypeName {" or "impl TypeName for OtherType {"
    // Only match at depth 0 (top-level impl, not nested impls).
    if (implDepth === 0) {
      const implMatch = trimmed.match(/^(?:pub\s+)?impl(?:\s*<[^>]*>)?\s+(\w+)/);
      if (implMatch) {
        currentImpl = implMatch[1];
        // Count the opening brace on this same line (if present)
        implDepth = (trimmed.match(/\{/g) ?? []).length
                  - (trimmed.match(/\}/g) ?? []).length;
        // fall through: also check for `fun` on the impl line (rare but possible)
      }
    } else {
      // --- Track brace depth inside impl ------------------------------------
      for (const ch of trimmed) {
        if (ch === '{') implDepth++;
        else if (ch === '}') {
          implDepth--;
          if (implDepth <= 0) {
            implDepth = 0;
            currentImpl = null;
          }
        }
      }
    }

    // --- Detect function definition -----------------------------------------
    // Matches: [pub] [unsafe] fun name[<...>](
    const funMatch = trimmed.match(/(?:pub\s+)?(?:unsafe\s+)?fun\s+(\w+)\s*(?:<[^>]*)?\s*\(/);
    if (funMatch) {
      const methodName = funMatch[1];
      const qualifiedName = currentImpl
        ? `${currentImpl}::${methodName}`
        : methodName;
      fns.push({ name: qualifiedName, cName: riddleToCName(qualifiedName) });
    }
  }

  return fns;
}

// ---------------------------------------------------------------------------
// Find the line number (0-based) of a C function *definition*.
// Forward declarations end with ");" — we skip those.
// ---------------------------------------------------------------------------

export function findFunctionLine(cSource: string, cName: string): number {
  const escaped = cName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\s*\\(`);
  const lines = cSource.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (re.test(line) && !line.trimEnd().endsWith(';')) return i;
  }
  return -1;
}
