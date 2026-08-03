/**
 * Disk-space watchdog.
 *
 * The behaviour that matters is the alert edge, not the arithmetic: a disk
 * sitting at 95% for a week must page once, not 168 times, and it must page
 * AGAIN if it refills after being cleaned. Everything here is injected, so no
 * filesystem is touched.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDiskOnce,
  readDiskUsage,
  _resetDiskAlertState,
} from './disk-space.scheduler.js';

function harness(sequence) {
  const captured = [];
  let i = 0;
  return {
    captured,
    deps: {
      alertPct: 80,
      capture: (err, ctx) => captured.push({ message: err.message, ctx }),
      readDiskUsage: async () => {
        const pct = sequence[Math.min(i++, sequence.length - 1)];
        return { totalGb: 154, availableGb: +(154 * (1 - pct / 100)).toFixed(1), usedPct: pct };
      },
    },
  };
}

describe('disk-space watchdog', () => {
  beforeEach(() => _resetDiskAlertState());

  it('stays silent below the threshold', async () => {
    const h = harness([22, 55, 79]);
    for (let n = 0; n < 3; n++) await checkDiskOnce(h.deps);
    assert.equal(h.captured.length, 0);
  });

  it('alerts at the threshold, not only above it', async () => {
    const h = harness([80]);
    await checkDiskOnce(h.deps);
    assert.equal(h.captured.length, 1);
    assert.match(h.captured[0].message, /80% full/);
    assert.equal(h.captured[0].ctx.ops.threshold, 80);
  });

  it('alerts once per escalation, not on every check', async () => {
    const h = harness([91, 93, 97, 99]);
    for (let n = 0; n < 4; n++) await checkDiskOnce(h.deps);
    assert.equal(h.captured.length, 1, 'a disk that stays full must not page hourly');
  });

  it('re-arms after recovery and alerts again if it refills', async () => {
    const h = harness([91, 30, 91]);
    for (let n = 0; n < 3; n++) await checkDiskOnce(h.deps);
    assert.equal(h.captured.length, 2);
  });

  it('returns null and does not alert when statfs is unavailable', async () => {
    const captured = [];
    const out = await checkDiskOnce({
      alertPct: 80,
      capture: (e) => captured.push(e),
      readDiskUsage: async () => { throw new Error('ENOSYS'); },
    });
    assert.equal(out, null);
    assert.equal(captured.length, 0, 'a missing metric must not masquerade as a full disk');
  });

  it('readDiskUsage reports a plausible reading for the real filesystem', async () => {
    const u = await readDiskUsage('/').catch(() => null);
    if (!u) return; // platform without statfs — nothing to assert
    assert.ok(u.totalGb > 0);
    assert.ok(u.usedPct >= 0 && u.usedPct <= 100);
    assert.ok(u.availableGb <= u.totalGb);
  });
});
