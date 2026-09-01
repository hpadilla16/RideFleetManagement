/**
 * AuthGate hands its child a FUNCTION, not JSX.
 *
 * `AuthGate` ends with `return children({ token, me, setMe, logout, setError })`.
 * A page that writes `<AuthGate><AppShell>…</AppShell></AuthGate>` therefore
 * calls a React element as a function, throws, and the error boundary shows
 * "Something went wrong" — before a single request leaves the browser, so the
 * server logs are silent and there is nothing to debug from (2026-08-19, the
 * daily-business report).
 *
 * The compiler cannot catch it: both spellings are valid JSX. So this walks
 * the source instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('AuthGate is always used as a render prop', () => {
  it('no page passes plain children to AuthGate', () => {
    const offenders = [];
    for (const file of sourceFiles(SRC)) {
      // Comments mention <AuthGate> when they explain the pattern; scanning
      // them flagged two correct pages on the first run.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (!text.includes('<AuthGate')) continue;
      // The component's own definition is the one place the tag is absent.
      if (file.endsWith(`components${sep}AuthGate.jsx`)) continue;
      // Every opening tag must be immediately followed by a function child:
      //   <AuthGate>{({ token }) => …}
      for (const m of text.matchAll(/<AuthGate\b[^>]*>\s*([^{\s])/g)) {
        offenders.push(`${relative(SRC, file).split(sep).join('/')} — child starts with "${m[1]}", not a function`);
      }
    }
    expect(
      offenders, 'AuthGate calls children(...) — these would throw at render:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the contract this test rests on has not changed', () => {
    // If AuthGate ever stops calling children as a function, this guard is
    // obsolete and should go — better a failing test than a silent one.
    const gate = readFileSync(join(SRC, 'components', 'AuthGate.jsx'), 'utf8');
    expect(gate).toMatch(/return\s+children\(/);
  });
});
