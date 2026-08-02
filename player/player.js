// The demo player.
//
// One implementation, three consumers: the studio's live preview, the standalone /play page,
// and the static export. Keeping it single-source means what you see while editing is exactly
// what a viewer gets.
//
// Two things make playback feel smooth rather than slideshow-ish:
//
//   1. Double-buffered iframes. Each step is its own HTML file, so pointing one iframe at the
//      next step would flash white on every advance. Instead two iframes are stacked, the next
//      step is preloaded into the hidden one, and advancing cross-fades between them.
//   2. Persistent overlay chrome. The spotlight, beacon and tooltip are created once and only
//      repositioned, so they glide from one target to the next instead of being torn down and
//      popped back into existence.
//
// On top of that, playback re-enacts the recorded session rather than just labelling it:
// a guide cursor glides to each step's target (landing on the recorded click point when the
// capture stored one) and rippling when the step advances, and steps that were captured from
// typing replay the text into the field keystroke by keystroke with a small key HUD. Both
// re-enactments are cosmetic — they never gate navigation, are cancelled by it, and are
// skipped entirely under prefers-reduced-motion.
//
// The stage is sized to the *captured* viewport (e.g. 1440x900) and CSS-scaled to fit its
// container. Target rects are measured in captured coordinates and scaled once, so highlights
// land precisely at any container size.

const FADE_MS = 190; // frame cross-fade; also gates the tooltip swap

export class DemoPlayer {
  /**
   * @param {HTMLElement} el       container to mount into
   * @param {object} opts
   *   demo    {object}  the demo document
   *   base    {string}  URL prefix that snapshot/shot paths resolve against
   *   vars    {object}  variable overrides (merged over defaults and ?query params)
   *   onEvent {function} analytics sink: (name, payload) => void
   *   editing {boolean} studio mode: never auto-advance, expose element picking
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.demo = opts.demo;
    this.base = (opts.base || '').replace(/\/$/, '');
    this.onEvent = opts.onEvent || (() => {});
    this.editing = !!opts.editing;
    this.onPick = opts.onPick || null;

    this.nodeId = null;
    this.history = [];
    this.scale = 1;
    this.active = 0;
    this.pickMode = false;
    this.destroyed = false;
    this.firstPaint = true;
    this.peeking = false; // guide hidden so the viewer can look at the underlying screen
    this._timer = null;
    this._seq = 0; // guards against out-of-order loads when clicking quickly

    this._cursorAt = null; // guide-cursor position in scaled overlay coords
    this._cursorAnim = null;
    this._typeTimer = null;
    this._typeRestore = null;
    this._motion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    this.vars = this.resolveVars(opts.vars);
    this.build();
  }

  resolveVars(overrides = {}) {
    const out = {};
    let qs = {};
    try {
      qs = Object.fromEntries(new URLSearchParams(location.search));
    } catch {}
    for (const v of this.demo?.variables || []) {
      out[v.key] = overrides[v.key] ?? qs[v.key] ?? v.default ?? '';
    }
    return out;
  }

  interpolate(text) {
    if (!text) return '';
    return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in this.vars ? this.vars[k] : m));
  }

  // ---- structure ---------------------------------------------------------

  build() {
    const d = this.demo;
    this.el.classList.add('dp');
    if (d?.settings?.freeRoam) this.el.classList.add('dp--freeroam');

    const t = d?.theme || {};
    this.el.style.setProperty('--dp-accent', t.accent || '#5b5bd6');
    this.el.style.setProperty('--dp-accent-text', t.accentText || '#fff');
    this.el.style.setProperty('--dp-radius', `${t.radius ?? 12}px`);
    this.el.style.setProperty('--dp-overlay', String(t.overlay ?? 0.55));
    if (t.font && t.font !== 'system') {
      const map = { inter: 'Inter, ui-sans-serif, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace' };
      this.el.style.setProperty('--dp-font', map[t.font] || 'inherit');
    }

    const frame = (i) =>
      `<iframe class="dp__frame ${i === 0 ? 'dp__frame--on' : ''}" data-buf="${i}"
               title="Product demo" scrolling="no"
               sandbox="allow-same-origin allow-forms allow-popups"></iframe>`;

    this.el.innerHTML = `
      <div class="dp__viewport">
        <div class="dp__stage">${frame(0)}${frame(1)}</div>
        <div class="dp__shield"></div>
        <div class="dp__layer">
          <div class="dp__progress"><div class="dp__progressbar"></div></div>
          <div class="dp__spot dp__off"></div>
          <div class="dp__hit dp__off"></div>
          <div class="dp__beacon dp__off"></div>
          <div class="dp__tip dp__off"></div>
          <div class="dp__keys dp__off"></div>
          <div class="dp__cursor dp__off">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M5 2.2 5 19.2 9.2 15.3 11.9 21.4 14.9 20 12.2 14.1 18 13.5 Z"
                    fill="#fff" stroke="#1c1c21" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="dp__nav dp__off"></div>
          <button class="dp__peek" type="button" aria-pressed="false"></button>
        </div>
        <div class="dp__loading">Loading demo…</div>
      </div>`;

    this.viewport = this.el.querySelector('.dp__viewport');
    this.stage = this.el.querySelector('.dp__stage');
    this.frames = [...this.el.querySelectorAll('.dp__frame')];
    this.shield = this.el.querySelector('.dp__shield');
    this.layer = this.el.querySelector('.dp__layer');
    this.loading = this.el.querySelector('.dp__loading');
    this.progress = this.el.querySelector('.dp__progressbar');
    this.progressBar = this.el.querySelector('.dp__progress');
    this.spot = this.el.querySelector('.dp__spot');
    this.hit = this.el.querySelector('.dp__hit');
    this.beacon = this.el.querySelector('.dp__beacon');
    this.tip = this.el.querySelector('.dp__tip');
    this.keys = this.el.querySelector('.dp__keys');
    this.cursor = this.el.querySelector('.dp__cursor');
    this.nav = this.el.querySelector('.dp__nav');
    this.peekBtn = this.el.querySelector('.dp__peek');
    this.peekBtn.addEventListener('click', () => this.setPeek(!this.peeking));
    this.renderPeek();

    // Escape is the universal "get me back" key, and a viewer who hides the guide and then
    // cannot find it again is stuck looking at a screenshot. The arrows page through the
    // demo — the same next/back as the nav bar — but never while someone is typing (the lead
    // form, the studio's inspector fields) or holding a modifier.
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.peeking && !this.editing) return this.setPeek(false);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = document.activeElement;
      if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.advance();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.back();
      }
    };
    addEventListener('keydown', this._onKey);

    this.shield.addEventListener('click', (e) => {
      if (this.demo?.settings?.freeRoam) return;
      e.stopPropagation();
      if (this.peeking) return; // nothing to nudge toward while the guide is hidden
      // The shield covers the snapshot, so a click on the page never reaches the snapshot's
      // own handler unless free roam is on. "Advance on any click" therefore has to be
      // honoured here too, or the click just nudges and the step never moves on.
      if ((this.node(this.nodeId)?.advance?.on || 'click-target') === 'any-click') return this.advance();
      this.nudge();
    });

    this.hit.addEventListener('click', () => this.advance());

    this.layer.addEventListener('click', (e) => {
      const b = e.target.closest('[data-branch]');
      if (b) return this.takeBranch(Number(b.dataset.branch));
      const g = e.target.closest('[data-goto]');
      if (g) return this.goTo(g.dataset.goto);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'next') this.advance();
      else if (act === 'back') this.back();
    });

    this._onResize = () => this.fit();
    addEventListener('resize', this._onResize);
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.fit());
      this._ro.observe(this.el);
    }
  }

  get nodes() {
    return this.demo?.nodes || [];
  }

  node(id) {
    return this.nodes.find((n) => n.id === id) || null;
  }

  resolveNext(id) {
    const n = this.node(id);
    if (!n) return null;
    if (n.next) return n.next;
    const i = this.nodes.findIndex((x) => x.id === id);
    return this.nodes[i + 1]?.id ?? null;
  }

  get frame() {
    return this.frames[this.active];
  }

  get doc() {
    try {
      return this.frame.contentDocument || null;
    } catch {
      return null;
    }
  }

  srcFor(node) {
    return `${this.base}/${node.snapshot}`.replace(/([^:]\/)\/+/g, '$1');
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    if (!this.nodes.length) {
      this.el.innerHTML = '<div class="dp__err">This demo has no steps yet. Record some in the studio.</div>';
      return;
    }
    this.onEvent('demo_view', { slug: this.demo.slug });
    this.buildNav();

    if (this.demo.leadForm?.enabled && this.demo.leadForm.position === 'start' && !this.editing) {
      this.showLeadForm(() => this.goTo(this.demo.settings?.startNodeId || this.nodes[0].id));
      return;
    }
    await this.goTo(this.demo.settings?.startNodeId || this.nodes[0].id);
  }

  async goTo(id, { record = true } = {}) {
    const node = this.node(id);
    if (!node) return;
    if (record && this.nodeId && this.nodeId !== id) this.history.push(this.nodeId);

    clearTimeout(this._timer);
    this.cancelTyping();
    const seq = ++this._seq;
    this.nodeId = id;
    this.onEvent('step_view', { slug: this.demo.slug, nodeId: id, index: this.nodes.indexOf(node) });

    // Start fading the old annotation out immediately so the change reads as one motion
    // rather than the page swapping and the tooltip catching up afterwards.
    if (!this.firstPaint) this.tip.classList.add('dp__fade');

    await this.showSnapshot(node);
    if (seq !== this._seq || this.destroyed) return; // superseded by a newer navigation

    this.updateChrome(node);
    const reenactMs = this.reenact(node, seq);
    this.scheduleAutoAdvance(node, reenactMs);

    // Preloading navigates the *other* buffer — which is the frame still being held opaque
    // underneath the one that is fading in. Blanking it mid-fade makes its white background
    // show through the half-transparent incoming frame, which is the bright flash between steps.
    // Wait until the fade is over and the hold released before warming it.
    clearTimeout(this._preloadTimer);
    this._preloadTimer = setTimeout(() => {
      if (!this.destroyed && seq === this._seq) this.preloadNext(node);
    }, FADE_MS + 140);
  }

  // Cross-fade to the buffer holding this step, loading it first if it isn't ready.
  async showSnapshot(node) {
    const src = this.srcFor(node);
    const vw = node.viewport?.w || 1440;
    const vh = node.viewport?.h || 900;
    this.captured = { w: vw, h: vh };
    for (const f of this.frames) {
      f.style.width = `${vw}px`;
      f.style.height = `${vh}px`;
    }
    this.stage.style.width = `${vw}px`;
    this.stage.style.height = `${vh}px`;
    this.fit();

    // Already showing it (e.g. re-selecting the same step in the editor).
    if (this.frame.dataset.src === src) {
      this.shownNodeId = node.id;
      this.afterSnapshotLoad(node, this.frame);
      return;
    }

    const incoming = this.frames[1 - this.active];
    if (incoming.dataset.src !== src) await this.loadInto(incoming, src);

    // Dress the buffer while it is still invisible. Applying the recorded scroll offset and
    // the overlays *after* revealing it meant every advance showed the page at the top for a
    // frame and then jumped, with un-blurred content flashing through — the single biggest
    // source of the flicker between steps.
    this.afterSnapshotLoad(node, incoming);
    // `load` fires before web fonts and images have settled, and fading in a frame that has
    // not painted yet shows its white background first and the content a moment later.
    await this.waitForPaint(incoming);
    if (this.destroyed) return;

    // Cross-fade without a transparent gap: the outgoing frame is pinned fully opaque
    // underneath while the incoming one fades in over it. Fading both at once put them at
    // ~50% together mid-transition, so the white behind them bled through as a flash.
    const outgoing = this.frames[this.active];
    outgoing.classList.add('dp__frame--hold');
    outgoing.classList.remove('dp__frame--on');
    incoming.classList.add('dp__frame--on');
    this.active = 1 - this.active;
    this.shownNodeId = node.id; // this step's screen is now the one on stage
    clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(() => outgoing.classList.remove('dp__frame--hold'), FADE_MS + 60);

    if (this.firstPaint) {
      this.firstPaint = false;
      this.loading.classList.add('dp__loading--gone');
    }
  }

  // Resolve once the frame's content is genuinely on screen — fonts settled, images decoded,
  // two of its own animation frames elapsed. Budgeted, because a snapshot with an asset that
  // never resolves must not stall playback.
  waitForPaint(frame, budgetMs = 600) {
    const settle = (async () => {
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      if (!doc || !win) return;
      try {
        await doc.fonts?.ready;
      } catch {}
      const pending = [...doc.images].filter((i) => !i.complete);
      if (pending.length) {
        await Promise.all(
          pending.map(
            (img) =>
              new Promise((r) => {
                img.addEventListener('load', r, { once: true });
                img.addEventListener('error', r, { once: true });
              }),
          ),
        );
      }
      await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
    })().catch(() => {});
    return Promise.race([settle, new Promise((r) => setTimeout(r, budgetMs))]);
  }

  loadInto(frame, src) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        frame.removeEventListener('load', done);
        frame.dataset.src = src;
        resolve();
      };
      frame.addEventListener('load', done);
      // A snapshot that fails to load must not hang playback.
      setTimeout(done, 6000);
      frame.setAttribute('src', src);
    });
  }

  // Warm the idle buffer with whatever comes next, so the following advance is instant.
  preloadNext(node) {
    const nextId = node.branches?.length ? node.branches[0].next : this.resolveNext(node.id);
    const next = this.node(nextId);
    if (!next?.snapshot) return;
    const idle = this.frames[1 - this.active];
    const src = this.srcFor(next);
    if (idle.dataset.src === src) return;
    idle.dataset.src = src;
    idle.setAttribute('src', src);
  }

  // `frame` is passed explicitly because this now runs on the *hidden* buffer, before the
  // cross-fade — it must not touch whichever frame happens to be active.
  afterSnapshotLoad(node, frame = this.frame) {
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch {}
    if (!doc) return;
    doc.documentElement.style.setProperty('--demo-accent', this.demo?.theme?.accent || '#5b5bd6');
    this.restoreScroll(node, doc, frame);
    this.applyOverlays(node, doc);
    this.bindSnapshotClicks(node, doc);

    // Web fonts land after load and shift layout. Re-measure once they settle, or the
    // spotlight sits a few pixels off its target on the first paint of each step.
    try {
      doc.fonts?.ready?.then(() => {
        if (!this.destroyed && this.nodeId === node.id) this.position(node);
      });
    } catch {}
  }

  // Snapshots carry no scripts, so scroll state is re-applied from here. The capture wrote
  // offsets as data attributes; without this, a step recorded halfway down a long page would
  // replay scrolled to the top and the target would sit off-screen.
  restoreScroll(node, doc, frame = this.frames[this.active]) {
    for (const el of doc.querySelectorAll('[data-demo-scroll]')) {
      const [x, y] = (el.getAttribute('data-demo-scroll') || '').split(',').map((v) => parseInt(v, 10) || 0);
      el.scrollLeft = x;
      el.scrollTop = y;
    }
    const win = doc.documentElement.getAttribute('data-demo-window-scroll');
    const [x, y] = win ? win.split(',').map((v) => parseInt(v, 10) || 0) : [node.scroll?.x || 0, node.scroll?.y || 0];
    frame.contentWindow?.scrollTo(x, y);
  }

  // Overlays are applied at playback, never baked into the capture, so every edit is
  // reversible and the original recording stays pristine.
  applyOverlays(node, doc) {
    for (const el of doc.querySelectorAll('[data-demo-blur],[data-demo-hidden],[data-demo-highlight]')) {
      el.removeAttribute('data-demo-blur');
      el.removeAttribute('data-demo-hidden');
      el.removeAttribute('data-demo-highlight');
    }
    for (const el of doc.querySelectorAll('[data-demo-orig]')) {
      el.textContent = el.getAttribute('data-demo-orig');
      el.removeAttribute('data-demo-orig');
    }

    for (const o of node.overlays || []) {
      let targets = [];
      try {
        targets = [...doc.querySelectorAll(o.target)];
      } catch {
        continue; // a malformed selector must never break playback
      }
      for (const el of targets) {
        if (o.type === 'blur') el.setAttribute('data-demo-blur', '1');
        else if (o.type === 'hide') el.setAttribute('data-demo-hidden', '1');
        else if (o.type === 'highlight') el.setAttribute('data-demo-highlight', '1');
        else if (o.type === 'text') {
          if (!el.hasAttribute('data-demo-orig')) el.setAttribute('data-demo-orig', el.textContent);
          el.textContent = this.interpolate(o.value);
        } else if (o.type === 'image' && 'src' in el) {
          el.src = o.value;
        }
      }
    }
  }

  bindSnapshotClicks(node, doc) {
    if (doc.__dpBound) doc.__dpBound();
    const handler = (e) => {
      if (this.pickMode) {
        e.preventDefault();
        e.stopPropagation();
        this.finishPick(e.target);
        return;
      }
      const sel = node.annotation?.target;
      const hitTarget = sel && e.target.closest && e.target.closest(sel);
      const mode = node.advance?.on || 'click-target';

      if (mode === 'any-click' || (mode === 'click-target' && hitTarget)) {
        e.preventDefault();
        e.stopPropagation();
        this.advance();
        return;
      }
      if (!this.demo?.settings?.freeRoam) {
        e.preventDefault();
        e.stopPropagation();
        this.nudge();
      }
    };
    doc.addEventListener('click', handler, true);
    doc.__dpBound = () => doc.removeEventListener('click', handler, true);
  }

  // ---- layout ------------------------------------------------------------

  fit() {
    if (!this.captured) return;
    const avail = this.el.clientWidth || this.captured.w;
    const scale = Math.min(1, avail / this.captured.w);
    this.scale = scale;
    this.stage.style.transform = `scale(${scale})`;
    this.viewport.style.height = `${this.captured.h * scale}px`;
    if (this.nodeId) this.position(this.node(this.nodeId));
  }

  targetRect(node) {
    const sel = node?.annotation?.target;
    if (!sel) return null;
    const doc = this.doc;
    if (!doc) return null;
    let el;
    try {
      el = doc.querySelector(sel);
    } catch {
      return null;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left * this.scale, y: r.top * this.scale, w: r.width * this.scale, h: r.height * this.scale };
  }

  // ---- chrome ------------------------------------------------------------

  buildNav() {
    if (this.demo.settings?.showControls === false) return;
    this.nav.classList.remove('dp__off');
    // Arrows only. A text label next to a chevron wraps in a narrow bar and reads as broken;
    // the direction is self-evident, so the words are carried by the tooltip instead.
    const chevron = (d) =>
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
            stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="${d}"/></svg>`;
    this.nav.innerHTML = `
      <button data-act="back" aria-label="Previous step" title="Previous step">${chevron('M15 5 8 12l7 7')}</button>
      <div class="dp__dots">${this.nodes
        .map((n, i) => `<span class="dp__dot" data-goto="${n.id}" title="Step ${i + 1}"></span>`)
        .join('')}</div>
      <button data-act="next" aria-label="Next step" title="Next step">${chevron('M9 5l7 7-7 7')}</button>`;
    this.navBack = this.nav.querySelector('[data-act="back"]');
    this.navNext = this.nav.querySelector('[data-act="next"]');
    this.dots = [...this.nav.querySelectorAll('.dp__dot')];
  }

  // Studio hook: the editor saves copy edits as the user types and wants them reflected on
  // the open tip without tearing the whole player down (which flickers and resets playback).
  // Swap in the fresh doc and repaint the current step's chrome; the snapshot is untouched.
  refresh(demo) {
    this.demo = demo;
    const node = this.node(this.nodeId);
    if (node) this.updateChrome(node);
  }

  updateChrome(node) {
    const d = this.demo;
    const idx = this.nodes.indexOf(node);
    const total = this.nodes.length;
    const hasNext = !!this.resolveNext(node.id);

    if (d.settings?.showProgress === false) this.progressBar.classList.add('dp__off');
    else {
      this.progressBar.classList.remove('dp__off');
      this.progress.style.width = `${total ? ((idx + 1) / total) * 100 : 0}%`;
    }

    if (this.dots) {
      this.dots.forEach((dot, i) => dot.classList.toggle('dp__dot--on', this.nodes[i]?.id === node.id));
      if (this.navBack) this.navBack.disabled = idx === 0;
      if (this.navNext) this.navNext.disabled = !hasNext;
    }

    this.renderTip(node, idx, total, hasNext);
  }

  // Swap the tooltip's contents while it is invisible, then fade it back in at its new
  // position. Repositioning a visible card makes it slide across the screen, which reads as
  // jank; a short fade reads as a deliberate transition.
  renderTip(node, idx, total, hasNext) {
    const a = node.annotation || {};
    const kind = a.kind || 'tooltip';
    const branches = node.branches || [];
    const title = this.interpolate(a.title);
    const body = this.interpolate(a.body);
    const showTip = kind !== 'none' && kind !== 'hotspot' && (title || body || branches.length);
    const advanceMode = node.advance?.on || 'click-target';
    const ctaLabel = a.ctaLabel || (hasNext ? 'Next' : 'Finish');
    const showCta = !branches.length && (advanceMode === 'next' || advanceMode === 'timer' || this.editing);
    const navHidden = this.demo.settings?.showControls === false;
    const showFoot = showCta || branches.length > 0 || navHidden;

    const paint = () => {
      this.tip.classList.toggle('dp__off', !showTip);
      this.tip.classList.toggle('dp__tip--modal', kind === 'modal');
      this.tip.classList.toggle('dp__tip--caption', kind === 'caption');
      if (showTip) {
        this.tip.innerHTML = `
          ${title ? `<h3>${esc(title)}</h3>` : ''}
          ${body ? `<p>${esc(body)}</p>` : ''}
          ${
            branches.length
              ? `<div class="dp__branches">${branches
                  .map((b, i) => `<button class="dp__branch" data-branch="${i}">${esc(this.interpolate(b.label))}</button>`)
                  .join('')}</div>`
              : ''
          }
          ${
            // Back/next and the position indicator live in the nav bar. Repeating them here
            // gave every step two competing control clusters saying the same thing, so the
            // footer now appears only when this step needs its own action — or when the nav
            // bar is switched off and nothing else shows progress.
            showFoot
              ? `<div class="dp__tipfoot">
                   <span class="dp__count">${idx + 1} of ${total}</span>
                   ${showCta ? `<button class="dp__btn" data-act="next">${esc(ctaLabel)}</button>` : ''}
                 </div>`
              : ''
          }`;
      }
      this.position(node);
      // Let layout settle at the new position before revealing.
      requestAnimationFrame(() => this.tip.classList.remove('dp__fade'));
    };

    if (this.tip.classList.contains('dp__fade')) setTimeout(paint, FADE_MS * 0.55);
    else paint();
  }

  position(node) {
    if (!node) return;
    // Only ever measure a step against its own screen. Sizing runs before the buffers swap, so
    // this would otherwise look up the new step's target inside the *previous* snapshot, find
    // nothing, and switch the spotlight off — taking the dimmed backdrop with it. That full
    // brightening and re-dimming mid-advance was the flicker.
    if (node.id !== this.shownNodeId) return;
    const r = this.targetRect(node);
    const kind = node.annotation?.kind || 'tooltip';
    const wantsSpot = this.demo.theme?.spotlight !== false && !!r && kind !== 'modal';
    const wantsHit = !!r && kind !== 'modal';
    const wantsBeacon = !!r && node.annotation?.beacon !== false && kind !== 'modal';
    const pad = 6;

    // An element that is currently hidden still sits wherever the last target was. Letting it
    // animate from there means it visibly sweeps across the screen as it fades in, which reads
    // as a flash; snap it into place first and only animate moves between visible targets.
    const snapping = [this.spot, this.hit, this.beacon].filter((el) => el.classList.contains('dp__off'));
    for (const el of snapping) el.style.transition = 'none';
    if (snapping.length) {
      requestAnimationFrame(() => {
        for (const el of snapping) el.style.transition = '';
      });
    }

    if (r) {
      const box = { left: r.x - pad, top: r.y - pad, width: r.w + pad * 2, height: r.h + pad * 2 };
      for (const el of [this.spot, this.hit]) {
        el.style.left = `${box.left}px`;
        el.style.top = `${box.top}px`;
        el.style.width = `${box.width}px`;
        el.style.height = `${box.height}px`;
      }
      this.beacon.style.left = `${r.x + r.w - 7}px`;
      this.beacon.style.top = `${r.y - 7}px`;
    }

    this.spot.classList.toggle('dp__off', !wantsSpot);
    this.hit.classList.toggle('dp__off', !wantsHit);
    this.beacon.classList.toggle('dp__off', !wantsBeacon);

    if (!this.tip.classList.contains('dp__off') && kind !== 'modal' && kind !== 'caption') {
      this.placeTip(this.tip, r, node.annotation?.placement || 'auto');
    } else {
      this.tip.style.left = '';
      this.tip.style.top = '';
    }

    // A resize or late font load moves the target; keep a settled cursor pinned to it.
    // Mid-glide the animation keeps aiming at its original destination — close enough,
    // and cancelling it on every reflow would make the cursor stutter.
    if (this._cursorAt && (!this._cursorAnim || this._cursorAnim.playState !== 'running')) {
      const dest = this.cursorDest(node);
      if (dest) {
        this._cursorAt = dest;
        this.cursor.style.left = `${dest.x}px`;
        this.cursor.style.top = `${dest.y}px`;
      }
    }
  }

  placeTip(tip, r, placement) {
    const W = this.el.clientWidth;
    const H = this.viewport.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 14;

    if (!r) {
      tip.style.left = `${(W - tw) / 2}px`;
      tip.style.top = `${(H - th) / 2}px`;
      return;
    }

    let place = placement;
    if (place === 'auto') {
      if (r.y + r.h + gap + th < H) place = 'bottom';
      else if (r.y - gap - th > 0) place = 'top';
      else if (r.x + r.w + gap + tw < W) place = 'right';
      else place = 'left';
    }

    let left, top;
    if (place === 'bottom') { left = r.x + r.w / 2 - tw / 2; top = r.y + r.h + gap; }
    else if (place === 'top') { left = r.x + r.w / 2 - tw / 2; top = r.y - th - gap; }
    else if (place === 'right') { left = r.x + r.w + gap; top = r.y + r.h / 2 - th / 2; }
    else if (place === 'left') { left = r.x - tw - gap; top = r.y + r.h / 2 - th / 2; }
    else { left = (W - tw) / 2; top = (H - th) / 2; }

    tip.style.left = `${clamp(left, 10, Math.max(10, W - tw - 10))}px`;
    tip.style.top = `${clamp(top, 10, Math.max(10, H - th - 10))}px`;
  }

  // ---- peek: hide the guide to inspect the real screen -------------------

  // Deliberately a labelled button rather than an icon: someone who has never seen a product
  // tour should be able to read what it does. It says what will happen next ("Hide guide"),
  // and it never hides itself or the back/next bar — those are the way back.
  renderPeek() {
    const on = this.peeking;
    const eye = on
      ? '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>'
      : '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/><path d="m4 20 16-16"/>';
    this.peekBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${eye}</svg>` +
      `<span>${on ? 'Show guide' : 'Hide guide'}</span>`;
    this.peekBtn.setAttribute('aria-pressed', String(on));
    this.peekBtn.title = on ? 'Bring the tour back (Esc)' : 'Hide the tour and look at the screen on its own';
  }

  setPeek(on) {
    if (this.peeking === on) return;
    this.peeking = on;
    this.el.classList.toggle('dp--peek', on);
    // Typing replay rewrites the field it is animating. While the guide is hidden the viewer
    // is looking at the product itself, so put the captured value back and leave it alone.
    if (on) this.cancelTyping();
    this.renderPeek();
    this.onEvent(on ? 'guide_hidden' : 'guide_shown', { slug: this.demo.slug, nodeId: this.nodeId });
  }

  // ---- re-enactment: guide cursor and typing -----------------------------

  // Play the step's recorded gesture: glide the cursor to the target, then replay any typing.
  // Returns how long the whole performance takes, so autoplay can wait for it to finish.
  reenact(node, seq) {
    let travel = 0;
    // Nothing is performed while the guide is hidden — the viewer asked to see the screen.
    if (this.peeking) return 0;
    const wantCursor = this.demo.settings?.cursor !== false && !this._motion.matches;
    const dest = wantCursor ? this.cursorDest(node) : null;
    if (dest) travel = this.moveCursor(dest);
    else {
      this.cursor.classList.add('dp__off');
      this._cursorAt = null;
    }

    const plan = this.typingPlan(node);
    if (!plan) return travel;
    const startAt = travel + 240; // a beat after the cursor lands, like a hand moving to the keys
    this.playTyping(plan, seq, startAt);
    return startAt + plan.total + 500;
  }

  // Where the cursor should sit for this step: the recorded click point when the capture
  // stored one (clamped into the target in case a font shift moved the element), otherwise
  // just inside the target's centre.
  cursorDest(node) {
    const r = this.targetRect(node);
    if (!r) return null;
    const pt = node.capture?.point;
    if (pt) {
      return {
        x: clamp(pt.x * this.scale, r.x + 3, r.x + Math.max(3, r.w - 3)),
        y: clamp(pt.y * this.scale, r.y + 3, r.y + Math.max(3, r.h - 3)),
      };
    }
    return { x: r.x + r.w * 0.55, y: r.y + r.h * 0.6 };
  }

  // Glide, don't teleport: duration scales with distance and the path bows slightly
  // perpendicular to the travel line, because a dead-straight constant-speed cursor reads
  // as a screensaver, not a hand.
  moveCursor(dest) {
    const c = this.cursor;
    c.classList.remove('dp__off');
    const from = this._cursorAt || { x: this.el.clientWidth * 0.5, y: (this.viewport.clientHeight || 300) + 24 };
    this._cursorAnim?.cancel();
    c.style.left = `${dest.x}px`;
    c.style.top = `${dest.y}px`;
    const dx = from.x - dest.x;
    const dy = from.y - dest.y;
    const dist = Math.hypot(dx, dy);
    this._cursorAt = dest;
    if (dist < 3 || !c.animate) return 0;
    const dur = clamp(dist * 1.3, 420, 950);
    const arc = Math.min(46, dist * 0.12);
    this._cursorAnim = c.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: `translate(${dx / 2 + (-dy / dist) * arc}px, ${dy / 2 + (dx / dist) * arc}px)`, offset: 0.5 },
        { transform: 'translate(0, 0)' },
      ],
      { duration: dur, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    );
    return dur;
  }

  // A visible press when the step advances: ripple at the cursor plus a quick dip of the
  // cursor itself. Fire-and-forget — navigation never waits for it.
  clickFx() {
    if (!this._cursorAt || this.cursor.classList.contains('dp__off')) return;
    const rip = document.createElement('div');
    rip.className = 'dp__ripple';
    rip.style.left = `${this._cursorAt.x}px`;
    rip.style.top = `${this._cursorAt.y}px`;
    this.layer.appendChild(rip);
    setTimeout(() => rip.remove(), 700);
    if (!this._motion.matches && this.cursor.animate) {
      this._cursorAnim?.cancel();
      this.cursor.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(0.82)' }, { transform: 'scale(1)' }],
        { duration: 230, easing: 'ease-out' },
      );
    }
  }

  // What, if anything, this step should type. Steps captured from a form commit replay their
  // value; the value comes from the capture record when the recorder stored it, else from the
  // snapshot itself (the field was serialized already filled), which is what makes this work
  // for demos recorded before values were persisted.
  typingPlan(node) {
    if (this.demo.settings?.typing === false || this._motion.matches) return null;
    const reason = node.capture?.reason;
    if (reason === 'submit') return { kind: 'enter', total: 650 };
    if (reason !== 'input') return null;

    let el = null;
    try {
      el = node.annotation?.target ? this.doc?.querySelector(node.annotation.target) : null;
    } catch {}
    const texty =
      el &&
      (el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && /^(text|email|search|url|tel|password|number)$/.test(el.type || 'text')));

    let value = String(node.capture?.value ?? '');
    if (!value && texty) value = String(el.value || '');
    if (!value) return null;
    value = value.slice(0, 160);
    if (!texty) el = null; // selects, checkboxes: animate the key HUD only, leave the control alone

    const perChar = clamp(Math.round(1300 / value.length), 26, 70);
    return { kind: 'type', el, value, perChar, total: value.length * perChar };
  }

  playTyping(plan, seq, delay) {
    if (plan.kind === 'enter') {
      this._typeTimer = setTimeout(() => {
        if (this.destroyed || seq !== this._seq) return;
        this.showKeys(null);
        this._typeTimer = setTimeout(() => this.hideKeys(), 1400);
      }, delay);
      return;
    }

    const { el, value, perChar } = plan;
    const setVal = (v) => {
      try {
        if (el) el.value = v;
      } catch {}
    };
    // Empty the field now so it sits blank while the cursor travels to it, and make sure any
    // interruption puts the full value back — the buffer may be re-shown later without a reload.
    setVal('');
    this._typeRestore = () => setVal(value);

    let i = 0;
    const tick = () => {
      if (this.destroyed || seq !== this._seq) return; // cancelTyping already restored the value
      i++;
      setVal(value.slice(0, i));
      this.showKeys(value.slice(0, i));
      if (i < value.length) this._typeTimer = setTimeout(tick, perChar);
      else {
        this._typeRestore = null;
        this._typeTimer = setTimeout(() => this.hideKeys(), 1200);
      }
    };
    this._typeTimer = setTimeout(tick, delay);
  }

  cancelTyping() {
    clearTimeout(this._typeTimer);
    this._typeTimer = null;
    if (this._typeRestore) {
      this._typeRestore();
      this._typeRestore = null;
    }
    this.hideKeys();
  }

  // text = growing string to display; null means show an Enter keycap instead.
  showKeys(text) {
    this.keys.classList.remove('dp__off');
    if (text === null) {
      this.keys.innerHTML = '<span class="dp__kbd">Enter ⏎</span>';
      return;
    }
    const tail = text.length > 34 ? `…${text.slice(-33)}` : text;
    this.keys.innerHTML = `<span class="dp__keytext">${esc(tail)}</span><span class="dp__caret"></span>`;
  }

  hideKeys() {
    this.keys.classList.add('dp__off');
  }

  // ---- navigation --------------------------------------------------------

  advance() {
    const node = this.node(this.nodeId);
    if (!node) return;
    if (node.branches?.length) return; // a fork must be chosen explicitly
    this.clickFx();
    const next = this.resolveNext(this.nodeId);
    this.onEvent('step_complete', { slug: this.demo.slug, nodeId: this.nodeId });
    if (next) return this.goTo(next);
    this.finish();
  }

  takeBranch(i) {
    const node = this.node(this.nodeId);
    const b = node?.branches?.[i];
    if (!b) return;
    this.onEvent('branch', { slug: this.demo.slug, nodeId: this.nodeId, label: b.label });
    this.goTo(b.next);
  }

  back() {
    const prev = this.history.pop();
    if (prev) return this.goTo(prev, { record: false });
    const i = this.nodes.findIndex((n) => n.id === this.nodeId);
    if (i > 0) this.goTo(this.nodes[i - 1].id, { record: false });
  }

  // extraMs is how long this step's re-enactment (cursor glide, typing) runs; autoplay
  // waits it out so a step never advances while its text is still being typed.
  scheduleAutoAdvance(node, extraMs = 0) {
    clearTimeout(this._timer);
    if (this.editing) return;
    const auto = this.demo.settings?.autoplay;
    const mode = node.advance?.on;
    if (mode === 'timer' || auto) {
      const ms = (mode === 'timer' && node.advance?.ms) || this.demo.settings?.autoplayMs || 4000;
      this._timer = setTimeout(() => this.advance(), ms + extraMs);
    }
  }

  finish() {
    this.onEvent('demo_complete', { slug: this.demo.slug });
    const lf = this.demo.leadForm;
    if (lf?.enabled && lf.position === 'end' && !this.editing) return this.showLeadForm(() => this.showEnd());
    if (this.demo.settings?.loop) return this.goTo(this.nodes[0].id, { record: false });
    this.showEnd();
  }

  // Reaching the end must always produce a visible result. An unconfigured call to action is
  // the common case, and previously it made the Finish button do nothing at all.
  showEnd() {
    if (this.demo.settings?.loop) return this.goTo(this.nodes[0].id, { record: false });

    const cta = this.demo.endCta || {};
    const hasCta = !!(cta.enabled && (cta.href || cta.label));

    this.panel(
      `<div class="dp__card">
        <h2>${esc(this.interpolate(cta.headline || (hasCta ? this.demo.name : "That's the tour")))}</h2>
        <p>${esc(this.interpolate(cta.body || `You've seen all ${this.nodes.length} steps of ${this.demo.name || 'this demo'}.`))}</p>
        ${hasCta ? `<button class="dp__btn" data-cta>${esc(cta.label || 'Get started')}</button>` : ''}
        <div class="dp__endacts">
          <button class="dp__btn dp__btn--ghost" data-restart>Watch again</button>
          <button class="dp__btn dp__btn--ghost" data-close>Back to the demo</button>
        </div>
      </div>`,
      (root, close) => {
        root.querySelector('[data-cta]')?.addEventListener('click', () => {
          this.onEvent('cta_click', { slug: this.demo.slug, href: cta.href });
          if (cta.href) open(cta.href, '_blank', 'noopener');
        });
        root.querySelector('[data-restart]')?.addEventListener('click', () => {
          close();
          this.history = [];
          this.goTo(this.nodes[0].id, { record: false });
        });
        // Dismissing leaves the viewer on the final screen rather than trapping them.
        root.querySelector('[data-close]')?.addEventListener('click', close);
        root.addEventListener('click', (e) => {
          if (e.target === root) close();
        });
      },
    );
  }

  showLeadForm(after) {
    const lf = this.demo.leadForm || {};
    const fields = (lf.fields || [])
      .map(
        (f) => `<div class="dp__field">
            <label for="dpf_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
            <input id="dpf_${f.key}" name="${esc(f.key)}" type="${esc(f.type || 'text')}" ${f.required ? 'required' : ''}>
          </div>`,
      )
      .join('');

    this.panel(
      `<form class="dp__card">
        <h2>${esc(this.interpolate(lf.headline || 'Tell us about you'))}</h2>
        ${lf.body ? `<p>${esc(this.interpolate(lf.body))}</p>` : ''}
        ${fields}
        <button class="dp__btn" type="submit">${esc(lf.submitLabel || 'Continue')}</button>
      </form>`,
      (root, close) => {
        root.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.target));
          this.onEvent('lead', { slug: this.demo.slug, ...data });
          // Captured fields double as variables, so later steps can greet by company name.
          Object.assign(this.vars, data);
          close();
          after?.();
        });
      },
    );
  }

  panel(html, wire) {
    const root = document.createElement('div');
    root.className = 'dp__panel';
    root.innerHTML = html;
    this.viewport.appendChild(root);
    const close = () => root.remove();
    wire?.(root, close);
    return close;
  }

  nudge() {
    for (const el of [this.hit, this.beacon]) {
      if (!el || el.classList.contains('dp__off')) continue;
      el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], {
        duration: 420,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      });
    }
  }

  // ---- studio: click an element in the snapshot to retarget a step --------

  startPick(cb) {
    this.pickMode = true;
    this._pickCb = cb;
    this.shield.style.pointerEvents = 'none';
    const doc = this.doc;
    if (doc) doc.body.style.cursor = 'crosshair';
  }

  finishPick(el) {
    this.pickMode = false;
    const doc = this.doc;
    if (doc) doc.body.style.cursor = '';
    this.shield.style.pointerEvents = '';
    this._pickCb?.(selectorFor(interactiveAncestor(el)));
    this._pickCb = null;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._timer);
    clearTimeout(this._preloadTimer);
    clearTimeout(this._holdTimer);
    this.cancelTyping();
    this._cursorAnim?.cancel();
    removeEventListener('resize', this._onResize);
    if (this._onKey) removeEventListener('keydown', this._onKey);
    this._ro?.disconnect();
    for (const f of this.frames || []) {
      try {
        f.contentDocument?.__dpBound?.();
      } catch {}
    }
  }
}

// Picks land on the innermost node — the <span> inside a button, the text inside a clickable
// card. A demo should target the control, not the fragment, so resolve upward the same way the
// recorder does: nearest semantic interactive ancestor, else the outermost contiguous
// cursor:pointer ancestor (size-capped so an overlay never swallows the highlight).
const INTERACTIVE =
  'button, a, input, select, textarea, summary, label, [onclick], [role="button"], [role="link"], ' +
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"]';

export function interactiveAncestor(el) {
  if (!el || el.nodeType !== 1) return el;
  const win = el.ownerDocument?.defaultView;
  const fits = (n) => {
    const r = n.getBoundingClientRect();
    const cap = win ? win.innerWidth * win.innerHeight * 0.35 : Infinity;
    return r.width > 0 && r.height > 0 && r.width * r.height <= cap;
  };
  const semantic = el.closest?.(INTERACTIVE);
  if (semantic && fits(semantic)) return semantic;

  let best = el;
  let cur = el;
  const doc = el.ownerDocument;
  while (cur && cur.nodeType === 1 && cur !== doc.body && cur !== doc.documentElement) {
    let pointer = false;
    try {
      pointer = win.getComputedStyle(cur).cursor === 'pointer';
    } catch {}
    if (pointer && fits(cur)) best = cur;
    else if (!pointer && best !== el) break;
    cur = cur.parentElement;
  }
  return best;
}

// Prefer the anchor the recorder wrote; fall back to a structural path.
export function selectorFor(el) {
  if (!el || el.nodeType !== 1) return null;
  const tagged = el.closest('[data-demo-target]');
  if (tagged) return `[data-demo-target="${tagged.getAttribute('data-demo-target')}"]`;
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;

  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 6) {
    let part = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    cur = parent;
  }
  return parts.join(' > ');
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Auto-mount for the standalone play page and static export:
//   <div data-demo-src="./demo.json"></div>
export async function autoMount(root = document) {
  const nodes = root.querySelectorAll('[data-demo-src]');
  const players = [];
  for (const el of nodes) {
    const src = el.getAttribute('data-demo-src');
    const demo = await fetch(src).then((r) => r.json());
    const base = src.replace(/\/[^/]*$/, '');
    const p = new DemoPlayer(el, { demo, base, onEvent: makeBeacon(demo) });
    players.push(p);
    await p.start();
  }
  return players;
}

// Analytics: posts to the configured endpoint, silently no-ops when unset.
export function makeBeacon(demo) {
  const cfg = demo?.analytics || {};
  return (name, payload) => {
    if (!cfg.enabled) return;
    const url = cfg.endpoint || '';
    if (!url) return;
    const body = JSON.stringify({ event: name, at: Date.now(), ...payload });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      else fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
    } catch {}
  };
}
