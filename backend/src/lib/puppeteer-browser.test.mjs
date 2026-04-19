import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserManager } from './puppeteer-browser.js';

function fakeBrowser() {
  const listeners = new Map();
  let connected = true;
  const browser = {
    isConnected: () => connected,
    close: async () => { connected = false; },
    once: (event, handler) => { listeners.set(event, handler); },
    // test-only helpers
    __disconnect: () => { connected = false; listeners.get('disconnected')?.(); },
  };
  return browser;
}

describe('createBrowserManager', () => {
  let launchCount = 0;
  let nextBrowser = null;

  beforeEach(() => {
    launchCount = 0;
    nextBrowser = null;
  });

  it('getBrowser launches once and reuses the instance', async () => {
    const mgr = createBrowserManager(async () => {
      launchCount++;
      return fakeBrowser();
    });
    const a = await mgr.getBrowser();
    const b = await mgr.getBrowser();
    assert.equal(launchCount, 1, 'launcher should be called only once');
    assert.equal(a, b, 'same browser reference returned');
  });

  it('relaunches after closeBrowser', async () => {
    const mgr = createBrowserManager(async () => {
      launchCount++;
      return fakeBrowser();
    });
    await mgr.getBrowser();
    await mgr.closeBrowser();
    await mgr.getBrowser();
    assert.equal(launchCount, 2, 'launcher called again after close');
  });

  it('relaunches if the browser disconnects', async () => {
    const mgr = createBrowserManager(async () => {
      launchCount++;
      nextBrowser = fakeBrowser();
      return nextBrowser;
    });
    const first = await mgr.getBrowser();
    first.__disconnect(); // simulate Chromium crash
    const second = await mgr.getBrowser();
    assert.equal(launchCount, 2, 'launcher called again after disconnect');
    assert.notEqual(first, second, 'new browser instance after disconnect');
  });

  it('closeBrowser is a no-op when no browser was launched', async () => {
    const mgr = createBrowserManager(async () => {
      launchCount++;
      return fakeBrowser();
    });
    await mgr.closeBrowser();
    assert.equal(launchCount, 0);
  });

  it('getBrowser recovers from a launcher error on the next call', async () => {
    let first = true;
    const mgr = createBrowserManager(async () => {
      launchCount++;
      if (first) { first = false; throw new Error('launch failed'); }
      return fakeBrowser();
    });
    await assert.rejects(() => mgr.getBrowser(), /launch failed/);
    const b = await mgr.getBrowser();
    assert.ok(b.isConnected());
    assert.equal(launchCount, 2);
  });

  it('two concurrent getBrowser calls during a relaunch do not orphan a Chromium process', async () => {
    // Race scenario: the cached browser is disconnected; two requests arrive
    // at the same time and both enter the relaunch branch. Without the
    // snapshot-and-compare guard in createBrowserManager, both would invoke
    // the launcher independently and one Chromium would leak as an orphan.
    let resolveLaunch;
    let pending = null;
    const mgr = createBrowserManager(() => {
      launchCount++;
      // First launch resolves immediately; second launch (the racy one) we
      // hold open with a deferred so we can observe ordering.
      if (launchCount === 1) return Promise.resolve(fakeBrowser());
      pending = new Promise((r) => { resolveLaunch = r; });
      return pending;
    });

    // Prime the cache, then disconnect the browser to force the relaunch path.
    const first = await mgr.getBrowser();
    first.__disconnect();

    // Two concurrent callers race into the relaunch branch.
    const p1 = mgr.getBrowser();
    const p2 = mgr.getBrowser();

    // Resolve the (single) in-flight launch and await both.
    // If the guard is broken, launchCount jumps to 3 and the assertion fails.
    resolveLaunch?.(fakeBrowser());
    const [b1, b2] = await Promise.all([p1, p2]);

    assert.equal(launchCount, 2, 'launcher should fire exactly twice (initial + one relaunch), not three times');
    assert.equal(b1, b2, 'both concurrent callers must receive the SAME relaunched browser instance');
  });
});
