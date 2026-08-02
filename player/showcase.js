// Feature showcase: a drop-in component that presents several features, each backed by an
// interactive demo or a video, with commentary alongside.
//
// The interaction the component is built around: the viewer sees a list of feature names,
// clicks one, the demo opens in place with commentary explaining it, and they move on to the
// next feature either by scrolling or by clicking.
//
// Demos are mounted lazily — a showcase with ten features must not load ten snapshot bundles
// on page load.

import { DemoPlayer, makeBeacon } from './player.js';

export class FeatureShowcase {
  /**
   * @param {HTMLElement} el
   * @param {object} opts
   *   doc  {object}  the showcase document
   *   base {string}  URL prefix that demo folders resolve against
   *   onEvent {function} analytics sink
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.doc = opts.doc;
    this.base = (opts.base || '').replace(/\/$/, '');
    this.onEvent = opts.onEvent || (() => {});
    this.players = new Map();
    this.activeId = null;
  }

  get features() {
    return this.doc?.features || [];
  }

  mount() {
    const d = this.doc;
    const t = d.theme || {};

    this.el.classList.add('sc');
    if (t.dark) this.el.classList.add('sc--dark');
    if (t.layout === 'tabs') this.el.classList.add('sc--tabs');
    this.el.style.setProperty('--sc-accent', t.accent || '#5b5bd6');
    this.el.style.setProperty('--sc-accent-text', t.accentText || '#fff');
    this.el.style.setProperty('--sc-radius', `${t.radius ?? 14}px`);

    if (!this.features.length) {
      this.el.innerHTML = '<div class="sc__missing">This showcase has no features yet.</div>';
      return this;
    }

    const showNums = d.settings?.showFeatureNumbers !== false;

    this.el.innerHTML = `
      <nav class="sc__rail" aria-label="Features">
        <div class="sc__railhead">Features</div>
        ${this.features
          .map(
            (f, i) => `
          <button class="sc__item" data-feature="${esc(f.id)}" type="button">
            ${showNums ? `<span class="sc__num">${String(i + 1).padStart(2, '0')}</span>` : ''}
            <span class="sc__itemtext">
              <span class="sc__itemname">${esc(f.name)}</span>
              ${f.tagline ? `<span class="sc__itemtag">${esc(f.tagline)}</span>` : ''}
            </span>
          </button>`,
          )
          .join('')}
      </nav>
      <div class="sc__stage">
        ${this.features.map((f, i) => this.panelHtml(f, i)).join('')}
      </div>`;

    this.el.querySelector('.sc__rail').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-feature]');
      if (!btn) return;
      this.open(btn.dataset.feature, { scroll: true });
    });

    this.el.querySelector('.sc__stage').addEventListener('click', (e) => {
      const poster = e.target.closest('[data-open]');
      if (poster) return this.open(poster.dataset.open, { scroll: false });
      const next = e.target.closest('[data-next]');
      if (next) return this.openNext(next.dataset.next);
    });

    this.observe();

    // Open the first feature so the component never looks inert on arrival.
    this.setActive(this.features[0].id);
    return this;
  }

  panelHtml(f, i) {
    const showCommentary = this.doc.settings?.showCommentary !== false;
    const isLast = i === this.features.length - 1;
    const cta = this.doc.settings || {};
    // A poster that fails to load falls back to the plain name card rather than leaving a
    // broken image on someone's marketing page.
    const poster = f.poster
      ? `<img src="${esc(this.resolve(f.poster))}" alt="" loading="lazy"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'sc__posterempty',textContent:this.dataset.name}))"
             data-name="${esc(f.name)}">`
      : `<div class="sc__posterempty">${esc(f.name)}</div>`;

    return `
      <section class="sc__panel" id="sc-${esc(f.id)}" data-panel="${esc(f.id)}">
        <div class="sc__head">
          <h3 class="sc__title">${esc(f.name)}</h3>
          ${f.tagline ? `<p class="sc__tagline">${esc(f.tagline)}</p>` : ''}
        </div>
        <div class="sc__media" data-media="${esc(f.id)}">
          <button class="sc__poster" data-open="${esc(f.id)}" type="button" aria-label="Open ${esc(f.name)}">
            ${poster}
            <span class="sc__play"><span class="sc__playbtn">▶ Try it</span></span>
          </button>
        </div>
        ${showCommentary && f.commentary ? `<div class="sc__commentary">${paragraphs(f.commentary)}</div>` : ''}
        <div class="sc__foot">
          ${
            isLast
              ? cta.ctaLabel && cta.ctaHref
                ? `<a class="sc__cta" href="${esc(cta.ctaHref)}" target="_blank" rel="noopener">${esc(cta.ctaLabel)}</a>`
                : '<span class="sc__hint">That\'s the tour.</span>'
              : `<button class="sc__next" data-next="${esc(f.id)}" type="button">Next: ${esc(this.features[i + 1].name)} →</button>`
          }
          <span class="sc__hint">${i + 1} of ${this.features.length}</span>
        </div>
      </section>`;
  }

  resolve(p) {
    if (!p || /^(https?:|data:|\/)/i.test(p)) return p;
    return `${this.base}/${p}`.replace(/([^:]\/)\/+/g, '$1');
  }

  // Scroll position drives which feature is highlighted, so scrolling *is* navigation —
  // no separate control needed.
  observe() {
    if (this.doc.settings?.advanceOnScroll === false || !window.IntersectionObserver) return;
    this.io = new IntersectionObserver(
      (entries) => {
        // Choose the panel closest to the top of the viewport among those intersecting.
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return;
        visible.sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
        const id = visible[0].target.dataset.panel;
        if (id && id !== this.activeId) this.setActive(id);
      },
      { rootMargin: '-15% 0px -55% 0px', threshold: [0, 0.25, 0.5] },
    );
    for (const p of this.el.querySelectorAll('[data-panel]')) this.io.observe(p);
  }

  setActive(id) {
    this.activeId = id;
    for (const b of this.el.querySelectorAll('[data-feature]')) {
      b.classList.toggle('sc__item--on', b.dataset.feature === id);
    }
    this.onEvent('feature_view', { showcase: this.doc.slug, feature: id });
  }

  openNext(fromId) {
    const i = this.features.findIndex((f) => f.id === fromId);
    const next = this.features[i + 1];
    if (next) this.open(next.id, { scroll: true });
  }

  async open(id, { scroll = false } = {}) {
    const f = this.features.find((x) => x.id === id);
    if (!f) return;
    this.setActive(id);

    const panel = this.el.querySelector(`[data-panel="${cssEscape(id)}"]`);
    if (scroll && panel) panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

    const media = this.el.querySelector(`[data-media="${cssEscape(id)}"]`);
    if (!media || this.players.has(id) || media.dataset.loaded === '1') return;
    media.dataset.loaded = '1';

    this.onEvent('feature_open', { showcase: this.doc.slug, feature: id });

    if (f.media === 'video') {
      media.innerHTML = `<video controls autoplay playsinline ${f.poster ? `poster="${esc(this.resolve(f.poster))}"` : ''} src="${esc(this.resolve(f.videoSrc))}"></video>`;
      return;
    }

    if (!f.demoSlug || f.missing) {
      media.innerHTML = `<div class="sc__missing">No demo is linked to this feature yet.</div>`;
      return;
    }

    media.innerHTML = '<div class="sc__missing">Loading demo…</div>';
    try {
      const demoBase = `${this.base}/demos/${f.demoSlug}`.replace(/([^:]\/)\/+/g, '$1');
      const demo = await fetch(`${demoBase}/demo.json`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      media.innerHTML = '';
      const host = document.createElement('div');
      media.appendChild(host);
      const player = new DemoPlayer(host, {
        demo,
        base: demoBase,
        onEvent: (name, payload) => this.onEvent(name, { showcase: this.doc.slug, feature: id, ...payload }),
      });
      this.players.set(id, player);
      await player.start();
    } catch (e) {
      media.innerHTML = `<div class="sc__missing">Could not load this demo (${esc(e.message)}).</div>`;
      media.dataset.loaded = '0';
    }
  }

  destroy() {
    this.io?.disconnect();
    for (const p of this.players.values()) p.destroy();
    this.players.clear();
  }
}

function paragraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
const prefersReducedMotion = () => matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export { makeBeacon };
