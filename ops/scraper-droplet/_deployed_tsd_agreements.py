#!/usr/bin/env python3
"""TollBridge TSD OPEN-agreements sync (Camoufox).
Logs into TSD, lists OPEN agreements, scrapes each renter/vehicle/window/prepaid, batches them
and POSTs to TollBridge /api/internal/agreements/upsert. Reuses the tsd_customers.py iframe flow.
Read-only against TSD (navigates ViewRA + the OPEN index; never writes).
2026-06-18: login hardening — single dialog handler + clean logout at end (frees the single-window)."""
import os, sys, json, time, re, datetime, logging, urllib.request, urllib.parse, urllib.error
from camoufox.sync_api import Camoufox

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tb-tsd-ag")

BASE = "https://www.tsdrms.net"
LOGIN_URL = BASE + "/"
# TSD OPEN-RA list. CurrOpenRa.aspx ("Opened Rental Agreements") is the direct open-RA grid for
# this install (found via the menu probe 2026-06-17). Fallbacks kept just in case.
OPEN_INDEX_URLS = [
    BASE + "/CurrOpenRa.aspx",
    BASE + "/RALook.aspx",
]
TOLLBRIDGE_BASE = os.environ.get("TOLLBRIDGE_BASE", "").rstrip("/")
TENANT_ID = os.environ.get("TOLLBRIDGE_TENANT_ID", "").strip()
TOKEN = os.environ.get("TOLLBRIDGE_TOKEN", "").strip()
LIMIT = int(os.environ.get("TSD_AG_LIMIT", "0") or "0")
DEBUG = os.environ.get("TSD_AG_DEBUG") in ("1", "true", "True")
BATCH = int(os.environ.get("TSD_AG_BATCH", "50") or "50")

# Scrape the renter + vehicle + window off a ViewRA page (server-rendered input values).
# Arg `indicators`: the effective NON-BILLABLE substrings for THIS RA's location (from scrape-config).
# Any case-insensitive hit in the RA body → prepaid=true → the renter is NEVER billed (no write-back,
# no email). The literal PRE-PAID SUNPASS regex stays as a hard fallback if config is missing.
SCRAPE_JS = """(indicators) => {
  const v = id => { const e = document.getElementById(id); return e ? (e.value||'').trim() : null; };
  const txt = id => { const e = document.getElementById(id); return e ? (e.innerText||'').trim() : null; };
  let status = '';
  for (const id of ['lblStatus','lblStatus2','lblStatus3']) { const t = txt(id); if (t) { status = t; break; } }
  const body = (document.body.innerText || '');
  const UP = body.toUpperCase();
  const inds = Array.isArray(indicators) ? indicators : [];
  const nb = inds.some(s => s && UP.includes(String(s).toUpperCase()));
  const prepaid = nb || /PRE-?PAID\\s+SUNPASS/i.test(body);
  // RA balance (for payment reconciliation). Try known fields, then a labeled text scan. balanceVia
  // tells us HOW we got it so the dry-run can be verified against the TSD screen before trusting it.
  let balanceRaw = null, balanceVia = null;
  for (const id of ['txtBalance','txtBalanceDue','txtTotalDue','txtAmountDue','txtBal','txtBalanceDueAmt','txtBalanceAmt','txtTotalBalance','lblBalance','lblBalanceDue']) {
    const val = v(id) || txt(id);
    if (val) { balanceRaw = val; balanceVia = '#'+id; break; }
  }
  if (balanceRaw == null) {
    const m = body.match(/(?:Balance\\s*Due|Amount\\s*Due|Balance)\\s*:?\\s*\\$?\\s*(-?[\\d,]+\\.\\d{2})/i);
    if (m) { balanceRaw = m[1]; balanceVia = 'text-scan'; }
  }
  return {
    ra: v('txtRANum'), last: v('txtLastName'), first: v('txtFirstName'),
    lic: v('txtLicNum'), email: v('txtEmail'),
    plate: v('txtVehPlate') || v('txtPlate') || v('txtLicensePlate') || v('txtVehLicNum'),
    veh: v('txtVehicle') || v('txtVehDesc'),
    pickup: v('txtPickupDate'), dropoff: v('txtDropOffDate'),
    status, prepaid, balanceRaw, balanceVia
  };
}"""

# Effective non-billable indicators (SunPass prepaid / discount), loaded from scrape-config per tenant:
#   { "default": [...], "byLocationCode": { "MIAA02": [...], ... } }
# Data-driven so a new client/location is configured in Settings, never in code. Falls back to the
# built-in default until scrape-config is loaded.
NON_BILLABLE = {"default": ["PREPAID SUNPASS", "SUNPASS DISCOUNT"], "byLocationCode": {}}


def _nb_indicators_for(knum):
    """The effective non-billable substrings for an RA's location (the KNum prefix is the TSD code)."""
    try:
        loc = str(knum).split("-", 1)[0]
    except Exception:
        loc = ""
    by = NON_BILLABLE.get("byLocationCode") or {}
    return by.get(loc) or NON_BILLABLE.get("default") or []


# Per-location write-back charge code (regex vs the RACharge dropdown), from scrape-config:
#   { "default": "SUNPASS FEE|\\(SPF\\)", "byLocationCode": { "MIAA02": "TOLL COST|\\(22\\)", ... } }
# So each market posts the toll fee under its own code, data-driven (no code per new location).
# The byLocationCode below is a SAFETY FALLBACK for known markets (Miami = TOLL COST, which has no
# SUNPASS FEE option) — scrape-config overrides it on load; if the config load ever fails, Miami still
# posts under the right code instead of silently skipping on the SPF default. Orlando = SPF default.
CHARGE_CODE_RX = {"default": r'SUNPASS\s*FEE|\(SPF\)', "byLocationCode": {"MIAA02": r'TOLL COST|\(22\)'}}


def _charge_code_rx_for(knum):
    """The write-back charge-code regex for an RA's location (KNum prefix = TSD code); default SPF."""
    try:
        loc = str(knum).split("-", 1)[0]
    except Exception:
        loc = ""
    by = CHARGE_CODE_RX.get("byLocationCode") or {}
    return by.get(loc) or CHARGE_CODE_RX.get("default") or r'SUNPASS\s*FEE|\(SPF\)'


# Pull KNums off the CurrOpenRa grid. Robust: links with KNum=, __doPostBack args that look like an
# RA number, and as a fallback, grid cells whose text matches the RA-number pattern (e.g. MCO-1234).
INDEX_JS = """() => {
  const out = new Set();
  for (const a of document.querySelectorAll('a, [onclick]')) {
    const h = a.getAttribute('href') || '';
    const o = a.getAttribute('onclick') || '';
    let m = (h + ' ' + o).match(/KNum=([A-Za-z0-9-]+)/i);
    if (m) { out.add(m[1]); continue; }
    m = o.match(/[A-Z]{2,5}-\\d{2,}/);
    if (m) out.add(m[0]);
  }
  if (out.size === 0) {
    for (const c of document.querySelectorAll('td, span, div')) {
      const t = (c.innerText || '').trim();
      if (/^[A-Z]{2,5}-\\d{2,}$/.test(t)) out.add(t);
    }
  }
  return [...out];
}"""

# The CurrOpenRa report opens as a PDF in Firefox's pdf.js viewer. Pull ALL pages' text via the
# viewer API (the text layer only renders visible pages, so we go through the document directly).
PDF_TEXT_JS = """async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const app = window.PDFViewerApplication;
    if (!app) return 'NOAPP';
    // Wait for the viewer to actually have the document ready (race: we may read too early).
    for (let i = 0; i < 80; i++) {            // up to ~20s
      if (app.pdfDocument && app.pdfDocument.numPages) break;
      if (app.pdfLoadingTask) { try { await app.pdfLoadingTask.promise; } catch (e) {} }
      await sleep(250);
    }
    const pdf = app.pdfDocument;
    if (!pdf || !pdf.numPages) return 'NODOC';
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const tc = await pg.getTextContent();
      out += tc.items.map(x => x.str).join(' ') + '\\n';
    }
    return out;
  } catch (e) { return 'ERR:' + ((e && e.message) || e); }
}"""

# RA / KNum token as printed in the report (e.g. MCOA01-72638): location code (letters+digits) + 5-6 digit seq.
KNUM_RE = re.compile(r'[A-Z]{2,6}[0-9]{0,3}-[0-9]{4,6}')


def make_dialog_handler():
    """ONE handler for the whole page lifetime: log + accept, with accept guarded so a
    double-fire can never raise 'Cannot accept dialog which is already handled'."""
    def _h(d):
        try:
            log.info("[dialog] %s", (getattr(d, 'message', '') or '')[:140])
        except Exception:
            pass
        try:
            d.accept()
        except Exception:
            pass
    return _h


def is_login_page(page):
    try:
        return page.query_selector('#txtPassword') is not None
    except Exception:
        return False


def login(page):
    log.info("logging in to TSD...")
    page.goto(LOGIN_URL, wait_until="load", timeout=60000)
    for fid, env in (("#txtTsdNum", "TSD_NUM"), ("#txtCustAcctCoNum", "TSD_CO"),
                     ("#txtUsername", "TSD_USER"), ("#txtPassword", "TSD_PASS")):
        val = os.environ.get(env, "")
        # Prefer a dedicated scraper TSD user (no single-window clash with staff's interactive session).
        if env == "TSD_USER":
            val = os.environ.get("TB_TSD_USER") or val
        elif env == "TSD_PASS":
            val = os.environ.get("TB_TSD_PASS") or val
        if not val:
            continue
        el = page.query_selector(fid)
        if el and el.is_visible():
            try:
                page.fill(fid, val)
            except Exception as e:  # noqa: BLE001
                log.warning("could not fill %s: %s", fid, str(e)[:90])
    # Don't let Playwright's click auto-wait (30s) block on the post-back navigation; we wait for
    # it ourselves below (more forgiving when TSD is slow), and surface the page text on failure.
    try:
        page.click('#LoginBtn', no_wait_after=True)
    except Exception as e:  # noqa: BLE001
        log.warning("login click warn: %s", str(e)[:90])
    # More retries than before (5) — TSD post-back can be slow and the single-window prompt may
    # need a moment after the previous session is released.
    for _ in range(5):
        try:
            page.wait_for_load_state("networkidle", timeout=30000)
        except Exception:
            pass
        if not is_login_page(page):
            break
        time.sleep(3)
    if is_login_page(page):
        body = (page.inner_text("body") or "")[:300]
        raise RuntimeError("TSD login failed (still on login). Page: " + body.replace("\n", " "))
    log.info("login OK (url=%s)", page.url)


def logout(page):
    """Best-effort: release the TSD single-window session so the NEXT cron run (and the staff)
    log in clean. Searches every frame for a logout control; falls back to candidate URLs.
    Wrapped so it never raises — a failed logout must not fail the run."""
    try:
        if is_login_page(page):
            return True  # already out
    except Exception:
        pass
    find_logout = """() => {
      const cands = [...document.querySelectorAll('a,[onclick],input[type=button],input[type=submit],button')];
      const re = /log\\s*-?\\s*out|sign\\s*out|log\\s*off|logoff|cerrar\\s+sesi/i;
      const hit = cands.find(a => re.test(((a.innerText||a.value||'') + ' ' + (a.getAttribute('href')||'') + ' ' + (a.getAttribute('onclick')||''))));
      if (hit) { hit.click(); return true; }
      return false;
    }"""
    try:
        frames = [page.main_frame] + [f for f in page.frames if f is not page.main_frame]
        for fr in frames:
            try:
                if fr.evaluate(find_logout):
                    log.info("logout link clicked (frame=%s)", (fr.url or '')[:70])
                    time.sleep(2)
                    if is_login_page(page):
                        log.info("logout OK (back on login)")
                    return True
            except Exception:
                pass
        # Fallback: try common ASP.NET logout endpoints.
        for u in ("/Logout.aspx", "/LogOut.aspx", "/Account/Logout.aspx", "/Default.aspx?logout=1"):
            try:
                page.goto(BASE + u, wait_until="load", timeout=20000)
                if is_login_page(page):
                    log.info("logout via %s OK", u)
                    return True
            except Exception:
                pass
        log.warning("logout: no logout control found (session will expire on TSD timeout)")
    except Exception as e:  # noqa: BLE001
        log.warning("logout best-effort failed: %s", str(e)[:120])
    return False


def content_frame(page):
    # Wrapped: during the Run->PDF navigation the execution context can be destroyed mid-query.
    try:
        el = page.query_selector('#Content1')
        return el.content_frame() if el else None
    except Exception:
        return None


def drive_frame(page, url):
    """Navigate the #Content1 app-shell iframe to url, like the in-app flow."""
    try:
        page.eval_on_selector('#Content1', "(el, u) => { el.contentWindow.location.href = u; }", url)
        return True
    except Exception:
        try:
            page.goto(url, wait_until="load", timeout=60000)
        except Exception:
            pass
        return False


def frame_or_main(page, url_part):
    fr = content_frame(page)
    if fr and url_part.lower() in (fr.url or '').lower():
        return fr
    return page.main_frame


def list_open_knums(page, debug=False):
    """Run the CurrOpenRa report (Current Open R/As, Detail) and parse the KNums from the grid.
    CurrOpenRa.aspx renders TOP-LEVEL (no #Content1 iframe) and needs the 'Run' button clicked;
    the relevant options are checked by default (optCurrentOpen + chkOnlyOpenRA + exclude
    voided/transfer). Returns a list of KNum strings."""
    url = BASE + "/CurrOpenRa.aspx"
    drive_frame(page, url)

    # The CurrOpenRa form sometimes renders top-level and sometimes inside #Content1 — locate the
    # frame that actually has #btnRun (re-login if the session dropped).
    def report_frame():
        try:
            if page.query_selector('#btnRun'):
                return page.main_frame
        except Exception:
            pass
        fr = content_frame(page)
        if fr:
            try:
                if fr.query_selector('#btnRun'):
                    return fr
            except Exception:
                pass
        return None

    rf = None
    for _ in range(60):  # up to ~30s (login can be slow)
        time.sleep(0.5)
        if is_login_page(page):
            login(page); drive_frame(page, url); continue
        rf = report_frame()
        if rf:
            break
    if not rf:
        log.warning("CurrOpenRa form not found (no #btnRun in main or #Content1)")
        return []

    ctx = page.context

    # Enable "All Locations" so the report covers EVERY location (MCOA01 + MCO/Advantage).
    # #chkAllrlbLocs is an AUTOPOSTBACK checkbox: setting .checked alone doesn't register
    # server-side, so we CLICK it (fires __doPostBack), wait for the reload, and re-find the frame.
    try:
        clicked_all = rf.evaluate("() => { const a = document.getElementById('chkAllrlbLocs'); if (a && !a.checked) { a.click(); return true; } return false; }")
        if clicked_all:
            time.sleep(1.5)
            try:
                page.wait_for_load_state('networkidle', timeout=15000)
            except Exception:
                pass
            rf = report_frame() or rf
            log.info("all-locations enabled (chkAllrlbLocs)")
    except Exception as e:  # noqa: BLE001
        log.warning("chkAllrlbLocs click warn: %s", str(e)[:80])

    # Run needs a Display mode (Detail) selected, or it just throws a validation alert and no-ops.
    # optDetail is a plain radio (no onclick handler) so setting it does NOT trigger a postback.
    try:
        rf.evaluate("() => { const e = document.getElementById('optDetail'); if (e) { e.checked = true; if (e.click) e.click(); } const a = document.getElementById('chkAllrlbLocs'); if (a) { a.checked = true; } }")
    except Exception as e:  # noqa: BLE001
        log.warning("optDetail set warn: %s", str(e)[:80])

    # NOTE: the dialog handler is registered ONCE in main() (page.on('dialog', ...)). We deliberately
    # do NOT register another one here — re-registering per call stacked handlers and caused
    # "Dialog.accept: Cannot accept dialog which is already handled".

    # The report PDF (ShowFile.aspx ... OpenedAgreements.pdf) shows up inconsistently: sometimes a
    # new popup tab, sometimes in-place. Scan EVERY page + frame in the context for the PDF url.
    def find_pdf():
        for p in ctx.pages:
            try:
                if 'showfile' in (p.url or '').lower() or '.pdf' in (p.url or '').lower():
                    return p, p
            except Exception:
                pass
            for fr in p.frames:
                try:
                    if 'showfile' in (fr.url or '').lower() or '.pdf' in (fr.url or '').lower():
                        return p, fr
                except Exception:
                    pass
        return None, None

    # Capture a download too — Firefox may hand back the report PDF as a download instead of a viewer.
    downloads = []
    try:
        ctx.on("download", lambda d: downloads.append(d))
    except Exception:
        pass

    # Capture the ShowFile PDF RESPONSE as it loads (its byte stream) — re-fetching the one-time URL
    # later returns HTML, so we grab the bytes at load time. Attach to the main page + any popups.
    pdf_resps = []
    def _attach_resp(pg):
        try:
            pg.on("response", lambda r: pdf_resps.append(r)
                  if 'showfile' in (getattr(r, 'url', '') or '').lower() else None)
        except Exception:
            pass
    _attach_resp(page)
    try:
        ctx.on("page", _attach_resp)
    except Exception:
        pass

    def click_run():
        # JS-dispatch the click → fires btnRun's onclick directly, no actionability wait (which hangs
        # 30s when the button gets covered/disabled). Re-set Detail each time for good measure.
        rf2 = report_frame()
        if rf2 is None:
            return False
        try:
            rf2.evaluate("""() => {
              const d = document.getElementById('optDetail'); if (d) { d.checked = true; }
              const a = document.getElementById('chkAllrlbLocs'); if (a) { a.checked = true; }
              const b = document.getElementById('btnRun'); if (b) b.click();
            }""")
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("btnRun js-click warn: %s", str(e)[:80])
            return False

    # JS-click Run every ~6s (cheap, non-blocking) until the PDF surfaces, up to ~90s.
    clicks = 0
    pdf_page, pdf_target = None, None
    t_end = time.time() + 95
    last_click = 0.0
    while time.time() < t_end:
        if clicks < 6 and (time.time() - last_click) > 6 and report_frame() is not None:
            if click_run():
                clicks += 1
            last_click = time.time()
            time.sleep(2)
        pdf_page, pdf_target = find_pdf()
        if pdf_target:
            log.info("Run produced the report PDF (clicks=%d)", clicks)
            break
        if downloads:
            log.info("Run produced a DOWNLOAD: %s", getattr(downloads[0], 'suggested_filename', '?'))
            break
        if is_login_page(page):
            login(page); drive_frame(page, url); time.sleep(2)
        time.sleep(1)

    if not pdf_target and downloads:
        # Save the downloaded PDF for parsing.
        try:
            downloads[0].save_as("/tmp/tb_openedagreements.pdf")
            log.info("[debug] saved download → /tmp/tb_openedagreements.pdf")
        except Exception as e:  # noqa: BLE001
            log.warning("download save err: %s", str(e)[:80])

    if not pdf_target:
        log.warning("Run did not surface a viewable PDF. clicks=%d downloads=%d ctx_pages=%s",
                    clicks, len(downloads), [(p.url or '')[:90] for p in ctx.pages])
        return ""

    try:
        pdf_page.wait_for_load_state("load", timeout=30000)
    except Exception:
        pass

    pdf_url = None
    try:
        pdf_url = pdf_target.url if hasattr(pdf_target, 'url') else None
        if not pdf_url:
            pdf_url = pdf_page.url
    except Exception:
        pass

    def extract_from(tgt):
        t = ""
        for _ in range(30):  # up to ~30s for pdf.js to finish loading the document
            try:
                t = tgt.evaluate(PDF_TEXT_JS)
            except Exception as e:  # noqa: BLE001
                t = "ERR:" + str(e)[:80]
            if t and not t.startswith(("ERR:", "NOAPP", "NODOC")) and KNUM_RE.search(t):
                return t
            time.sleep(1)
        return t

    # Get the PDF bytes. PRIMARY: the response we captured as the report loaded (the one-time URL
    # can't be re-fetched). FALLBACK: a fresh request.get of the URL.
    body = None
    for r in reversed(pdf_resps):
        try:
            b = r.body()
            if b and b[:4] == b'%PDF':
                body = b
                break
        except Exception:
            pass
    if not body and pdf_url and 'showfile' in pdf_url.lower():
        try:
            b = page.context.request.get(pdf_url, timeout=60000).body()
            if b and b[:4] == b'%PDF':
                body = b
            else:
                log.warning("PDF re-fetch non-PDF (%d bytes head=%r)", len(b or b''), (b or b'')[:10])
        except Exception as e:  # noqa: BLE001
            log.warning("PDF re-fetch err: %s", str(e)[:140])

    text = ""
    if body:
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(stream=body, filetype="pdf")
            text = "\n".join(pg.get_text() for pg in doc)
            log.info("[debug] PDF %d bytes, %d pages → %d chars", len(body), doc.page_count, len(text))
        except Exception as e:  # noqa: BLE001
            log.warning("fitz parse err: %s", str(e)[:140])

    # Last-ditch: the pdf.js viewer (works when the PDF opened as a real top-level viewer tab).
    if not KNUM_RE.search(text or ""):
        text = extract_from(pdf_target) or text

    if debug:
        try:
            open("/tmp/tb_curropenra_pdftext.txt", "w").write(text or "")
            log.info("[debug] pdf text bytes=%d, distinct KNums=%d",
                     len(text or ""), len(set(KNUM_RE.findall(text or ""))))
        except Exception:
            pass
    return text or ""


# Parse the "Current Open Rental Agreements" PDF text into full agreement rows. Each record:
#   <KNum>  <LAST, FIRST>  <CLASS(4)>  <Unit#=PLATE>  <LocOut> <LocExp>  <Date Out>  <Exp Date> ...
REC_RE = re.compile(
    r'(?P<knum>(?:MCOA01|MCO)-\d+)\s+'
    r'(?P<name>.+?)\s+'
    r'(?P<cls>[A-Z]{3,4})\s+'
    r'(?P<plate>[A-Z0-9]{4,8})\s+'
    r'(?P<loc>MCOA0|MCO)\s*(?P=loc)\s+'  # Loc Out + Loc Exp — fitz joins them ("MCOA0MCOA0"); strong anchor
    r'(?P<dout>\d{2}/\d{2}/\d{4} \d{2}:\d{2} [AP]M)\s+'
    r'(?P<dexp>\d{2}/\d{2}/\d{4} \d{2}:\d{2} [AP]M)'
)


def _iso(s):
    try:
        return datetime.datetime.strptime(s.strip(), "%m/%d/%Y %I:%M %p").isoformat()
    except Exception:  # noqa: BLE001
        return None


def parse_open_agreements(text):
    # per-record multi-location parser: split by KNum (MCOA01 / MCO / MIAA02 / any future code),
    # derive locationCode from the KNum, and pull the two dates + name + unit#/plate. Company-agnostic.
    KN = re.compile(r'\b([A-Z]{2,6}\d{0,3})-(\d{4,6})\b')
    DT = re.compile(r'\d{2}/\d{2}/\d{4} \d{2}:\d{2} [AP]M')
    CLS = re.compile(r'^[A-Z]{3,4}$')
    full = text or ''
    ms = list(KN.finditer(full))
    rows = []
    for i, m in enumerate(ms):
        loc = m.group(1)
        knum = m.group(0)
        seg = full[m.end():(ms[i + 1].start() if i + 1 < len(ms) else len(full))]
        block = re.sub(r'\s+', ' ', seg).strip()
        dts = DT.findall(block)
        if len(dts) < 2:
            continue  # header / non-record (no rental window)
        dout, dexp = dts[0], dts[1]
        head = block[:block.index(dout)]
        # strip trailing Loc Out + Loc Exp (the location code repeated, possibly 5-char truncated),
        # keyed off the KNum's code so an alphanumeric plate like XCH361 is never eaten.
        strip_re = re.compile(r'(?:\s*(?:%s|%s)){1,3}\s*$' % (re.escape(loc), re.escape(loc[:5])))
        head = strip_re.sub('', head).strip()
        toks = [tok for tok in head.split(' ') if tok]
        cls_idx = max((j for j, tok in enumerate(toks) if CLS.match(tok)), default=-1)
        if cls_idx >= 0:
            plate = ''.join(toks[cls_idx + 1:])
            name = ' '.join(toks[:cls_idx]).strip()
        else:
            plate = toks[-1] if toks else ''
            name = ' '.join(toks[:-1]).strip()
        parts = [x.strip() for x in name.split(',', 1)]
        last = parts[0]
        first = parts[1] if len(parts) > 1 else ''
        rows.append({
            "externalRef": knum,
            "renterName": (first + ' ' + last).strip() or name,
            "plate": plate,
            "pickupAt": _iso(dout),
            "dropoffAt": _iso(dexp),
            "status": "OPEN",
            "prepaid": False,
            "locationCode": loc,
        })
    return rows


def _viewra_frame(page):
    """The frame that actually holds the ViewRA form (#txtRANum) — main page or the #Content1 shell."""
    for fr in [page.main_frame] + [f for f in page.frames if f is not page.main_frame]:
        try:
            if fr.query_selector('#txtRANum'):
                return fr
        except Exception:
            pass
    return None


def scrape_ra(page, knum, debug=False):
    """Open a specific RA and scrape it. NOTE (2026-06-29): TSD's ViewRA.aspx?KNum= URL no longer loads
    the RA directly — it redirects to Default. The working flow is: open ViewRA.aspx (blank), type the
    RA number into #txtRANum and BLUR it (Tab), which fires onchange=txtRANum_onchange('ViewRA') and
    loads the RA. Requires the login that OWNS the RA's location (a foreign login redirects to Default)."""
    url = BASE + "/ViewRA.aspx"
    relogged = False
    rec = None
    # Up to 4 full attempts: (re)navigate to the blank ViewRA, enter the RA#, fire onchange, wait for
    # the RA to load. ViewRA.aspx sometimes redirects to Default and the onchange-load is occasionally
    # flaky, so we retry the whole flow rather than wait once. (Also tolerant of single-window bounces.)
    for outer in range(4):
        drive_frame(page, url)
        fr = None
        for i in range(40):  # ~12s for the form (#txtRANum); re-navigate if it landed on Default
            time.sleep(0.3)
            if is_login_page(page) and not relogged:
                login(page); relogged = True; drive_frame(page, url); continue
            fr = _viewra_frame(page)
            if fr:
                break
            if i and i % 20 == 0:
                drive_frame(page, url)
        if not fr:
            continue
        # Enter the RA number and fire onchange (Tab blur + explicit change dispatch) → loads the RA.
        try:
            fr.fill('#txtRANum', str(knum))
            fr.press('#txtRANum', 'Tab')
            fr.evaluate("() => { const e = document.getElementById('txtRANum'); if (e) e.dispatchEvent(new Event('change', { bubbles: true })); }")
        except Exception as e:  # noqa: BLE001
            log.warning("scrape_ra %s: fill/blur warn: %s", knum, str(e)[:120])
        for _ in range(40):  # ~12s for the RA to actually load (real fields populate, not just txtRANum)
            time.sleep(0.3)
            try:
                r = fr.evaluate(SCRAPE_JS, _nb_indicators_for(knum))
            except Exception:
                fr = _viewra_frame(page) or fr
                r = None
            if r and (r.get("last") or r.get("pickup")):
                rec = r; break
        if rec:
            break
        log.info("scrape_ra %s: not loaded on attempt %d/4 — retrying", knum, outer + 1)
    if not rec:
        log.warning("scrape_ra %s: RA did not load after 4 attempts (foreign login? RA not found? TSD busy?)", knum)
    if debug and rec:
        log.info("[debug] sample RA %s → %s", knum, json.dumps(rec, ensure_ascii=False)[:300])
    return rec


def to_row(knum, rec):
    name = " ".join([x for x in [rec.get("first"), rec.get("last")] if x]) or None
    return {
        "externalRef": knum,
        "renterName": name,
        "renterLicense": rec.get("lic"),
        "plate": rec.get("plate"),
        "pickupAt": rec.get("pickup"),
        "dropoffAt": rec.get("dropoff"),
        "status": rec.get("status") or "OPEN",
        "prepaid": bool(rec.get("prepaid")),
        "locationCode": None,
    }


def _tb_reconcile(open_refs):
    """Tell TollBridge the CURRENT full set of OPEN KNums so it can close the ones TSD dropped."""
    refs = [str(x).strip() for x in (open_refs or []) if x]
    if not refs:
        return
    url = f"{TOLLBRIDGE_BASE}/api/internal/agreements/reconcile"
    _codes = [c.strip() for c in os.environ.get("TB_LOCATION_CODES", "").split(",") if c.strip()]
    _body = {"tenantId": TENANT_ID, "openRefs": refs}
    if _codes:
        _body["locationCodes"] = _codes
    payload = json.dumps(_body).encode()
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode()
        log.info("reconcile %d open refs -> %s %s", len(refs), resp.status, body[:200])


def post_batch(rows):
    if not rows:
        return
    url = f"{TOLLBRIDGE_BASE}/api/internal/agreements/upsert"
    payload = json.dumps({"tenantId": TENANT_ID, "rows": rows}).encode()
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode()
            log.info("upsert %d rows → %s %s", len(rows), resp.status, body[:300])
    except Exception as e:  # noqa: BLE001
        log.error("upsert POST failed (%d rows): %s", len(rows), str(e)[:300])
        raise


# --- Automatic toll-invoice email phase (DARK by default) ----------------------------------------
# Runs AFTER the open-sync, in the SAME login session (no extra single-window clash), then logout.
# Enabled only when TB_TOLL_EMAILS=1. Test mode (TB_TOLL_EMAILS_TEST=1) sends the REAL rendered
# invoice to TB_TOLL_EMAILS_TEST_TO via the backend's test path (never marks the agreement). It does
# NOT move money or write back to TSD — it only asks TollBridge to email the already-computed invoice.
def _http_json(url, body=None, method="GET", timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode()
        try:
            return resp.status, json.loads(raw)
        except Exception:  # noqa: BLE001
            return resp.status, raw


# Effective location scope for the email/reconcile phases. A TSD login can only open the RA pages of
# ITS OWN locations (opening another login's RA just redirects to Default), so the phase MUST be scoped
# to the current login's locations (TB_LOCATION_CODES, set per-connection by the multi-login runner).
# An optional go-live filter (TB_TOLL_LOCATIONS, e.g. "MIAA02") further restricts it via intersection.
# Returns (codes_csv, skip): skip=True means this login has no in-scope locations → do nothing.
def _effective_loc_codes():
    login = [c.strip() for c in (os.environ.get("TB_LOCATION_CODES") or "").split(",") if c.strip()]
    golive = [c.strip() for c in (os.environ.get("TB_TOLL_LOCATIONS") or "").split(",") if c.strip()]
    if login and golive:
        inter = [c for c in login if c in golive]
        return (",".join(inter), len(inter) == 0)  # empty intersection → this login skips
    if login:
        return (",".join(login), False)
    if golive:
        return (",".join(golive), False)
    return ("", False)  # no scope at all (single-login, no filter) → all locations


def _tb_pending_toll_emails(codes=""):
    """CLOSED+billable agreements TollBridge still needs to email. [{externalRef, needsEmailScrape}]"""
    params = {"tenantId": TENANT_ID}
    if codes:
        params["locationCodes"] = codes
    q = urllib.parse.urlencode(params)
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/agreements/pending-toll-emails?{q}", timeout=60)
    return data if isinstance(data, list) else []


def _tb_send_toll_invoice(external_ref, email=None, test=False):
    body = {"tenantId": TENANT_ID, "externalRef": external_ref}
    if email:
        body["email"] = email
    if test:
        body["test"] = True
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/agreements/send-toll-invoice", body=body, method="POST")
    return data


def _tb_set_prepaid(external_ref, prepaid=True):
    """Flag an agreement as having a TOLL PACKAGE (prepaid) so the backend excludes it from billing/
    email and the reconcile auto-closes it as PREPAID_PACKAGE. Prepaid is discovered live off ViewRA."""
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/agreements/set-prepaid",
                         body={"tenantId": TENANT_ID, "externalRef": external_ref, "prepaid": bool(prepaid)}, method="POST")
    return data


def scrape_email(page, knum):
    """Open ViewRA for a (possibly CLOSED) KNum and return the renter email off txtEmail (or None)."""
    rec = scrape_ra(page, knum)
    return (rec or {}).get("email") or None


def run_toll_email_phase(page):
    """DARK by default. When TB_TOLL_EMAILS=1: for each CLOSED+billable agreement TollBridge reports
    as pending, scrape the renter email from ViewRA (when needed) and ask TollBridge to send the
    invoice. Idempotent on the backend (atomic claim on tollInvoiceEmailedAt). Wrapped so it can
    never fail the open-sync run."""
    if not os.environ.get("TB_TOLL_EMAILS"):
        return
    test = bool(os.environ.get("TB_TOLL_EMAILS_TEST"))
    test_to = (os.environ.get("TB_TOLL_EMAILS_TEST_TO") or "").strip()
    if test and not test_to:
        log.warning("[toll-email] TEST mode on but TB_TOLL_EMAILS_TEST_TO not set — skipping")
        return
    # Belt-and-suspenders: a LIVE (real-customer) send requires an EXPLICIT second flag. This way,
    # TB_TOLL_EMAILS=1 without TB_TOLL_EMAILS_TEST and without TB_TOLL_EMAILS_LIVE can NEVER blast
    # real renters by accident (e.g. if the test flag was half-cleared). Mode is logged loudly.
    live = bool(os.environ.get("TB_TOLL_EMAILS_LIVE"))
    if not test and not live:
        log.warning("[toll-email] enabled but neither TEST nor LIVE set — set TB_TOLL_EMAILS_TEST (+ _TEST_TO) to test, or TB_TOLL_EMAILS_LIVE=1 to bill real customers. SKIPPING.")
        return
    codes, skip = _effective_loc_codes()
    if skip:
        log.info("[toll-email] no in-scope locations for this login (login=%s, go-live=%s) — skipping",
                 os.environ.get("TB_LOCATION_CODES") or "-", os.environ.get("TB_TOLL_LOCATIONS") or "-")
        return
    log.info("[toll-email] MODE=%s%s", "TEST→%s" % test_to if test else "LIVE (real customers)", (" scope=%s" % codes) if codes else "")
    try:
        pending = _tb_pending_toll_emails(codes)
    except Exception as e:  # noqa: BLE001
        log.warning("[toll-email] pending fetch failed: %s", str(e)[:160])
        return
    if not pending:
        log.info("[toll-email] nothing pending")
        return
    limit = int(os.environ.get("TB_TOLL_EMAILS_LIMIT", "1" if test else "0") or "0")
    if limit:
        pending = pending[:limit]
    log.info("[toll-email] %d pending (test=%s, limit=%s)", len(pending), test, limit or "all")
    sent = 0; prepaid_skipped = 0
    for item in pending:
        ref = (item or {}).get("externalRef")
        if not ref:
            continue
        # ALWAYS open the RA: we need the LIVE prepaid flag (toll package on TSD) AND the email.
        rec = None
        try:
            rec = scrape_ra(page, ref)
        except Exception as e:  # noqa: BLE001
            log.warning("[toll-email] %s ViewRA scrape failed: %s", ref, str(e)[:120])
        # PREPAID (toll package on TSD): NEVER email this renter — they prepaid. Flag it (LIVE) so the
        # backend excludes it and the reconcile auto-closes it as PREPAID_PACKAGE.
        if rec and rec.get("prepaid"):
            prepaid_skipped += 1
            if test:
                log.info("[toll-email] TEST %s has a toll package (prepaid) — would flag + NOT email", ref)
            else:
                try:
                    _tb_set_prepaid(ref, True)
                    log.info("[toll-email] %s has a toll package (prepaid) — flagged, NOT emailing", ref)
                except Exception as e:  # noqa: BLE001
                    log.warning("[toll-email] %s set-prepaid failed: %s", ref, str(e)[:120])
            continue
        scraped = (rec or {}).get("email")
        # TEST: always send to the operator's address (never the customer); LIVE: the scraped customer
        # email (or the one already on file in TollBridge when we couldn't scrape).
        recipient = test_to if test else scraped
        if not test and not recipient:
            log.warning("[toll-email] %s no email found on ViewRA — leaving for next run", ref)
            continue
        try:
            res = _tb_send_toll_invoice(ref, email=recipient, test=test)
            log.info("[toll-email] %s%s -> %s", ref,
                     (" (scraped %s)" % scraped) if scraped else "", json.dumps(res, ensure_ascii=False)[:200])
            if isinstance(res, dict) and res.get("sent"):
                sent += 1
        except Exception as e:  # noqa: BLE001
            log.warning("[toll-email] %s send failed: %s", ref, str(e)[:160])
    log.info("[toll-email] DONE pending=%d sent=%d prepaid_skipped=%d", len(pending), sent, prepaid_skipped)


# --- Payment reconciliation phase (DARK by default) ----------------------------------------------
# For each OPEN toll invoice (toll posted to TSD via writeback, not yet paid), read the RA balance off
# ViewRA and ask TollBridge to close it when balance is $0. Prepaid (toll-package) invoices are closed
# server-side as PREPAID_PACKAGE. Enabled only with TB_PAYMENT_RECONCILE=1. DRY-RUN
# (TB_PAYMENT_RECONCILE_DRYRUN=1) reads + LOGS the balance but never closes — use it to confirm we're
# reading the right TSD field before trusting it. NO money moves / NO TSD write.
def _parse_money(s):
    if s is None:
        return None
    t = str(s).replace('$', '').replace(',', '').strip()
    try:
        return float(t)
    except Exception:  # noqa: BLE001
        return None


def run_payment_reconcile_phase(page):
    if not os.environ.get("TB_PAYMENT_RECONCILE"):
        return
    dry = bool(os.environ.get("TB_PAYMENT_RECONCILE_DRYRUN"))
    lc, skip = _effective_loc_codes()
    if skip:
        log.info("[pay-reconcile] no in-scope locations for this login (login=%s, go-live=%s) — skipping",
                 os.environ.get("TB_LOCATION_CODES") or "-", os.environ.get("TB_TOLL_LOCATIONS") or "-")
        return
    log.info("[pay-reconcile] MODE=%s%s", "DRY-RUN (no closes)" if dry else "LIVE", (" scope=%s" % lc) if lc else "")
    # 1) Close prepaid/toll-package invoices server-side (pure backend, no scraping).
    try:
        _body = {"tenantId": TENANT_ID}
        if lc:
            _body["locationCodes"] = lc
        _, r = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/agreements/close-covered-invoices",
                          body=_body, method="POST")
        log.info("[pay-reconcile] covered (prepaid) closed: %s", json.dumps(r, ensure_ascii=False)[:160])
    except Exception as e:  # noqa: BLE001
        log.warning("[pay-reconcile] close-covered failed: %s", str(e)[:140])
    # 2) Open invoices that have a real TSD charge → check the RA balance.
    try:
        _params = {"tenantId": TENANT_ID}
        if lc:
            _params["locationCodes"] = lc
        q = urllib.parse.urlencode(_params)
        _, openinv = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/agreements/open-toll-invoices?{q}", timeout=60)
        openinv = openinv if isinstance(openinv, list) else []
    except Exception as e:  # noqa: BLE001
        log.warning("[pay-reconcile] open-invoices fetch failed: %s", str(e)[:140])
        return
    if not openinv:
        log.info("[pay-reconcile] nothing open to reconcile")
        return
    limit = int(os.environ.get("TB_PAYMENT_RECONCILE_LIMIT", "0") or "0")
    if limit:
        openinv = openinv[:limit]
    log.info("[pay-reconcile] %d open invoice(s) to check", len(openinv))
    closed = 0
    for item in openinv:
        ref = (item or {}).get("externalRef")
        if not ref:
            continue
        try:
            rec = scrape_ra(page, ref)
        except Exception as e:  # noqa: BLE001
            log.warning("[pay-reconcile] %s ViewRA scrape failed: %s", ref, str(e)[:120])
            continue
        bal = _parse_money((rec or {}).get("balanceRaw"))
        via = (rec or {}).get("balanceVia")
        if bal is None:
            log.warning("[pay-reconcile] %s no balance read off ViewRA (via=%s raw=%r) — skipping", ref, via, (rec or {}).get("balanceRaw"))
            continue
        is_zero = abs(bal) <= 0.005  # same epsilon as the backend close
        if dry:
            log.info("[pay-reconcile] DRY %s balance=$%.2f (via %s) — would %s", ref, bal, via, "CLOSE" if is_zero else "leave open")
            continue
        # Safety: never CLOSE on a $0 that came from the regex text-scan (unverified field). Pin a real
        # field id first (verify via the DRY-RUN's balanceVia). A non-zero text-scan is harmless (won't close).
        if is_zero and via == "text-scan":
            log.warning("[pay-reconcile] %s balance $0 via TEXT-SCAN (unverified) — NOT closing; confirm the field id first", ref)
            continue
        try:
            res = _tb_reconcile_payment(ref, bal)
            log.info("[pay-reconcile] %s balance=$%.2f (via %s) -> %s", ref, bal, via, json.dumps(res, ensure_ascii=False)[:160])
            if isinstance(res, dict):
                if res.get("closed"):
                    closed += 1
                if res.get("warn") == "balance-after-paid":
                    log.warning("[pay-reconcile] %s shows balance $%.2f AFTER being marked paid (late toll?) — review", ref, bal)
        except Exception as e:  # noqa: BLE001
            log.warning("[pay-reconcile] %s reconcile failed: %s", ref, str(e)[:140])
    log.info("[pay-reconcile] DONE checked=%d closed=%d (dry=%s)", len(openinv), closed, dry)


def _tb_reconcile_payment(external_ref, balance):
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/agreements/reconcile-toll-payment",
                         body={"tenantId": TENANT_ID, "externalRef": external_ref, "balance": balance}, method="POST")
    return data


# --- Write-back phase (DARK by default) -----------------------------------------------------------
# Posts the SPF toll fee INTO TSD (RACharge.aspx) for OPEN, non-prepaid agreements so the renter pays
# it in TSD. Enabled only with TB_WRITEBACK=1. DRY by default (lists what it WOULD post + detects
# prepaid live, posts NOTHING). LIVE posting requires TB_WRITEBACK_LIVE=1 and is NOT yet wired in this
# build (the RACharge poster is added in a later step after Hector reviews the DRY amounts).
def _writeback_since():
    """No-backlog policy: only write back tolls ingested on/after this date. Defaults to TODAY (UTC)
    so enabling write-back never blasts the historical backlog; override with TB_WRITEBACK_SINCE=YYYY-MM-DD."""
    s = (os.environ.get("TB_WRITEBACK_SINCE") or "").strip()
    return s or datetime.date.today().isoformat()


def _tb_writeback_pending(codes=""):
    params = {"tenantId": TENANT_ID, "since": _writeback_since()}
    if codes:
        params["locationCodes"] = codes
    q = urllib.parse.urlencode(params)
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/writeback/pending?{q}", timeout=60)
    return data if isinstance(data, dict) else {}


# --- RACharge SPF poster (ported from the proven tsd_spf_writeback write-test) -------------------
def _frame_with(page, sel):
    for fr in [page.main_frame] + [f for f in page.frames if f is not page.main_frame]:
        try:
            if fr.query_selector(sel):
                return fr
        except Exception:
            pass
    return None


def _settle(fr, secs=1.5):
    try:
        fr.wait_for_load_state("networkidle", timeout=12000)
    except Exception:
        pass
    time.sleep(secs)


def _dismiss_modals(page):
    for sel in ("input[value='OK']", "button:has-text('OK')", "a:has-text('OK')", "input[value='Close']", ".rwCloseButton"):
        try:
            loc = page.locator(sel)
            for i in range(loc.count()):
                b = loc.nth(i)
                if b.is_visible():
                    b.click(timeout=2000); time.sleep(0.4)
        except Exception:
            pass


def _select_by_text(fr, name, label_rx):
    loc = fr.locator(f"select[name='{name}'], #{name}").first
    try:
        opts = loc.locator("option").all()
    except Exception:
        return None
    for opt in opts:
        if re.search(label_rx, (opt.inner_text() or "").strip(), re.I):
            loc.select_option(value=opt.get_attribute("value"), timeout=15000)
            return True
    return None


def _open_racharge(page, knum):
    """Establish the RA in session (txtRANum nav via scrape_ra) then open RACharge.aspx. Returns the
    RACharge frame (#ddlTransType) or None. ViewRA?KNum= is dead, so the RA MUST be set first."""
    for _ in range(2):
        rec = scrape_ra(page, knum)
        if not (rec and (rec.get("last") or rec.get("pickup"))):
            continue
        drive_frame(page, f"{BASE}/RACharge.aspx?from=ViewRA")
        for _ in range(40):
            time.sleep(0.5)
            fr = _frame_with(page, '#ddlTransType')
            if fr:
                return fr
    return None


def _post_spf_line(page, fr, amount, note, confirm, idx, code_rx=r'SUNPASS\s*FEE|\(SPF\)'):
    """Fill + verify one toll-fee charge line on an open RACharge frame; save it if confirm. The TSD
    charge code is per-location (Orlando 'SUNPASS FEE (SPF)', Miami 'TOLL COST (22)', …) so the option
    to pick is matched by `code_rx`. Returns True if saved (confirm) or verified-OK (NOSAVE), else False."""
    _dismiss_modals(page)
    try:
        fr.evaluate("""() => { const e=document.getElementById('ddlTransType'); if(e){ e.disabled=false; for(const o of e.options){ if(o.value==='+'||/\\+/.test(o.text)){ e.value=o.value; break; } } } try{__doPostBack('ddlTransType','');}catch(err){} }""")
    except Exception as e:  # noqa: BLE001
        log.warning("[writeback]  cascade postback: %s", str(e)[:80])
    _settle(fr)
    codes_ready = False
    for _ in range(40):
        fr = _frame_with(page, '#ddlCodes') or fr
        try:
            if fr and fr.locator('#ddlCodes').count() and fr.locator('#ddlCodes').first.is_enabled() and fr.locator('#ddlCodes option').count() > 1:
                codes_ready = True; break
        except Exception:
            pass
        time.sleep(0.5)
    if not codes_ready:
        log.error("[writeback]  charge %d: ddlCodes never enabled — skip", idx); return False
    if not _select_by_text(fr, 'ddlCodes', code_rx):
        log.error("[writeback]  charge %d: charge code (rx=%s) not found in ddlCodes — skip", idx, code_rx); return False
    _settle(fr)
    try:
        ml = fr.locator('#txtNote').first.get_attribute('maxlength'); maxlen = int(ml) if (ml and ml.isdigit()) else None
    except Exception:
        maxlen = None
    note_eff = note[:maxlen].strip() if maxlen else note

    def _live(sel):
        try:
            return (fr.locator(sel).first.input_value() or '').strip()
        except Exception:
            return ''
    for _ in range(4):
        try:
            fr.fill('#txtAmount', amount)
        except Exception:
            pass
        for s in ("#txtNote", "textarea[name='txtNote']", "#txtDescription"):
            try:
                loc = fr.locator(s).first
                if loc.count() and loc.is_visible():
                    loc.fill(note_eff); break
            except Exception:
                pass
        time.sleep(0.8)
        if _live('#txtAmount') not in ('', '0.00', '0') and _live('#txtNote').upper() == note_eff.upper():
            break
        _settle(fr, 1.0)
    amt_live, note_live = _live('#txtAmount'), _live('#txtNote')
    try:
        code_live = fr.locator('#ddlCodes').first.evaluate("el => el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''")
    except Exception:
        code_live = ''
    ok = (amt_live not in ('', '0.00', '0') and note_live.upper() == note_eff.upper() and bool(re.search(code_rx, code_live or '', re.I)))
    log.info("[writeback]  charge %d LIVE→ amount=%r note=%r code=%r ok=%s", idx, amt_live, note_live, code_live, ok)
    if not ok:
        log.error("[writeback]  charge %d VERIFY FAILED — not saving", idx); return False
    if not confirm:
        log.info("[writeback]  charge %d VERIFY OK (NOSAVE — no charge made)", idx); return True
    _dismiss_modals(page)
    # JS-dispatch the save click: a normal Playwright click on #butSave times out when a TSD overlay/
    # modal intercepts it (observed: 'Locator.click: Timeout 8000ms'). Firing the element's own click
    # via JS runs its onclick/postback directly, bypassing the actionability wait. Same as the proven
    # btnRun js-click in the open-sync.
    saved = False
    try:
        saved = fr.evaluate("() => { const b = document.getElementById('butSave') || document.querySelector(\"input[name='butSave']\"); if (b) { b.click(); return true; } return false; }")
    except Exception as e:  # noqa: BLE001
        log.warning("[writeback]  charge %d butSave js-click warn: %s", idx, str(e)[:90])
    if not saved:
        log.error("[writeback]  charge %d: #butSave not found — NOT saved", idx); return False
    time.sleep(3)
    try:
        page.wait_for_load_state('networkidle', timeout=30000)
    except Exception:
        pass
    _dismiss_modals(page)
    log.info("[writeback]  charge %d SAVED (butSave js-click)", idx); return True


def _wb_quarantine_path():
    return (os.environ.get("TB_WB_QUARANTINE_FILE") or "/root/ridefleet-scraper/tb_writeback_quarantine.json").strip()


def _wb_quarantine_load():
    # C1 (2026-07-04): refs quarantined after an HTTP 400 from /api/internal/writeback/record. The TSD
    # charges were already SAVED before record, so retrying the ref on the next cron would double-bill
    # the renter in TSD. Quarantined refs are skipped until a human reviews the file. Robust: missing/
    # corrupt file → empty dict, never break the phase.
    try:
        with open(_wb_quarantine_path()) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _wb_quarantine_add(agreement_ref, reason):
    path = _wb_quarantine_path()
    q = _wb_quarantine_load()
    q[agreement_ref] = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "reason": str(reason)[:200]}
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(path, "w") as f:
            json.dump(q, f, indent=2)
        log.warning("[writeback] %s QUARANTINED → %s (needs human review before it can be recorded)", agreement_ref, path)
    except Exception as e:  # noqa: BLE001
        log.error("[writeback] quarantine file write FAILED (%s): %s", path, str(e)[:120])


def _tb_writeback_record(agreement_ref, posted_lines):
    # TB-2 (2026-07-04): backend answers HTTP 409 {"error":"admin-already-recorded"} when the ADMIN fee
    # line for this agreementRef already exists — the correct idempotent outcome (fee already recorded),
    # treat as success. TB-4 400 (invalid-amount / toll-not-in-agreement / unknown-agreement /
    # multiple-admin-lines) means the backend stored NOTHING but the TSD charges are already saved →
    # quarantine the ref so the next cron does NOT re-post them (double-bill). Any other 4xx/5xx raises.
    try:
        _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/writeback/record",
                             body={"tenantId": TENANT_ID, "agreementRef": agreement_ref, "postedLines": posted_lines}, method="POST")
        return data
    except urllib.error.HTTPError as e:
        if e.code == 409:
            try:
                body = json.loads(e.read().decode())
            except Exception:  # noqa: BLE001
                body = {}
            if body.get("error") == "admin-already-recorded":
                log.info("[writeback] %s: admin fee already recorded (409) — idempotent OK, skipping", agreement_ref)
                return body
        elif e.code == 400:
            try:
                raw = e.read().decode()
            except Exception:  # noqa: BLE001
                raw = ""
            log.error("[writeback] %s: record REJECTED (400) — charges are in TSD but NOT recorded. body=%s", agreement_ref, raw[:200])
            _wb_quarantine_add(agreement_ref, raw[:200] or "http-400")
        raise


# --- Run-now queue (manual, per-agreement) -------------------------------------------------------
def _tb_runnow_refs(codes=""):
    """KNums currently requesting a run-now post (flag set, not paused). Optional location scope.
    Cheap poll (no login) so a frequent cron only spins up the browser when there's work."""
    params = {"tenantId": TENANT_ID}
    if codes:
        params["locationCodes"] = codes
    q = urllib.parse.urlencode(params)
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/writeback/runnow-refs?{q}", timeout=30)
    return data if isinstance(data, dict) else {}


def _tb_runnow_lines(ref):
    """Confidence-gated, email/prepaid/paused-safe lines for ONE run-now ref: {skipped, tollLines, adminLine}."""
    q = urllib.parse.urlencode({"tenantId": TENANT_ID, "externalRef": ref})
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/writeback/run-now-lines?{q}", timeout=60)
    return data if isinstance(data, dict) else {}


def _tb_runnow_clear(refs):
    _, data = _http_json(f"{TOLLBRIDGE_BASE}/api/internal/writeback/runnow-clear",
                         body={"tenantId": TENANT_ID, "refs": refs}, method="POST")
    return data


def run_writeback_phase(page):
    if not os.environ.get("TB_WRITEBACK"):
        return
    # DRY unless an explicit LIVE flag is set. (LIVE poster not implemented in this build → safe.)
    dry = bool(os.environ.get("TB_WRITEBACK_DRYRUN")) or not os.environ.get("TB_WRITEBACK_LIVE")
    # Safe middle rung: LIVE + NOSAVE opens RACharge and fills+verifies the SPF line but does NOT click
    # butSave — proves the posting mechanics end-to-end without making a real charge. Remove for real.
    nosave = bool(os.environ.get("TB_WRITEBACK_NOSAVE"))
    confirm = (not dry) and (not nosave)  # actually SAVE (real charge) only when LIVE and not NOSAVE
    # TSD charge code is per-location (data-driven via scrape-config → CHARGE_CODE_RX): Miami
    # 'TOLL COST (22)', Orlando 'SUNPASS FEE (SPF)'. Picked per RA by `_charge_code_rx_for(ref)`.
    codes, skip = _effective_loc_codes()
    if skip:
        log.info("[writeback] no in-scope locations for this login (login=%s, go-live=%s) — skipping",
                 os.environ.get("TB_LOCATION_CODES") or "-", os.environ.get("TB_TOLL_LOCATIONS") or "-")
        return
    mode = "DRY-RUN (posts nothing)" if dry else ("LIVE+NOSAVE (fills+verifies, no charge)" if nosave else "LIVE (REAL charges)")
    log.info("[writeback] MODE=%s%s since=%s charge_codes=%s (no backlog)", mode, (" scope=%s" % codes) if codes else "", _writeback_since(), CHARGE_CODE_RX.get("byLocationCode") or CHARGE_CODE_RX.get("default"))
    try:
        data = _tb_writeback_pending(codes)
    except Exception as e:  # noqa: BLE001
        log.warning("[writeback] pending fetch failed: %s", str(e)[:160]); return
    if not data.get("enabled"):
        log.info("[writeback] autoWritebackEnabled is OFF in the ruleset — nothing to do"); return
    ags = data.get("agreements") or []
    if not ags:
        log.info("[writeback] nothing pending"); return
    limit = int(os.environ.get("TB_WRITEBACK_LIMIT", "5" if dry else "0") or "0")
    if limit:
        ags = ags[:limit]
    log.info("[writeback] %d agreement(s) pending (threshold=%s)", len(ags), data.get("threshold"))
    would_post = 0; prepaid_skipped = 0
    for a in ags:
        ref = a.get("agreementRef")
        if not ref:
            continue
        status, n = _writeback_one(page, ref, a.get("tollLines"), a.get("adminLine"), dry=dry, nosave=nosave, confirm=confirm)
        if status == "prepaid":
            prepaid_skipped += 1
        elif status in ("dry", "posted"):
            would_post += n
    log.info("[writeback] DONE agreements=%d posted/would=%d prepaid_skipped=%d (mode=%s)", len(ags), would_post, prepaid_skipped, mode)


def _writeback_one(page, ref, lines, admin, *, dry, nosave, confirm):
    """Post ONE agreement's write-back lines — the SINGLE posting implementation shared by the auto
    write-back pass AND the manual run-now pass (so the money guards can never diverge). Returns
    (status, n):
      'prepaid' → toll package live on ViewRA (flagged, never billed)
      'dry'     → DRY-RUN, would post (n=1)
      'posted'  → real charge(s) saved + recorded (n=1)
      'nosave'  → LIVE+NOSAVE, verified but nothing saved
      'nolines' → nothing eligible to post
      'quarantined' → a prior /record 400 left charges in TSD unrecorded; skip until a human clears it
      'failed'  → had lines but RACharge/posting failed (caller may retry)
    """
    lines = lines or []
    # C1: never re-post a ref whose /record previously 400'd (charges already in TSD, backend recorded
    # nothing) — re-posting would double-bill. Shared by the auto AND run-now paths.
    if ref in _wb_quarantine_load():
        log.warning("[writeback] %s QUARANTINED — skipping (needs human review of the quarantine file)", ref)
        return ("quarantined", 0)
    # Verify prepaid LIVE off ViewRA — never post a fee to a toll-package renter.
    rec = None
    try:
        rec = scrape_ra(page, ref)
    except Exception as e:  # noqa: BLE001
        log.warning("[writeback] %s ViewRA scrape failed: %s", ref, str(e)[:120])
    if rec and rec.get("prepaid"):
        if not dry:
            try: _tb_set_prepaid(ref, True)
            except Exception: pass  # noqa: BLE001
        log.info("[writeback] %s has a toll package (prepaid) — NOT posting", ref)
        return ("prepaid", 0)
    total = sum(float(l.get("amount") or 0) for l in lines) + (float((admin or {}).get("amount") or 0) if admin else 0)
    if dry:
        log.info("[writeback] DRY %s would post %d SPF line(s)%s total=$%.2f", ref, len(lines), " + admin fee" if admin else "", total)
        return ("dry", 1)
    # LIVE / LIVE+NOSAVE: build the SPF lines, open RACharge per line, fill+verify (+ save if confirm).
    to_post = [{"externalId": l.get("externalId"), "amount": float(l.get("amount") or 0),
                "note": (l.get("note") or l.get("description") or ("SPF " + ref)), "lineKind": "TOLL"} for l in lines]
    if admin and float(admin.get("amount") or 0) > 0:
        to_post.append({"amount": float(admin.get("amount") or 0), "note": (admin.get("note") or ("SPF Admin Fee " + ref)), "lineKind": "ADMIN"})
    if not to_post:
        return ("nolines", 0)
    posted = []
    for i, ln in enumerate(to_post, 1):
        try:
            fr = _open_racharge(page, ref)
            if not fr:
                log.warning("[writeback] %s RACharge didn't open (line %d) — skipping this RA", ref, i); break
            if _post_spf_line(page, fr, f"{ln['amount']:.2f}", ln["note"], confirm=confirm, idx=i, code_rx=_charge_code_rx_for(ref)) and confirm:
                posted.append(ln)
        except Exception as e:  # noqa: BLE001
            log.warning("[writeback] %s line %d errored: %s — continuing", ref, i, str(e)[:120])
    if posted:
        try:
            r = _tb_writeback_record(ref, posted)
            log.info("[writeback] %s posted+recorded %d line(s): %s", ref, len(posted), json.dumps(r, ensure_ascii=False)[:140])
        except Exception as e:  # noqa: BLE001
            log.warning("[writeback] %s record failed: %s", ref, str(e)[:140])
        return ("posted", 1)
    if nosave:
        log.info("[writeback] %s NOSAVE — verified %d line(s), nothing saved", ref, len(to_post))
        return ("nosave", 0)
    return ("failed", 0)


def run_runnow_phase(page):
    """Process any per-agreement 'Run now' requests (from the UI) NOW — same posting + money guards as
    the auto pass, triggered on demand instead of waiting for the 30-min cron. Gated by TB_WRITEBACK
    (DRY unless TB_WRITEBACK_LIVE). Cheap when the queue is empty (a single GET, no RA visits)."""
    if not os.environ.get("TB_WRITEBACK"):
        return
    codes, skip = _effective_loc_codes()
    if skip:
        return
    try:
        refs = (_tb_runnow_refs(codes) or {}).get("refs") or []
    except Exception as e:  # noqa: BLE001
        log.warning("[runnow] refs fetch failed: %s", str(e)[:160]); return
    if not refs:
        return
    dry = bool(os.environ.get("TB_WRITEBACK_DRYRUN")) or not os.environ.get("TB_WRITEBACK_LIVE")
    nosave = bool(os.environ.get("TB_WRITEBACK_NOSAVE"))
    confirm = (not dry) and (not nosave)
    log.info("[runnow] %d run-now request(s): %s (mode=%s)", len(refs), refs, "DRY" if dry else ("NOSAVE" if nosave else "LIVE"))
    done = []
    for ref in refs:
        try:
            lf = _tb_runnow_lines(ref)
        except Exception as e:  # noqa: BLE001
            log.warning("[runnow] %s lines fetch failed: %s — leaving flag to retry", ref, str(e)[:120]); continue
        sk = (lf or {}).get("skipped")
        if sk:
            log.info("[runnow] %s skipped (%s) — clearing", ref, sk)
            done.append(ref); continue
        status, _n = _writeback_one(page, ref, (lf or {}).get("tollLines"), (lf or {}).get("adminLine"), dry=dry, nosave=nosave, confirm=confirm)
        # Clear the flag on any terminal outcome; keep it (retry next pass) only on a transient 'failed'.
        # DRY never clears — lets the operator test run-now without consuming the request.
        if dry:
            continue
        if status != "failed":
            done.append(ref)
        else:
            log.info("[runnow] %s failed to post — leaving flag to retry", ref)
    if done:
        try:
            r = _tb_runnow_clear(done)
            log.info("[runnow] cleared %d flag(s): %s", len(done), json.dumps(r, ensure_ascii=False)[:120])
        except Exception as e:  # noqa: BLE001
            log.warning("[runnow] clear failed: %s", str(e)[:140])
    log.info("[runnow] DONE requests=%d cleared=%d", len(refs), len(done))


def _load_creds_from_tollbridge():
    """Fetch TSD creds from TollBridge (scrape-config) and set os.environ so login() uses them.
    Falls back silently to the existing .env values on any error (resilient during transition)."""
    if os.environ.get("TB_SKIP_CRED_AUTOLOAD"):
        return
    if not (TOLLBRIDGE_BASE and TENANT_ID and TOKEN):
        return
    try:
        req = urllib.request.Request(f"{TOLLBRIDGE_BASE}/api/internal/scrape-config",
                                     headers={"Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        tenant = next((t for t in data.get("tenants", []) if t.get("tenantId") == TENANT_ID), None)
        conns = (tenant or {}).get("tsdConnections") or []
        conn = next((c for c in conns if c.get("password") and c.get("username")), None)
        if not conn:
            log.info("scrape-config: no TSD creds in TollBridge — using .env")
            return
        if conn.get("tsdNum"): os.environ["TSD_NUM"] = conn["tsdNum"]
        if conn.get("tsdCo"): os.environ["TSD_CO"] = conn["tsdCo"]
        os.environ["TSD_USER"] = conn["username"]; os.environ["TB_TSD_USER"] = conn["username"]
        os.environ["TSD_PASS"] = conn["password"]; os.environ["TB_TSD_PASS"] = conn["password"]
        log.info("scrape-config: loaded TSD creds from TollBridge (conn=%s, locations=%s)",
                 conn.get("name") or conn.get("id"), conn.get("locationCodes"))
    except Exception as e:  # noqa: BLE001
        log.warning("scrape-config fetch failed, using .env: %s", str(e)[:120])


def _load_config_from_tollbridge():
    """Load the tenant's DATA-DRIVEN write-back config from scrape-config: non-billable indicators
    (SunPass prepaid / discount) + per-location charge codes. ALWAYS runs (unlike _load_creds, which
    the multi-login runner short-circuits with TB_SKIP_CRED_AUTOLOAD) so these are populated on every
    run regardless of how creds are provided. Best-effort — leaves the built-in defaults on any error."""
    if not (TOLLBRIDGE_BASE and TENANT_ID and TOKEN):
        return
    try:
        req = urllib.request.Request(f"{TOLLBRIDGE_BASE}/api/internal/scrape-config",
                                     headers={"Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        tenant = next((t for t in data.get("tenants", []) if t.get("tenantId") == TENANT_ID), None)
        nb = (tenant or {}).get("nonBillable") or {}
        if isinstance(nb, dict) and (nb.get("default") or nb.get("byLocationCode")):
            NON_BILLABLE["default"] = nb.get("default") or NON_BILLABLE["default"]
            NON_BILLABLE["byLocationCode"] = nb.get("byLocationCode") or {}
            log.info("scrape-config: non-billable indicators loaded (default=%s, locations=%s)",
                     NON_BILLABLE["default"], list((NON_BILLABLE["byLocationCode"] or {}).keys()))
        cc = (tenant or {}).get("writebackChargeCodeRx") or {}
        if isinstance(cc, dict) and (cc.get("default") or cc.get("byLocationCode")):
            CHARGE_CODE_RX["default"] = cc.get("default") or CHARGE_CODE_RX["default"]
            CHARGE_CODE_RX["byLocationCode"] = cc.get("byLocationCode") or {}
            log.info("scrape-config: write-back charge codes loaded (%s)", CHARGE_CODE_RX["byLocationCode"])
    except Exception as e:  # noqa: BLE001
        log.warning("scrape-config config load failed, using defaults: %s", str(e)[:120])


def main():
    _load_creds_from_tollbridge()
    _load_config_from_tollbridge()
    for k in ("TSD_USER", "TSD_PASS"):
        if not os.environ.get(k):
            log.error("missing env %s", k); sys.exit(2)
    if not (TOLLBRIDGE_BASE and TENANT_ID and TOKEN):
        log.error("missing TOLLBRIDGE_BASE / TOLLBRIDGE_TENANT_ID / TOLLBRIDGE_TOKEN"); sys.exit(2)

    # RUN-NOW-ONLY: lightweight pass for a frequent cron. Cheap-poll the queue with NO login; only spin
    # up the browser + log in when a UI "Run now" is actually queued for this login's locations. Gives
    # near-instant single-RA posting without running the full open-agreements sync every few minutes.
    if os.environ.get("TB_RUNNOW_ONLY"):
        if not os.environ.get("TB_WRITEBACK"):
            log.info("[runnow] TB_WRITEBACK off — nothing to do"); return
        try:
            _codes, _skip = _effective_loc_codes()
            refs = [] if _skip else ((_tb_runnow_refs(_codes) or {}).get("refs") or [])
        except Exception as e:  # noqa: BLE001
            log.warning("[runnow] pre-check failed: %s", str(e)[:160]); return
        if not refs:
            log.info("[runnow] queue empty — no login"); return
        log.info("[runnow] %d queued — logging in to process", len(refs))
        with Camoufox(headless=True) as browser:
            page = browser.new_page()
            page.on("dialog", make_dialog_handler())
            page.route("**/*", lambda r: r.abort() if r.request.resource_type in ("image", "stylesheet", "font", "media") else r.continue_())
            page.set_viewport_size({"width": 1366, "height": 900})
            try:
                login(page)
                run_runnow_phase(page)
            finally:
                logout(page)
        return

    with Camoufox(headless=True) as browser:
        page = browser.new_page()
        # ONE dialog handler for the whole lifetime (log + guarded accept). Registering this once
        # here — instead of per call — is what kills the "Dialog already handled" errors.
        page.on("dialog", make_dialog_handler())
        page.route("**/*", lambda r: r.abort() if r.request.resource_type in ("image", "stylesheet", "font", "media") else r.continue_())
        page.set_viewport_size({"width": 1366, "height": 900})

        try:
            login(page)

            # ONE report → all open agreements with KNum + plate + window. No per-RA visits.
            # The Run->PDF trigger is flaky (~50%), so retry the whole cycle until the PDF yields KNums.
            text = ""
            for attempt in range(1, 6):
                try:
                    text = list_open_knums(page, debug=DEBUG)
                except Exception as e:  # noqa: BLE001
                    log.warning("CurrOpenRa attempt %d errored: %s", attempt, str(e)[:120])
                    text = ""
                if KNUM_RE.search(text or ""):
                    log.info("CurrOpenRa OK on attempt %d", attempt)
                    break
                log.info("CurrOpenRa attempt %d produced no PDF — retrying", attempt)
                try:
                    if is_login_page(page):
                        login(page)
                    drive_frame(page, BASE + "/Default.aspx"); time.sleep(2)
                except Exception:
                    pass
            rows = parse_open_agreements(text)
            if LIMIT:
                rows = rows[:LIMIT]
            log.info("parsed %d OPEN agreements from CurrOpenRa", len(rows))
            # Guard: if the report has KNums but we parsed few/none, the TSD format differs for this
            # location/tenant. Shout ERROR (the droplet log-monitor catches it) + always dump the text
            # — so a new place never silently imports 0 like Miami did.
            try:
                _distinct = len(set(KNUM_RE.findall(text or "")))
            except Exception:
                _distinct = 0
            if _distinct >= 5 and len(rows) < max(1, _distinct // 2):
                log.error("PARSER MISMATCH: report has %d distinct KNums but parsed %d rows - TSD format may differ for this location/tenant; text dumped to /tmp/tb_curropenra_pdftext.txt", _distinct, len(rows))
                try:
                    open("/tmp/tb_curropenra_pdftext.txt", "w", encoding="utf-8").write(text or "")
                except Exception:
                    pass
            if DEBUG and rows:
                log.info("[debug] sample row: %s", json.dumps(rows[0], ensure_ascii=False))
            if not rows:
                log.error("no agreements parsed (KNums in text=%d) - format may have changed; text dumped to /tmp/tb_curropenra_pdftext.txt", _distinct)
                try:
                    open("/tmp/tb_curropenra_pdftext.txt", "w", encoding="utf-8").write(text or "")
                except Exception:
                    pass
                return

            posted = 0
            for i in range(0, len(rows), BATCH):
                chunk = rows[i:i + BATCH]
                post_batch(chunk)
                posted += len(chunk)
            log.info("DONE open=%d posted=%d", len(rows), posted)
            if not LIMIT:
                try:
                    _tb_reconcile([r.get("externalRef") for r in rows])
                except Exception as e:  # noqa: BLE001
                    log.warning("reconcile failed: %s", str(e)[:160])

            # Automatic toll-invoice email (DARK unless TB_TOLL_EMAILS=1). Same session, then logout.
            try:
                run_toll_email_phase(page)
            except Exception as e:  # noqa: BLE001
                log.warning("toll-email phase failed: %s", str(e)[:160])

            # Payment reconciliation (DARK unless TB_PAYMENT_RECONCILE=1). Same session, then logout.
            try:
                run_payment_reconcile_phase(page)
            except Exception as e:  # noqa: BLE001
                log.warning("payment-reconcile phase failed: %s", str(e)[:160])

            # Write-back of SPF toll fees into TSD (DARK unless TB_WRITEBACK=1; DRY unless TB_WRITEBACK_LIVE=1).
            try:
                run_writeback_phase(page)
            except Exception as e:  # noqa: BLE001
                log.warning("writeback phase failed: %s", str(e)[:160])

            # Manual "Run now" requests from the UI — process any queued per-RA posts in this same session.
            try:
                run_runnow_phase(page)
            except Exception as e:  # noqa: BLE001
                log.warning("runnow phase failed: %s", str(e)[:160])
        finally:
            # Always release the TSD single-window so the next cron run / the staff log in clean.
            logout(page)


if __name__ == "__main__":
    main()
