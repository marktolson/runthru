// Single-script-tag embed for a feature showcase.
//
//   <div id="feature-showcase"></div>
//   <script src="https://your-host/embed.js"
//           data-showcase="https://your-host/showcase.json"
//           data-target="#feature-showcase" defer></script>
//
// Injects its own stylesheets and mounts the widget. Everything it renders is scoped under
// .sc / .dp, so it will not disturb the host page.

(async function () {
  const script = document.currentScript || [...document.querySelectorAll('script[data-showcase]')].pop();
  if (!script) return;

  const showcaseUrl = script.getAttribute('data-showcase');
  if (!showcaseUrl) return console.warn('[showcase] missing data-showcase attribute');

  const base = showcaseUrl.replace(/\/[^/]*$/, '');
  const selector = script.getAttribute('data-target') || '#feature-showcase';

  const mountPoint = () => {
    const el = document.querySelector(selector);
    if (el) return el;
    // No container supplied — drop the widget where the script tag sits.
    const div = document.createElement('div');
    script.parentNode.insertBefore(div, script);
    return div;
  };

  const css = (href) =>
    new Promise((resolve) => {
      if (document.querySelector(`link[href="${href}"]`)) return resolve();
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    });

  try {
    await Promise.all([css(`${base}/player.css`), css(`${base}/showcase.css`)]);
    const [{ FeatureShowcase }, doc] = await Promise.all([
      import(`${base}/showcase.js`),
      fetch(showcaseUrl).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading showcase.json`);
        return r.json();
      }),
    ]);

    const endpoint = script.getAttribute('data-analytics') || '';
    const onEvent = endpoint
      ? (name, payload) => {
          try {
            const body = JSON.stringify({ event: name, at: Date.now(), ...payload });
            if (navigator.sendBeacon) navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
            else fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
          } catch {}
        }
      : () => {};

    new FeatureShowcase(mountPoint(), { doc, base, onEvent }).mount();
  } catch (e) {
    console.error('[showcase] failed to load:', e);
  }
})();
