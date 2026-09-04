import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The kiosk stylesheet promises, in its header, that every interactive control
// on the critical path is ≥ 48px tall. The short-viewport block added on
// 2026-09-04 (@media max-height: 860px) takes vertical AIR to bring each
// screen's primary CTA above the fold at 1024×768 — and it is exactly the kind
// of edit a future "just make it 44" would silently break. This pins the floor:
// every `height` / `min-height` declared for a control selector, in ANY block
// (base or media), stays at or above 48px.
const css = fs.readFileSync(path.join(__dirname, '../src/app/kiosk/kiosk.css'), 'utf8');
const CONTROL = /\.kio-key|\.kio-btn|\.kio-input|\.kio-lang button|\.kio-help|\.kio-cta|\.kio-bigcard/;

function declaredHeights(source) {
  const out = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(source))) {
    const selector = m[1].trim();
    if (!CONTROL.test(selector)) continue;
    // px, rem and em all count (rem/em normalised at the root 16px) — a
    // `height: 2.5rem` is 40px and must not slip past a px-only regex.
    const decl = /(?:^|;)\s*(min-height|height)\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)\b/g;
    let d;
    while ((d = decl.exec(m[2]))) out.push({ selector, prop: d[1], px: Number(d[2]) * (d[3] === 'px' ? 1 : 16) });
  }
  return out;
}

describe('kiosk.css touch floor', () => {
  const heights = declaredHeights(css);

  it('declares heights for the controls it promises to keep tappable', () => {
    // Sanity: the parser sees the real rules (keys, primary button, cta…).
    expect(heights.some((h) => h.selector.includes('.kio-key'))).toBe(true);
    expect(heights.some((h) => h.selector.includes('.kio-btn'))).toBe(true);
  });

  it('never declares a control height under 48px — base rules or media blocks', () => {
    const offenders = heights.filter((h) => h.px < 48);
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
  });

  it('keeps the short-viewport block from touching the bar, the progress row or the notice', () => {
    // Their geometry is what the 2.5s agent toast (absolute top:84) was
    // measured against; compacting them would move the toast onto new content.
    // Every max-height block, not just today's 860px one — a second, shorter
    // cut added later is bound by the same contract.
    const blocks = [...css.matchAll(/@media \(max-height:[^)]*\)\s*\{/g)].map((hit) => {
      const start = hit.index + hit[0].length;
      return css.slice(start, css.indexOf('\n}\n', start));
    });
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).not.toMatch(/\.kio-bar\b|\.kio-steps\b|\.kio-stp\b|\.kio-assist-notice/);
  });
});
