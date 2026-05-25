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

// ---------------------------------------------------------------------------
// TL International dedicated browser (2026-05-25)
//
// TL's CloudFlare binds the session cookie to BOTH the TLS fingerprint AND
// the originating IP. Our cookies are obtained from Hector's residential IP
// in PR; the droplet sits in NYC with a different IP, so direct requests
// from the droplet get 302'd back to login.php even with a fresh cookie.
//
// Mitigation: route TL Chromium traffic through an HTTP/SOCKS proxy that
// egresses from the same residential IP. Set TL_INTERNATIONAL_PROXY_URL in
// the environment (e.g. `http://100.x.y.z:8888` over Tailscale to a proxy
// running on Hector's Mac) and Chromium will use it.
//
// We keep this as a SEPARATE manager from the global singleton because the
// global one is shared with PDF rendering, market-scraper, etc. — those
// must NOT go through the residential proxy.
// ---------------------------------------------------------------------------

function tlLauncher() {
  const proxyUrl = process.env.TL_INTERNATIONAL_PROXY_URL || null;
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (proxyUrl) {
    args.push(`--proxy-server=${proxyUrl}`);
    // CloudFlare WARP / residential proxies may have older trust chains.
    // We don't want to silently accept bad certs; instead we log loudly so
    // the operator notices if the proxy itself is misconfigured.
    logger.info?.('[puppeteer-browser:tl] launching Chromium via proxy', { proxyUrl });
  } else {
    logger.warn?.('[puppeteer-browser:tl] TL_INTERNATIONAL_PROXY_URL not set — Chromium will egress from droplet IP. TL will likely reject this.');
  }
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args,
  });
}

const tlManager = createBrowserManager(tlLauncher);
export const getTLBrowser = tlManager.getBrowser;
export const closeTLBrowser = tlManager.closeBrowser;
