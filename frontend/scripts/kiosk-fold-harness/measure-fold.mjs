import { createRequire } from 'node:module';
const puppeteer = createRequire(new URL('../../../backend/package.json', import.meta.url))('puppeteer');
const S = process.env.S || '.'; const BASE = process.env.BASE || 'http://localhost:3105';
const TAG = process.env.TAG || 'run'; const SHOTS = process.env.SHOTS === '1';
const SIZES = (process.env.SIZES || '1024x768,1180x820,768x1024,820x1180').split(',').map(s=>s.split('x').map(Number));
const SCREENS = (process.env.SCREENS || 'LOOKUP,ID,SELFIE,OFFERS,PAYMENT,SIGN').split(',');
const CTA = { LOOKUP:'.kio-main .kio-row > .kio-btn:not(.ghost)', ID:'.kio-main .kio-row > .kio-btn:not(.ghost)', SELFIE:'.kio-main .kio-btn:not(.ghost):not(.back)', OFFERS:'.kio-pkg.reco .kio-cta.buy', PAYMENT:'.kio-main .kio-btn.mint', SIGN:'.kio-main .kio-btn.mint' };
const FIRST = { SIGN:'.kio-main .kio-sig', ID:'.kio-scanbox', LOOKUP:'.kio-keypad', OFFERS:'.kio-pkgs', PAYMENT:'.kio-panel', SELFIE:'.kio-selfie-frame' };
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('ride_kiosk_device', JSON.stringify({ name: 'iPad Counter 1', location: { name: 'San Juan Airport' }, tenant: { name: 'International Rental Corp' } }));
});
const rows = [];
for (const [w, h] of SIZES) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  for (const lang of ['es', 'en']) for (const screen of SCREENS) {
    const parts = [];
    for (const notice of ['none', '1', '2']) {
      await page.goto(`${BASE}/kiosk/fold-harness?screen=${screen}&lang=${lang}&notice=${notice}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('html[data-harness-ready]');
      await page.waitForSelector(CTA[screen]);
      const m = await page.evaluate((ctaSel, firstSel) => {
        const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { y: Math.round(b.y), b: Math.round(b.bottom), h: Math.round(b.height) }; };
        const main = document.querySelector('.kio-main'); const mb = main.getBoundingClientRect();
        const cta = document.querySelector(ctaSel);
        const btns = [...document.querySelectorAll('.kio-root button')].filter(b => b.offsetParent !== null);
        const minTap = Math.min(...btns.map(b => b.getBoundingClientRect().height));
        const smallTaps = btns.filter(b => b.getBoundingClientRect().height < 44).map(b => (b.textContent || '').trim().slice(0, 18) + '=' + Math.round(b.getBoundingClientRect().height));
        const steps = document.querySelector('.kio-steps');
        const n = document.querySelector('[data-testid=assist-notice]');
        return { fold: Math.round(mb.bottom), mainTop: Math.round(mb.y), pad: getComputedStyle(main).padding, scrollH: main.scrollHeight, clientH: main.clientHeight,
          cta: R(cta), first: R(document.querySelector(firstSel)), steps: R(steps), stepsVisible: !!steps && steps.getBoundingClientRect().height > 0, noticeH: n ? Math.round(n.getBoundingClientRect().height) : 0, minTap: Math.round(minTap), smallTaps };
      }, CTA[screen], FIRST[screen]);
      const vis = m.cta.b <= m.fold;
      parts.push(`${notice.padEnd(4)} nH=${String(m.noticeH).padStart(2)} fold=${m.fold} cta=${m.cta.y}-${m.cta.b} ${vis ? 'VISIBLE ' : 'BELOW+' + (m.cta.b - m.fold)}` + (screen==='SIGN' ? ` firstPad=${m.first?.y}-${m.first?.b}` : '') + ` scroll=${m.scrollH}/${m.clientH}`);
      rows.push({ w, h, lang, screen, notice, ...m, vis });
      if (!m.stepsVisible) parts.push('!!STEPS-HIDDEN');
      if (m.smallTaps.length) parts.push('!!TAP<44:' + m.smallTaps.join(','));
      if (SHOTS && notice === '2') await page.screenshot({ path: `${S}/shot-${TAG}-${w}x${h}-${lang}-${screen}.png` });
    }
    console.log(`${w}x${h} ${lang} ${screen.padEnd(7)} ${parts.join(' | ')}`);
  }
}
import('node:fs').then(fs => fs.writeFileSync(`${S}/measure-${TAG}.json`, JSON.stringify(rows)));
await browser.close();
