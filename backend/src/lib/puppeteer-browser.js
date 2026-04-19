import puppeteer from 'puppeteer';
import logger from './logger.js';

// Singleton Puppeteer browser instance. Avoids paying a 1-3s cold-launch cost
// on every PDF render. We keep one Chromium process alive for the lifetime of
// the worker and only call `browser.newPage()` / `page.close()` per request.
//
// A disconnect (OOM, crash) is handled transparently: the next getBrowser()
// call relaunches. This keeps the hot path simple — callers never need to
// branch on "is the singleton alive".

// Factory lets tests inject a fake launcher. Production uses puppeteer.launch.
// The returned object implements the same `getBrowser`/`closeBrowser` contract.
export function createBrowserManager(launcher) {
  let browserPromise = null;

  async function getBrowser() {
    // Snapshot the current promise reference. If we discover the underlying
    // browser is dead, we only relaunch when no other concurrent caller has
    // already replaced it — otherwise both callers would each call launcher()
    // and one Chromium process would leak as an orphan.
    const snapshot = browserPromise;
    if (snapshot) {
      const existing = await snapshot.catch(() => null);
      if (existing && existing.isConnected()) return existing;
      // Only invalidate the cache if nobody else has updated it during our await.
      if (browserPromise === snapshot) browserPromise = null;
    }
    // If a concurrent caller already started a relaunch, ride on theirs.
    if (browserPromise) return browserPromise;

    browserPromise = launcher();
    const launching = browserPromise;
    const browser = await launching;
    browser.once?.('disconnected', () => {
      logger.warn?.('[puppeteer-browser] Chromium disconnected; will relaunch on next request');
      // Only clear if our launch is still the cached one.
      if (browserPromise === launching) browserPromise = null;
    });
    return browser;
  }

  async function closeBrowser() {
    const current = browserPromise;
    browserPromise = null;
    if (!current) return;
    try {
      const browser = await current;
      if (browser && browser.isConnected()) await browser.close();
    } catch (err) {
      logger.warn?.(`[puppeteer-browser] close() failed: ${err?.message || err}`);
    }
  }

  return { getBrowser, closeBrowser };
}

function defaultLauncher() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
}

const manager = createBrowserManager(defaultLauncher);
export const getBrowser = manager.getBrowser;
export const closeBrowser = manager.closeBrowser;
