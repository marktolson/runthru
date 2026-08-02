// Capture orchestration.
//
// Launches a real, visible Chromium that you drive yourself. The recorder script intercepts
// your interactions and calls back here; this module then freezes the page into a
// self-contained snapshot and appends it to the demo as a step.
//
// The browser profile is persistent, so you log into the target app once and stay logged in
// across recording sessions.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { demoDir, readDemo, writeDemo, withDemoLock, PROFILES_DIR } from './store.js';
import { polishDemo } from './polish.js';
import { hasKey } from './llm.js';
import { newNode } from './docops.js';
import { AssetStore } from './assets.js';
import { serializeSnapshot } from './inject/serialize.js';
import { recorderScript } from './inject/recorder.js';

// Snapshots contain no JavaScript at all — page scripts are stripped at capture and we add
// none back. Scroll offsets are recorded as data attributes and re-applied by the player,
// which reaches into the iframe from the parent. That keeps the iframe sandbox tight
// (no allow-scripts) while still restoring state the flat markup cannot express.

const SNAPSHOT_CSS = `
  html { scroll-behavior: auto !important; }
  /* Freeze animations so a snapshot looks identical every time it is opened — but on their
     FINISHED state, not their first frame. A snapshot is a fresh document, so every CSS
     animation restarts on load; pausing them froze entry animations (slide-in panels,
     fade-ins) at the moment before they play, leaving whole panels parked off-screen or at
     zero opacity while the thumbnail showed them correctly. Collapsing the duration and
     holding the end state lands each element where the live page had it. */
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    animation-fill-mode: forwards !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  /* Overlay primitives the player toggles at runtime. */
  [data-demo-blur] { filter: blur(6px) !important; user-select: none !important; }
  [data-demo-hidden] { visibility: hidden !important; }
  [data-demo-highlight] { outline: 2px solid var(--demo-accent, #5b5bd6) !important; outline-offset: 2px; border-radius: 4px; }
`;

/** @type {null | Session} */
let active = null;

// How long to let a page finish rendering before freezing it. Generous by design: a snapshot
// of half-drawn widgets is worthless, and a recording session is interactive, not a race.
// DEMO_SETTLE_MS scales the whole budget for unusually slow apps.
const SETTLE_SCALE = Math.max(0.2, Number(process.env.DEMO_SETTLE_MS || 0) / 2500 || 1);
const SETTLE = {
  network: Math.round(9000 * SETTLE_SCALE), // waiting for in-flight requests
  quiet: Math.round(700 * SETTLE_SCALE), // DOM must stop changing for this long
  max: Math.round(7000 * SETTLE_SCALE), // ...but never wait longer than this for quiet
  paint: Math.round(350 * SETTLE_SCALE), // a beat for the final paint
};

// Runs in the page. Resolves once the DOM has stopped changing, images have loaded and no
// loading placeholder is on screen — or when the budget runs out, because plenty of real apps
// animate something forever and would never go quiet.
function domSettled({ quietMs, maxMs }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastChange = Date.now();
    const obs = new MutationObserver(() => {
      lastChange = Date.now();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

    // The visual vocabulary of "still loading", across the common frameworks.
    const BUSY =
      '[aria-busy="true"], [role="progressbar"], [class*="skeleton" i], [class*="animate-pulse" i],' +
      '[class*="shimmer" i], [class*="placeholder-glow" i], [data-loading="true"], [class*="spinner" i]';

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && r.top < innerHeight && r.bottom > 0;
    };

    const done = (reason) => {
      obs.disconnect();
      resolve({ reason, waited: Date.now() - start });
    };

    const tick = () => {
      const now = Date.now();
      if (now - start > maxMs) {
        const stillBusy = [...document.querySelectorAll(BUSY)].some(visible);
        return done(stillBusy ? 'still-loading' : 'busy-page');
      }
      const busy = [...document.querySelectorAll(BUSY)].some(visible);
      const imagesPending = [...document.images].some((i) => !i.complete && i.loading !== 'lazy');
      if (!busy && !imagesPending && now - lastChange >= quietMs) return done('quiet');
      setTimeout(tick, 120);
    };
    tick();
  });
}

// Wait for a page to be worth photographing.
export async function waitForSettled(page, opts = {}) {
  const cfg = { ...SETTLE, ...opts };
  const started = Date.now();
  await page.waitForLoadState('networkidle', { timeout: cfg.network }).catch(() => {});
  let out = { reason: 'unreadable', waited: 0 };
  try {
    out = await page.evaluate(domSettled, { quietMs: cfg.quiet, maxMs: cfg.max });
    // Web fonts land late and reflow everything under them.
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
  } catch {
    // Navigated mid-check: the next capture covers it.
  }
  await page.waitForTimeout(cfg.paint).catch(() => {});
  return { ...out, waited: Date.now() - started };
}

class Session {
  constructor({ slug, url, viewport }) {
    this.slug = slug;
    this.url = url;
    this.viewport = viewport || { width: 1440, height: 900 };
    this.context = null;
    this.page = null;
    this.assets = null;
    this.status = 'starting';
    this.stepCount = 0;
    this.log = [];
    this.lastAutoCapture = 0;
    this.lastAutoUrl = '';
    this.capturing = false;
    this.error = null;
    this.finishedAt = null;
    // Nothing is recorded until the browser reaches the demo's start URL, so signing in and
    // clicking through to the right page never become steps. Sticky once set — the demo may
    // legitimately navigate anywhere after it begins. Manual capture overrides (arms) it.
    this.armed = false;
    this._navSeq = 0; // bumped on every load / SPA route signal; cancels in-flight arm checks
    this._armCheck = false;
    this._logWrite = Promise.resolve();
    this.newNodeIds = []; // nodes appended by this session, so polish can be scoped to them
  }

  // Does this page count as "the start page"? Origin must match; the path may be the start
  // URL's path or sit beneath it (apps love redirecting /dashboard to /dashboard/overview).
  // Query and hash are ignored — sign-in pages differ by path, not by query.
  urlMatches(url) {
    try {
      const a = new URL(url);
      const b = new URL(this.url);
      if (a.origin !== b.origin) return false;
      const norm = (p) => p.replace(/\/+$/, '') || '/';
      const ap = norm(a.pathname);
      const bp = norm(b.pathname);
      return ap === bp || (bp !== '/' && ap.startsWith(`${bp}/`));
    } catch {
      return false;
    }
  }

  arm(how) {
    if (this.armed) return;
    this.armed = true;
    this.note(`Start page reached (${how}) — recording from here.`);
  }

  // The autopilot queues what it is about to do, in viewer-facing words, before it acts. The
  // step that action produces claims it. Interaction steps only: the screen-transition step
  // that often follows a click describes a new screen, not the action, so it must not inherit
  // the same copy. Cleared on use, and stale intents expire so an action that recorded nothing
  // cannot mislabel a later step.
  setIntent(intent) {
    this.intent = intent ? { ...intent, at: Date.now() } : null;
  }

  takeIntent(reason) {
    const it = this.intent;
    if (!it) return null;
    if (!['click', 'input', 'submit'].includes(reason)) return null;
    if (Date.now() - it.at > 30000) {
      this.intent = null;
      return null;
    }
    this.intent = null;
    return it;
  }

  // A URL match alone must never arm. SPAs routinely sit at the requested URL while they boot,
  // decide the visitor is signed out, and only then bounce to their login screen — arming on
  // that first glimpse records the whole sign-in journey. So a match only schedules a re-check:
  // if the browser is still on the start page after a settle window, with no navigation in
  // between, it genuinely arrived. Then it arms and captures the start page as step 1.
  tryArm(page, how) {
    if (this.armed || this.status !== 'recording' || this._armCheck) return;
    let url = '';
    try {
      url = page.url();
    } catch {}
    if (!this.urlMatches(url)) return;
    const seq = this._navSeq;
    this._armCheck = true;
    setTimeout(() => {
      this._armCheck = false;
      if (this.armed || this.status !== 'recording') return;
      let now = '';
      try {
        now = page.url();
      } catch {}
      // Any navigation during the window means the first sighting was transient — the
      // navigation's own events will start a fresh attempt if it lands somewhere that counts.
      if (seq !== this._navSeq || !this.urlMatches(now)) return;
      this.arm(how);
      this.maybeAutoCapture('load', page);
    }, 1500);
  }

  note(msg) {
    this.log.push({ at: Date.now(), msg });
    if (this.log.length > 200) this.log.shift();
    console.log(`[capture] ${msg}`);
    this._appendLog(`${new Date().toISOString()}  ${msg}\n`);
  }

  // The in-memory log dies with the session and the banner only ever shows its last line, so
  // every note is also appended to demos/<slug>/capture.log as it happens — a failed run
  // leaves its trace even if the server crashes mid-recording. Appends are chained so lines
  // land in order, and failures are swallowed: a broken log file must never break the
  // recording it describes.
  _appendLog(line) {
    this._logWrite = this._logWrite
      .then(() => fs.appendFile(path.join(demoDir(this.slug), 'capture.log'), line))
      .catch(() => {});
  }

  async start() {
    const doc = await readDemo(this.slug);
    this.stepCount = doc.nodes.length;
    this._appendLog(`\n=== Recording started ${new Date().toISOString()} — ${this.url} (${this.viewport.width}×${this.viewport.height})\n`);

    const profileDir = path.join(PROFILES_DIR, this.slug);
    await fs.mkdir(profileDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(profileDir, {
      // Visible by definition — you are the one driving it. Overridable only so the
      // capture pipeline can be exercised by automated tests.
      headless: process.env.DEMO_CAPTURE_HEADLESS === '1',
      viewport: this.viewport,
      // Render at 2x. Widgets the serializer cannot express are pasted back in as photographs,
      // and a 1x photograph sitting among live HTML text looks obviously soft on any retina
      // screen. Layout is unaffected — this changes pixel density, not CSS pixels.
      deviceScaleFactor: 2,
      // A fixed viewport keeps every demo you record dimensionally consistent.
      args: [`--window-size=${this.viewport.width},${this.viewport.height + 140}`, '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    await this.context.exposeBinding('__demoRecord', async (source, payload) => this.onMessage(source, payload));
    await this.context.addInitScript(recorderScript);

    this.page = this.context.pages()[0] || (await this.context.newPage());

    this.assets = new AssetStore(this.slug, {
      userAgent: await this.page.evaluate(() => navigator.userAgent).catch(() => ''),
    });
    await this.assets.init();

    // The window closing is the natural "I'm done" signal.
    this.context.on('close', () => {
      if (this.status !== 'finished') {
        this.status = 'finished';
        this.finishedAt = Date.now();
        this.note('Browser closed — recording ended.');
        this.maybePolish();
      }
    });

    this.page.on('load', () => {
      this._navSeq++;
      this.maybeAutoCapture('load');
    });

    this.status = 'recording';
    this.note(`Opening ${this.url} — steps start once you're on that page (sign-in isn't recorded).`);
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' }).catch((e) => {
      this.note(`Navigation issue: ${e.message}`);
    });
    return this;
  }

  async onMessage(source, payload = {}) {
    const { type } = payload;
    // Recorder scripts live on in any page this session opened. Once the session is done,
    // ignore everything they send rather than acting on a stale binding.
    if (this.status !== 'recording' && type !== 'ready') return { stepCount: this.stepCount, ended: true };
    try {
      // A route change starts a new "navigation era" first, so it cancels any pending arm
      // check from the previous page before this URL gets considered.
      if (type === 'navigated') this._navSeq++;
      // Any message is a chance to notice we may have arrived at the start page.
      if (!this.armed) this.tryArm(source.page, type);

      if (type === 'ready' || type === 'ping') return { stepCount: this.stepCount, armed: this.armed, startUrl: this.url };

      if (type === 'capture') {
        // The manual Capture button is the escape hatch: pressing it while still unarmed
        // means "record from here anyway", wherever here is — no settle check, user intent.
        if (!this.armed && payload.reason === 'manual') this.arm('manual capture');
        if (!this.armed) {
          this.note(`Ignored ${payload.reason || 'interaction'} on ${source.page.url()} — not the start page yet.`);
          return { stepCount: this.stepCount, armed: false };
        }
        const node = await this.captureStep(source.page, payload);
        return { stepCount: this.stepCount, nodeId: node?.id ?? null, armed: true };
      }

      if (type === 'navigated') {
        this.maybeAutoCapture('spa-route', source.page);
        return { stepCount: this.stepCount, armed: this.armed };
      }

      if (type === 'undo') {
        await this.removeLastStep();
        return { stepCount: this.stepCount };
      }

      if (type === 'done') {
        this.note('Finishing…');
        this.status = 'finished';
        this.finishedAt = Date.now();
        setTimeout(() => this.close().catch(() => {}), 250);
        return { stepCount: this.stepCount };
      }
    } catch (e) {
      this.note(`Error: ${e.message}`);
      this.error = e.message;
    }
    return { stepCount: this.stepCount };
  }

  // A navigation or route change means a new screen — worth a step on its own. Debounced,
  // because a single click can produce a load event and a pushState in quick succession.
  maybeAutoCapture(reason, page) {
    if (this.status !== 'recording') return;
    const target = page || this.page;

    // Unarmed navigation never captures. It may kick off an arm check — if that check
    // verifies, tryArm calls back in here with the armed flag set.
    if (!this.armed) {
      this.tryArm(target, reason);
      return;
    }

    const now = Date.now();
    if (now - this.lastAutoCapture < 1200) return;
    this.lastAutoCapture = now;
    setTimeout(async () => {
      try {
        if (this.status !== 'recording') return;
        const url = await target.url();
        if (url === this.lastAutoUrl && reason !== 'load') return;
        // Let the app finish drawing before freezing it. Dashboards fetch each widget
        // separately, so a snapshot taken too early captures empty placeholder cards.
        const settle = await waitForSettled(target);
        if (this.status !== 'recording') return;
        // Settling takes real time, and the app may have moved on during it. Capturing now
        // would file the new screen under the old navigation; that screen's own event will
        // capture it properly.
        if ((await target.url()) !== url) return;
        if (settle.reason !== 'quiet') this.note(`Captured after ${settle.waited}ms (${settle.reason})`);
        this.lastAutoUrl = url;
        await this.captureStep(target, { reason, stabilize: true });
      } catch (e) {
        this.note(`Auto-capture skipped: ${e.message}`);
      }
    }, 350);
  }

  // Captures are serialised through a queue rather than dropped when one is already running.
  // A click and the navigation it triggers arrive almost together, and both are real steps —
  // discarding either loses the screen that invited the click.
  captureStep(page, meta = {}) {
    this.queue = (this.queue || Promise.resolve())
      .catch(() => {})
      .then(() => this._captureStep(page, meta));
    return this.queue;
  }

  async _captureStep(page, meta = {}) {
    // A finished session must never append another step. Without this, a browser window that
    // outlives stopCapture() — or a capture still sitting in the queue — can keep writing into
    // a demo long after the recording ended, which silently corrupts it.
    if (this.status !== 'recording') return null;
    this.capturing = true;
    try {
      if (page.isClosed?.()) return null;
      // A monotonic counter, never the step count: steps get deleted and whole recordings get
      // replaced, and reusing a filename would overwrite a snapshot that history still points
      // at — silently corrupting undo. Falls back to the count for demos recorded before the
      // counter existed. Claimed and persisted under the demo lock up front, because the
      // capture work below takes seconds and the doc must not be held across it.
      const seq = await withDemoLock(this.slug, async () => {
        const doc = await readDemo(this.slug);
        const s = (doc.stepSeq ?? doc.nodes.length) + 1;
        doc.stepSeq = s;
        await writeDemo(this.slug, doc, { history: false });
        return s;
      });
      const stepName = `step-${String(seq).padStart(3, '0')}`;

      let snap = await page.evaluate(serializeSnapshot);

      // Widgets that fetch their own data land after the page looks idle, so a snapshot can
      // freeze a dashboard whose cards are still empty. Serialize again and keep the later
      // result while the markup is still growing. Only for screen-arrival captures: a click
      // capture must freeze the screen the user was looking at *now*, and its click is held
      // until this returns, so any delay here would feel like the app ignoring them.
      if (meta.stabilize) snap = await this.stableSnapshot(page, snap);

      // Widgets the page will not hand over as markup — sandboxed iframes, tainted canvases —
      // come out of the serializer as blank boxes. Photograph those regions here; the debugger
      // reads rendered pixels, so the same-origin policy that blocked the page is no obstacle.
      await this.fillShotRegions(page, snap);

      const dir = demoDir(this.slug);
      await fs.mkdir(path.join(dir, 'steps'), { recursive: true });
      await fs.mkdir(path.join(dir, 'shots'), { recursive: true });

      // Shoot the thumbnail here, next to the serialization it illustrates. Taking it after the
      // asset fetch below meant it showed a later, more complete page than the step itself —
      // the filmstrip looked right while the real snapshot was missing widgets.
      await page
        .screenshot({ path: path.join(dir, 'shots', `${stepName}.png`), scale: 'css' })
        .catch(() => {});

      // Cookies let the asset fetcher reach images that sit behind the same auth as the app.
      const cookies = await this.context.cookies(snap.url).catch(() => []);
      this.assets.cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      const html = await this.assembleSnapshot(snap);
      await fs.writeFile(path.join(dir, 'steps', `${stepName}.html`), html, 'utf8');

      const targetId = meta.targetId || null;
      const targetInfo = targetId ? snap.targets?.[targetId] : null;

      // The slow work is done; only now touch the doc, freshly read under the lock, so edits
      // made in the editor while this capture was serializing are built on rather than
      // clobbered — writing the copy read before the capture is how deleted steps came back.
      const saved = await withDemoLock(this.slug, async () => {
        const d = await readDemo(this.slug);
        d.stepSeq = Math.max(d.stepSeq ?? 0, seq);
        const node = newNode(d, {
        snapshot: `steps/${stepName}.html`,
        shot: `shots/${stepName}.png`,
        url: snap.url,
        pageTitle: snap.title,
        scroll: snap.scroll,
        viewport: { w: snap.viewport.w, h: snap.viewport.h },
        capture: {
          reason: meta.reason || 'manual',
          at: new Date().toISOString(),
          // Click coordinates and typed values feed playback's re-enactment (guide cursor,
          // typing animation). Absent on manual/route captures, so only written when present.
          ...(meta.point ? { point: meta.point } : {}),
          ...(meta.value ? { value: String(meta.value) } : {}),
        },
        targetHint: meta.target || targetInfo || null,
        pageContext: snap.context || null,
        });

        node.annotation.target = targetId ? `[data-demo-target="${targetId}"]` : null;
        node.annotation.kind = targetId ? 'tooltip' : 'modal';
        node.advance.on = targetId ? 'click-target' : 'next';

        // Copy. The AI autopilot knows why it is doing each thing ("Choose the client for
        // this project"), so when it has queued an intent that wins outright. Otherwise fall
        // back to placeholder copy good enough to play before any editing.
        const hint = meta.target || targetInfo || {};
        const label = (hint.text || '').trim();
        const field = (hint.label || '').trim();
        const intent = this.takeIntent(meta.reason);

        if (intent) {
          node.annotation.title = clip(intent.title, 64);
          if (intent.body) node.annotation.body = intent.body;
        } else {
          node.annotation.title = placeholderTitle(meta.reason, hint, label, field) || clip(snap.title || '', 60);
        }

        d.nodes.push(node);
        await writeDemo(this.slug, d, { history: false });
        return { node, count: d.nodes.length, label };
      });

      this.newNodeIds.push(saved.node.id);

      this.stepCount = saved.count;
      this.note(`Captured ${stepName} (${meta.reason || 'manual'})${saved.label ? ` — ${saved.label.slice(0, 30)}` : ''}`);
      return saved.node;
    } finally {
      this.capturing = false;
    }
  }

  // Re-serialize until the markup stops growing. "Quiet DOM" is not the same as "finished":
  // a card can sit empty with no spinner while its request is in flight, which is invisible to
  // any settle heuristic but obvious here — the next serialization is materially bigger.
  async stableSnapshot(page, first) {
    let best = first;
    let stable = 0;
    // Two consecutive quiet reads, not one: a widget often lands in the gap right after the
    // first quiet sample, and stopping there is what let empty cards through.
    for (let i = 0; i < 4 && stable < 2; i++) {
      await page.waitForTimeout(700).catch(() => {});
      let next;
      try {
        next = await page.evaluate(serializeSnapshot);
      } catch {
        return best; // navigated away; what we have is the right screen
      }
      const grew = (next.html?.length || 0) - (best.html?.length || 0);
      best = next;
      // Under a percent of drift is a clock ticking or a hover class, not new content.
      if (grew <= (best.html?.length || 0) * 0.01) stable++;
      else {
        stable = 0;
        this.note(`Waiting — page still filling in (+${grew} chars)`);
      }
    }
    return best;
  }

  // Screenshot each region the serializer could not express as markup and store it as a normal
  // asset, keyed by the marker it left behind.
  async fillShotRegions(page, snap) {
    const shots = snap.shotRegions || [];
    if (!shots.length) return;
    snap.shotImages = {};
    for (const c of shots) {
      const { x, y, w, h } = c.rect;
      if (!(w > 1 && h > 1)) continue;
      try {
        const buf = await page.screenshot({
          clip: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) },
          // 'device', not 'css': the photograph is displayed at CSS size, so capturing at the
          // full device density is what makes it read as part of the page rather than an image.
          scale: 'device',
        });
        snap.shotImages[c.id] = await this.assets.saveBuffer(buf, 'png');
      } catch {
        // A region that cannot be photographed (off-page, zero-sized) simply stays blank.
      }
    }
    const n = Object.keys(snap.shotImages).length;
    if (n) this.note(`Photographed ${n} widget${n === 1 ? '' : 's'} the page would not hand over`);
  }

  // Turn the serializer's pieces into one flat file with every reference pointing at a
  // local asset.
  async assembleSnapshot(snap) {
    let css = snap.css || '';

    // Cross-origin stylesheets the browser refused to read — fetch them server-side, where
    // the same-origin policy does not apply.
    for (const href of snap.externalSheets || []) {
      try {
        const res = await fetch(href, {
          headers: {
            ...(this.assets.cookieHeader ? { Cookie: this.assets.cookieHeader } : {}),
            ...(this.assets.userAgent ? { 'User-Agent': this.assets.userAgent } : {}),
          },
        });
        if (res.ok) {
          const text = await res.text();
          css += '\n' + (await this.assets.rewriteCss(text, href, '../assets/'));
        }
      } catch {
        // A stylesheet we cannot reach is a cosmetic loss, not a failed capture.
      }
    }

    // Pull down every asset the page referenced and build a rewrite map.
    const urls = new Set(snap.assetUrls || []);
    for (const m of css.matchAll(/url\(\s*["']?(https?:[^"')]+)["']?\s*\)/gi)) urls.add(m[1]);
    const map = await this.assets.resolveMany([...urls], snap.url);

    const rewrite = (text) => {
      let out = text;
      for (const [from, to] of Object.entries(map)) {
        out = out.split(from).join(to);
        // Attribute values come back HTML-escaped from outerHTML.
        const escaped = from.replace(/&/g, '&amp;');
        if (escaped !== from) out = out.split(escaped).join(to);
      }
      return out;
    };

    css = rewrite(css);
    const head = rewrite(snap.head || '');
    let body = rewrite(snap.body || '');

    // Paste the photographed canvases back onto their placeholders. Done as CSS rather than by
    // rewriting the element so the placeholder keeps whatever layout the page gave it.
    for (const [id, href] of Object.entries(snap.shotImages || {})) {
      // !important because the page's own rules for these containers are unknown and this is
      // our reconstruction of content the DOM could not express, not page styling to respect.
      css += `\n[data-demo-shot="${id}"]{background-image:url("${href}") !important}`;
    }

    const htmlAttrs = `${snap.htmlAttrs || ''} data-demo-window-scroll="${snap.scroll.x},${snap.scroll.y}"`;

    return `<!doctype html>
<html ${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${snap.viewport.w}">
<title>${escapeHtml(snap.title || '')}</title>
${head}
<style>${css}</style>
<style>${SNAPSHOT_CSS}</style>
</head>
${body}
</html>`;
  }

  async removeLastStep() {
    const removed = await withDemoLock(this.slug, async () => {
      const doc = await readDemo(this.slug);
      const node = doc.nodes.pop();
      if (!node) return null;
      const dir = demoDir(this.slug);
      if (node.snapshot) await fs.rm(path.join(dir, node.snapshot), { force: true });
      if (node.shot) await fs.rm(path.join(dir, node.shot), { force: true });
      await writeDemo(this.slug, doc, { history: false });
      this.stepCount = doc.nodes.length;
      return node;
    });
    if (removed) {
      const i = this.newNodeIds.lastIndexOf(removed.id);
      if (i !== -1) this.newNodeIds.splice(i, 1);
      this.note('Removed last step');
    }
  }

  // A finished recording is polished before anyone reads it. This lives here, not in the
  // studio, because a recording can end in ways the studio never sees: the Finish button in
  // the browser's own bar, the window simply being closed, or the studio tab having been
  // reloaded since recording began. The autopilot polishes its own runs, so this covers the
  // hand-driven ones.
  maybePolish() {
    if (this.polishStarted || this.mode === 'auto') return;
    if (!hasKey()) return;
    // Only ever polish what THIS session shot. stepCount is the demo's running total, so
    // testing it meant opening and closing the recorder without capturing anything still
    // kicked off a full pass over the whole demo — which then pruned earlier, already-curated
    // takes. A session that recorded nothing must leave the demo untouched.
    const shot = this.recordedNodeIds();
    if (!shot.length) return;
    this.polishStarted = true;
    this.note(`Reviewing and polishing ${shot.length} new step${shot.length === 1 ? '' : 's'}…`);
    readDemo(this.slug)
      .then((doc) => polishDemo({ slug: this.slug, scenario: doc.description || '', draft: true, scope: shot }))
      .catch(() => {});
  }

  // The nodes this session appended, in order. Recorded as they are captured so a polish pass
  // can be confined to them and never re-judge steps the author already curated.
  recordedNodeIds() {
    return [...(this.newNodeIds || [])];
  }

  async close() {
    // Mark it finished first: closing can take a moment, and anything the recorder sends in
    // the meantime must be ignored rather than written.
    this.status = 'finished';
    this.maybePolish();
    if (!this._logEnded) {
      this._logEnded = true;
      this._appendLog(
        `=== Recording ended ${new Date().toISOString()} — ${this.stepCount} step${this.stepCount === 1 ? '' : 's'}${this.error ? `, error: ${this.error}` : ''}\n`
      );
    }
    try {
      // Never let a wedged browser leave the session hanging around half-alive.
      await Promise.race([this.context?.close(), new Promise((r) => setTimeout(r, 5000))]);
    } catch {}
    if (active === this) active = null;
  }

  toJSON() {
    return {
      slug: this.slug,
      url: this.url,
      status: this.status,
      mode: this.mode || 'manual',
      armed: this.armed,
      stepCount: this.stepCount,
      error: this.error,
      log: this.log.slice(-25),
    };
  }
}

// Placeholder copy for a step nobody has written yet: the verb has to match the control, or a
// tick box reads "Enter Schedule now". Kept short enough to sit on one tooltip line.
function placeholderTitle(reason, hint, label, field) {
  const control = hint.control || '';
  if (reason === 'input') return field ? `Enter ${lower(field)}` : 'Fill this in';
  if (reason === 'submit') return field ? `Submit ${lower(field)}` : 'Submit the form';
  if (reason !== 'click') return '';
  if (control === 'select') return field ? `Choose ${lower(field)}` : 'Make a selection';
  if (/^(checkbox|radio)$/.test(control)) {
    // checkedAfter is the state this click produces, so it names the outcome directly.
    const on = hint.checkedAfter !== false;
    const name = field || label;
    if (!name) return on ? 'Turn this on' : 'Turn this off';
    return `${on ? 'Turn on' : 'Turn off'} ${lower(name)}`;
  }
  // Clicking a cell or a chip quotes its contents, and when those contents are an empty state
  // the result reads as an instruction to pick nothing: Click "No dates". Only quote text that
  // belongs to something actually button-like.
  const semantic =
    /^(button|a|summary|label)$/i.test(hint.tag || '') ||
    /^(button|link|menuitem|tab|option|switch|checkbox|radio)$/i.test(hint.role || '');
  if (!semantic && /^(no\s|none$|unassigned$|unset$|empty$|add\b|[—–-]$)/i.test(label)) {
    return field ? `Open ${lower(field)}` : 'Open this';
  }
  return label ? `Click “${clip(label, 38)}”` : '';
}

// "CLIENT (OPTIONAL)" -> "client", "Project name *" -> "project name". Field labels are styled
// for the page (caps, asterisks, hint suffixes); step copy is a sentence. Fully upper-case
// labels are lowered; mixed case is left alone so "Slack channel" keeps its proper noun.
function lower(s) {
  const t = String(s)
    .replace(/\s*\((?:optional|required)\)\s*$/i, '')
    .replace(/[:*]\s*$/, '')
    .trim();
  return clip(/[a-z]/.test(t) ? t : t.toLowerCase(), 42);
}

// Truncate on a word boundary. Cutting mid-word ("capture t") is the thing that makes a
// generated caption look broken rather than merely brief.
function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\-–—]+$/, '')}…`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------------------------------------------------------------- prep browser
//
// The same persistent profile as a recording, opened with nothing attached: no recorder
// script, no bindings, no steps. It exists so the app can be put into the right state first —
// sign in, seed data, dismiss the tour — without any of that becoming part of the demo.
// Whatever it leaves behind (session cookies, created records) is exactly what the recording
// then starts from, because both use demos/<slug>'s profile directory.

/** @type {null | {slug: string, url: string, context: any, startedAt: number}} */
let prep = null;

export async function startPrep({ slug, url, viewport }) {
  if (active && active.status === 'recording') {
    throw new Error('A recording is in progress — finish it before opening the prep browser.');
  }
  // Chromium refuses to open one profile directory twice, so never run two of these at once.
  if (prep) await stopPrep();

  const view = viewport || { width: 1440, height: 900 };
  const profileDir = path.join(PROFILES_DIR, slug);
  await fs.mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.DEMO_CAPTURE_HEADLESS === '1',
    viewport: view,
    deviceScaleFactor: 2,
    args: [`--window-size=${view.width},${view.height + 140}`, '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  prep = { slug, url, context, startedAt: Date.now() };
  const self = prep;
  context.on('close', () => {
    if (prep === self) prep = null;
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  return prepStatus();
}

export function prepStatus() {
  return prep ? { open: true, slug: prep.slug, url: prep.url } : { open: false };
}

export async function stopPrep() {
  if (!prep) return { open: false };
  const closing = prep;
  prep = null;
  try {
    await Promise.race([closing.context.close(), new Promise((r) => setTimeout(r, 5000))]);
  } catch {}
  return { open: false };
}

export async function startCapture({ slug, url, viewport }) {
  if (active && active.status === 'recording') {
    throw new Error('A recording is already in progress. Finish it before starting another.');
  }
  // Recording reuses the profile the prep browser is holding open, so hand it over rather
  // than failing — prepping and then hitting Record is the intended flow, not a conflict.
  if (prep) await stopPrep();
  if (active) await active.close();
  const session = new Session({ slug, url, viewport });
  active = session;
  try {
    await session.start();
  } catch (e) {
    session.status = 'error';
    session.error = e.message;
    session.note(`Recording failed to start: ${e.message}`);
    throw e;
  }
  return session.toJSON();
}

// The live session, for callers that drive the recording browser themselves (the AI
// autopilot) and for tests that exercise the capture pipeline end-to-end.
export function activeSession() {
  return active;
}

// Test seam: lets the capture pipeline be driven programmatically end-to-end.
export function __activeForTest() {
  return active;
}

export function captureStatus() {
  return active ? active.toJSON() : { status: 'idle', stepCount: 0, log: [] };
}

export async function stopCapture() {
  if (!active) return { status: 'idle' };
  active.status = 'finished';
  active.finishedAt = Date.now();
  const snapshot = active.toJSON();
  await active.close();
  return snapshot;
}
