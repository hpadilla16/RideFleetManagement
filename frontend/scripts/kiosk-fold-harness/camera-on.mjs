import { createRequire } from 'node:module';
const puppeteer = createRequire(new URL('../../../backend/package.json', import.meta.url))('puppeteer');
const BASE=process.env.BASE||'http://localhost:3105'; const TAG=process.env.TAG||'before';
const browser = await puppeteer.launch({headless:true, args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => { localStorage.setItem('ride_kiosk_device', JSON.stringify({ name: 'iPad Counter 1', location: { name: 'San Juan Airport' }, tenant: { name: 'International Rental Corp' } })); });
for (const [w,h] of [[1024,768],[1180,820]]) { await page.setViewport({width:w,height:h});
 for (const lang of ['es','en']) for (const notice of ['none','2']) {
  await page.goto(`${BASE}/kiosk/fold-harness?screen=ID&lang=${lang}&notice=${notice}`,{waitUntil:'networkidle0'});
  await page.waitForSelector('html[data-harness-ready]');
  await page.click('.kio-main .kio-row > .kio-btn:not(.ghost)');
  try { await page.waitForFunction(() => { const v=document.querySelector('.kio-scanbox video'); return v && v.videoWidth>0 && v.getBoundingClientRect().height>50; }, {timeout:8000}); } catch { console.log('no video'); }
  const m = await page.evaluate(() => { const R=(e)=>{const b=e.getBoundingClientRect();return `${Math.round(b.y)}-${Math.round(b.bottom)} (h${Math.round(b.height)} w${Math.round(b.width)})`;};
    const v=document.querySelector('.kio-scanbox video'); const cta=document.querySelector('.kio-main .kio-row > .kio-btn:not(.ghost)'); const main=document.querySelector('.kio-main');
    return `video=${v?R(v)+' '+v.videoWidth+'x'+v.videoHeight:'none'} scanbox=${R(document.querySelector('.kio-scanbox'))} cta="${cta.textContent.trim().slice(0,22)}" ${R(cta)} fold=${Math.round(main.getBoundingClientRect().bottom)}`; });
  console.log(`${w}x${h} ${lang} notice=${notice} CAMERA-ON ${m}`);
  if (lang==='es' && notice==='2' && w===1024) await page.screenshot({path:`${process.env.S}/shot-${TAG}-camera-on-1024x768-es.png`});
 } }
await browser.close();
