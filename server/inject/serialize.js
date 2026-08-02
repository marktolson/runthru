// Runs INSIDE the captured page via page.evaluate().
//
// Must be entirely self-contained: no imports, no references to module scope. Playwright
// ships the function source into the browser, so everything it needs is defined inline.
//
// The job is to turn a living application into a flat, offline-renderable document:
//   - collapse every stylesheet (including cross-origin and constructed ones) into one blob
//   - clone the DOM *including shadow roots*, which cloneNode() silently drops
//   - write back live state the markup never had (typed values, checked boxes, scroll offsets)
//   - rasterise <canvas>, since its pixels live in GPU memory, not markup
//   - collect every asset URL so the server can pull them down and rewrite the references
//
// It returns the pieces; server/capture.js assembles the final file.

export function serializeSnapshot() {
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT']);
  const assetUrls = new Set();
  const externalSheets = [];
  // Regions the page cannot hand over as markup: canvases tainted by a cross-origin draw, and
  // iframes whose document script may not read. Recorded with page coordinates so the server
  // can photograph each one and paste it back in — it renders pixels the DOM will not give up.
  const shotRegions = [];
  let shotSeq = 0;
  let uid = 0;

  const abs = (u) => {
    if (!u) return '';
    const s = String(u).trim();
    if (/^(data:|blob:|about:|javascript:|#)/i.test(s)) return s;
    try {
      return new URL(s, document.baseURI).toString();
    } catch {
      return s;
    }
  };

  const track = (u) => {
    const a = abs(u);
    if (a && /^https?:/i.test(a)) assetUrls.add(a);
    return a;
  };

  // "a.png 1x, b.png 2x" -> absolute, tracked
  const absSrcset = (v) =>
    String(v || '')
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return '';
        bits[0] = track(bits[0]);
        return bits.join(' ');
      })
      .filter(Boolean)
      .join(', ');

  // ---- stylesheets -------------------------------------------------------

  // Rewrite url(...) inside a rule block to absolute, relative to the sheet that declared it.
  function absolutiseCss(cssText, baseHref) {
    return String(cssText).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      if (/^(data:|about:|#)/i.test(u)) return m;
      let resolved = u;
      try {
        resolved = new URL(u, baseHref || document.baseURI).toString();
      } catch {}
      if (/^https?:/i.test(resolved)) assetUrls.add(resolved);
      return `url("${resolved}")`;
    });
  }

  function readSheet(sheet) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin sheet: the browser refuses to expose rules. Hand the URL to the server,
      // which has no such restriction.
      if (sheet.href) externalSheets.push(sheet.href);
      return '';
    }
    if (!rules) return '';
    let out = '';
    for (const rule of rules) {
      // Nested @import resolves to its own entry in document.styleSheets, so skip the text.
      if (rule.type === CSSRule.IMPORT_RULE) {
        if (rule.styleSheet) out += readSheet(rule.styleSheet);
        else if (rule.href) externalSheets.push(abs(rule.href));
        continue;
      }
      out += absolutiseCss(rule.cssText, sheet.href) + '\n';
    }
    return out;
  }

  function collectCss(root) {
    let css = '';
    const sheets = root === document ? document.styleSheets : [];
    for (const sheet of sheets) {
      if (sheet.disabled) continue;
      css += readSheet(sheet);
    }
    // Constructed stylesheets (adoptedStyleSheets) never appear in document.styleSheets links.
    for (const sheet of root.adoptedStyleSheets || []) {
      try {
        for (const rule of sheet.cssRules) css += absolutiseCss(rule.cssText, null) + '\n';
      } catch {}
    }
    return css;
  }

  // ---- element fixups ----------------------------------------------------

  // Copy state that lives in the DOM *properties* rather than the markup. Without this a
  // snapshot of a filled-in form renders completely empty.
  function writeBackLiveState(src, el) {
    const tag = src.tagName;

    if (tag === 'INPUT') {
      const type = (src.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (src.checked) el.setAttribute('checked', '');
        else el.removeAttribute('checked');
      } else if (type !== 'file' && type !== 'password') {
        if (src.value) el.setAttribute('value', src.value);
      } else if (type === 'password' && src.value) {
        // Keep the shape of the field without carrying the secret into the artefact.
        el.setAttribute('value', '•'.repeat(src.value.length));
      }
    } else if (tag === 'TEXTAREA') {
      el.textContent = src.value || '';
    } else if (tag === 'OPTION') {
      if (src.selected) el.setAttribute('selected', '');
      else el.removeAttribute('selected');
    } else if (tag === 'DETAILS') {
      if (src.open) el.setAttribute('open', '');
    }

    // Scroll offsets inside panes, tables and virtual lists. Restored by the snapshot runtime.
    if (src.scrollTop > 0 || src.scrollLeft > 0) {
      el.setAttribute('data-demo-scroll', `${Math.round(src.scrollLeft)},${Math.round(src.scrollTop)}`);
    }
  }

  function rewriteUrlAttributes(src, el) {
    const tag = src.tagName;

    if (el.hasAttribute('src') && tag !== 'IFRAME') el.setAttribute('src', track(src.getAttribute('src')));
    if (el.hasAttribute('srcset')) el.setAttribute('srcset', absSrcset(src.getAttribute('srcset')));
    if (el.hasAttribute('poster')) el.setAttribute('poster', track(src.getAttribute('poster')));

    // SVG <use xlink:href="sprite.svg#id"> and <image href>
    if (tag === 'use' || tag === 'image') {
      const href = src.getAttribute('href') || src.getAttribute('xlink:href');
      if (href && !href.startsWith('#')) {
        el.setAttribute('href', track(href));
        el.removeAttribute('xlink:href');
      }
    }

    if (tag === 'LINK') {
      const rel = (src.getAttribute('rel') || '').toLowerCase();
      if (rel.includes('icon')) el.setAttribute('href', track(src.getAttribute('href')));
    }

    // Anchors: make them inert. The player decides what a click means; we never want the
    // snapshot navigating away to the live app.
    if (tag === 'A' && el.hasAttribute('href')) {
      el.setAttribute('data-demo-href', abs(src.getAttribute('href')));
      el.setAttribute('href', 'javascript:void 0');
    }
    if (tag === 'FORM') el.setAttribute('action', 'javascript:void 0');

    // Inline styles and computed backgrounds both hide image URLs.
    const inline = src.getAttribute('style');
    if (inline && inline.includes('url(')) el.setAttribute('style', absolutiseCss(inline, null));

    try {
      const bg = getComputedStyle(src).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) absolutiseCss(bg, null);
    } catch {}
  }

  // ---- the clone ---------------------------------------------------------

  function cloneNode(src, inShadow) {
    const type = src.nodeType;

    if (type === Node.TEXT_NODE) return document.createTextNode(src.nodeValue);
    if (type === Node.COMMENT_NODE) return null; // comments are pure weight
    if (type !== Node.ELEMENT_NODE) return null;

    const tag = src.tagName;
    if (SKIP_TAGS.has(tag)) return null;
    // The recorder's own HUD lives in the page; it must never be part of a captured step.
    if (src.hasAttribute && src.hasAttribute('data-demo-hud')) return null;

    // Stylesheets in the light DOM are already folded into the single inlined blob. Inside a
    // shadow root they are scoped, so they must travel with their template.
    if (!inShadow) {
      if (tag === 'STYLE') return null;
      if (tag === 'LINK') {
        const rel = (src.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('stylesheet') || rel.includes('preload') || rel.includes('prefetch') || rel.includes('modulepreload')) {
          return null;
        }
      }
    }

    // Canvas pixels live in GPU memory and vanish on clone — bake them to an image.
    if (tag === 'CANVAS') {
      const r = src.getBoundingClientRect();
      try {
        const data = src.toDataURL('image/png');
        const img = document.createElement('img');
        img.setAttribute('src', data);
        img.setAttribute('style', `width:${r.width}px;height:${r.height}px;display:inline-block`);
        copyAttributes(src, img, new Set(['src', 'style', 'width', 'height']));
        return img;
      } catch {
        // Tainted canvas: the page drew a cross-origin image into it, so the browser refuses
        // to read the pixels back from script. Leaving a blank div here is what turned charts
        // into empty cards. Mark the region instead — the server can photograph it with the
        // debugger, which is not bound by the same-origin policy.
        const id = `c${++shotSeq}`;
        shotRegions.push({
          id,
          rect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
        });
        const div = document.createElement('div');
        div.setAttribute('data-demo-shot', id);
        div.setAttribute('style', `width:${r.width}px;height:${r.height}px;background-size:100% 100%;background-repeat:no-repeat`);
        return div;
      }
    }

    // Cross-origin iframes cannot be read. Same-origin ones are inlined as srcdoc.
    if (tag === 'IFRAME') {
      const holder = document.createElement('div');
      copyAttributes(src, holder, new Set(['src', 'srcdoc', 'sandbox', 'allow']));
      const r = src.getBoundingClientRect();
      holder.setAttribute('data-demo-iframe', '1');
      try {
        const idoc = src.contentDocument;
        if (idoc && idoc.documentElement) {
          const inner = document.createElement('iframe');
          const innerCss = collectCss(idoc);
          const innerBody = cloneNode(idoc.documentElement, false);
          inner.setAttribute(
            'srcdoc',
            `<!doctype html><html><head><meta charset="utf-8"><style>${innerCss}</style></head>${innerBody ? innerBody.outerHTML : ''}</html>`,
          );
          inner.setAttribute('style', `width:${r.width}px;height:${r.height}px;border:0`);
          return inner;
        }
      } catch {}
      // Unreadable from script: a cross-origin frame, or — as apps that render widgets in
      // sandboxed frames do — one without allow-same-origin, whose document is an opaque
      // origin. A grey box here is what turned dashboard widgets into empty cards, so mark
      // the region and let the server photograph what is actually drawn there.
      const id = `r${++shotSeq}`;
      shotRegions.push({ id, rect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } });
      holder.setAttribute('data-demo-shot', id);
      // background-color, never the `background` shorthand: the shorthand resets
      // background-image, and an inline declaration beats the stylesheet rule that pastes the
      // photograph in — which would leave the grey box exactly as before.
      holder.setAttribute(
        'style',
        `width:${r.width}px;height:${r.height}px;background-color:#f4f4f5;background-size:100% 100%;background-repeat:no-repeat`,
      );
      return holder;
    }

    const el = document.createElementNS(src.namespaceURI, tag.toLowerCase());
    copyAttributes(src, el);
    rewriteUrlAttributes(src, el);
    writeBackLiveState(src, el);

    // Shadow DOM: cloneNode drops it entirely. Re-emit as a declarative shadow root so the
    // snapshot rebuilds the same encapsulated tree with no scripting.
    if (src.shadowRoot) {
      const tpl = document.createElement('template');
      tpl.setAttribute('shadowrootmode', src.shadowRoot.mode || 'open');
      const shadowCss = collectCss(src.shadowRoot);
      if (shadowCss) {
        const st = document.createElement('style');
        st.textContent = shadowCss;
        tpl.content.appendChild(st);
      }
      for (const child of src.shadowRoot.childNodes) {
        const c = cloneNode(child, true);
        if (c) tpl.content.appendChild(c);
      }
      el.appendChild(tpl);
    }

    for (const child of src.childNodes) {
      const c = cloneNode(child, inShadow);
      if (c) el.appendChild(c);
    }

    return el;
  }

  function copyAttributes(src, el, skip) {
    for (const attr of src.attributes || []) {
      if (skip && skip.has(attr.name)) continue;
      // Inline event handlers would run in the snapshot; strip them.
      if (/^on/i.test(attr.name)) continue;
      try {
        el.setAttribute(attr.name, attr.value);
      } catch {}
    }
  }

  // ---- run ---------------------------------------------------------------

  const css = collectCss(document);
  const root = cloneNode(document.documentElement, false);

  // Elements the recorder tagged as interaction targets, with their on-screen geometry, so
  // the editor can offer sensible tooltip placement without re-measuring.
  const targets = {};
  for (const el of document.querySelectorAll('[data-demo-target]')) {
    const r = el.getBoundingClientRect();
    targets[el.getAttribute('data-demo-target')] = {
      rect: { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height },
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
    };
  }

  // Page context the AI uses to draft accurate copy without seeing the raw HTML.
  const context = {
    headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => (h.innerText || '').trim()).filter(Boolean).slice(0, 25),
    landmarks: [...document.querySelectorAll('nav a, [role=tab], aside a')]
      .map((a) => (a.innerText || '').trim())
      .filter(Boolean)
      .slice(0, 40),
    buttons: [...document.querySelectorAll('button, [role=button]')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 30),
  };

  return {
    url: location.href,
    title: document.title,
    htmlAttrs: [...document.documentElement.attributes].map((a) => `${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`).join(' '),
    head: root ? (root.querySelector('head')?.innerHTML ?? '') : '',
    body: root ? (root.querySelector('body')?.outerHTML ?? '') : '',
    css,
    externalSheets: [...new Set(externalSheets)],
    assetUrls: [...assetUrls],
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    viewport: { w: innerWidth, h: innerHeight },
    targets,
    context,
    shotRegions,
  };
}
