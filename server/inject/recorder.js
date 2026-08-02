// Runs INSIDE the captured page, injected via addInitScript so it survives every navigation
// and single-page route change.
//
// Two responsibilities:
//   1. A floating HUD so you always know what is being recorded and can take manual steps.
//   2. Interception of real interactions, so each step captures the screen *as it looked
//      before* you acted on it — which is what a demo step actually is: "here is the screen,
//      click this". The click is then replayed so the app moves on normally.
//
// Self-contained by necessity: Playwright ships the source into the browser.

export function recorderScript() {
  if (window.__demoRecorderInstalled) return;
  window.__demoRecorderInstalled = true;

  // Playwright injects this into every frame, and plenty of apps embed same-origin iframes.
  // Event listeners still belong in subframes so interactions there are recorded, but the HUD
  // is fixed-position and would stack one floating bar per iframe on top of the page.
  const IS_TOP = window.top === window;

  const send = (payload) => {
    try {
      return window.__demoRecord ? window.__demoRecord(payload) : Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
  };

  // Never let a hung server wedge the browser you are driving.
  const withTimeout = (p, ms = 8000) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r({ timedOut: true }), ms))]);

  let targetSeq = 0;
  let busy = false;
  let paused = false;
  let stepCount = 0;
  // The server refuses to record anything until the browser reaches the demo's start URL, so
  // signing in and navigating there never become steps. It reports that state on every
  // exchange; until armed, interaction interception is off entirely — sign-in clicks (and
  // OAuth popups) behave natively. Defaults to true so a server that doesn't report it
  // changes nothing.
  let armed = true;
  let waitUrl = '';
  let armPoll = null;

  function syncArmed(r) {
    if (!r) return;
    if (r.ended) {
      clearInterval(armPoll);
      armPoll = null;
      return;
    }
    if (typeof r.armed !== 'boolean') return;
    if (r.startUrl) waitUrl = r.startUrl;
    if (r.armed !== armed) {
      armed = r.armed;
      renderArmed();
    }
    // Arming often happens without a page load (an SPA route landing on the start page, or the
    // server's settle check passing) — nothing would tell this document about it. While
    // unarmed, keep asking; stop for good the moment recording is armed.
    if (armed) {
      clearInterval(armPoll);
      armPoll = null;
    } else if (!armPoll) {
      armPoll = setInterval(() => send({ type: 'ping' }).then(syncArmed), 800);
    }
  }

  function renderArmed() {
    hud?.shadowRoot?.querySelector('.dot')?.classList.toggle('waiting', !armed);
    if (armed) {
      setStatus('');
    } else {
      let where = waitUrl;
      try {
        where = new URL(waitUrl).pathname;
      } catch {}
      setStatus(`waiting — go to ${where || 'the start page'}`);
    }
  }

  const nextTargetId = () => `t${++targetSeq}`;

  // Tag the element so the snapshot carries a stable anchor. Selector paths break the moment
  // an app re-renders with different class hashes; an attribute we wrote ourselves does not.
  function tagTarget(el) {
    if (!el || el.nodeType !== 1) return null;
    let id = el.getAttribute('data-demo-target');
    if (!id) {
      id = nextTargetId();
      el.setAttribute('data-demo-target', id);
    }
    return id;
  }

  // The accessible name of a form control: what a human would call this field. Distinct from
  // its text content, which for a <select> is every option run together and for a filled input
  // is the value — neither of which names the field.
  // A field's name is its first line. Labels routinely wrap a title *and* a helper sentence
  // ("Schedule now" / "Leave this off to capture the task now and plan it later"), and joining
  // them produces a caption that is neither a name nor a sentence.
  function firstLine(s) {
    for (const line of String(s || '').split('\n')) {
      const t = line.trim();
      if (t) return t.length > 60 ? t.slice(0, 60) : t;
    }
    return '';
  }

  function fieldLabel(el) {
    const byAttr = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (byAttr.trim()) return firstLine(byAttr);
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      for (const id of labelled.split(/\s+/)) {
        const t = firstLine(el.ownerDocument.getElementById(id)?.innerText);
        if (t) return t;
      }
    }
    if (el.id) {
      const t = firstLine(el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText);
      if (t) return t;
    }
    const wrapping = firstLine(el.closest?.('label')?.innerText);
    if (wrapping) return wrapping;
    // Many design systems put the label in a sibling above the control rather than a <label>.
    const prev = firstLine(el.parentElement?.previousElementSibling?.innerText);
    if (prev && prev.length <= 40) return prev;
    return firstLine(el.placeholder || el.name);
  }

  function describe(el) {
    if (!el) return {};
    const tag = el.tagName.toLowerCase();
    const isControl = /^(select|input|textarea)$/.test(tag);
    // A <select>'s innerText is the whole option list; a filled input's value is the data, not
    // the field's name. For controls, prefer the accessible name.
    const text = isControl
      ? fieldLabel(el) || (tag === 'select' ? '' : String(el.value || '').slice(0, 60))
      : (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const control = isControl ? (tag === 'select' ? 'select' : el.type || 'text') : '';
    return {
      tag,
      role: el.getAttribute('role') || '',
      text: text.slice(0, 120),
      label: isControl ? fieldLabel(el).slice(0, 60) : '',
      control,
      // The browser applies a box's new checkedness *before* dispatching click, so this is the
      // state the click is producing — which is exactly what the step copy needs to describe.
      // (Our preventDefault then reverts it, so the captured snapshot still shows the
      // pre-click screen, and the replayed click applies it for real.)
      checkedAfter: /^(checkbox|radio)$/.test(control) ? !!el.checked : undefined,
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
    };
  }

  const INTERACTIVE =
    'button, a, input, select, textarea, summary, label, [onclick], [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], ' +
    '[role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"]';

  // A click lands on the innermost node — the <span> inside the button, the description text
  // inside a clickable card. Highlighting that fragment looks broken in playback; the demo
  // should spotlight the control the user *meant*. Resolve upward: nearest semantic
  // interactive ancestor first, else the outermost contiguous cursor:pointer ancestor
  // (how React apps mark clickable cards), size-capped so a full-screen overlay that happens
  // to have a pointer cursor never swallows the highlight.
  function interactiveFor(el) {
    if (!el || el.nodeType !== 1) return el;
    const semantic = el.closest?.(INTERACTIVE);
    const fits = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width * r.height <= innerWidth * innerHeight * 0.35;
    };
    if (semantic && fits(semantic)) return semantic;

    let best = el;
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let pointer = false;
      try {
        pointer = getComputedStyle(cur).cursor === 'pointer';
      } catch {}
      if (pointer && fits(cur)) best = cur;
      else if (!pointer && best !== el) break; // walked out of the clickable zone
      cur = cur.parentElement;
    }
    return best;
  }

  // ---- HUD ---------------------------------------------------------------

  let hud, countEl, statusEl;

  function buildHud() {
    if (!IS_TOP || hud || !document.body) return;
    // Clear any bar left behind by a previous injection into this same document.
    for (const stale of document.querySelectorAll('[data-demo-hud]')) stale.remove();
    hud = document.createElement('div');
    // Flagged so the serializer drops it — the HUD must never appear in a captured step.
    hud.setAttribute('data-demo-hud', '1');
    hud.attachShadow({ mode: 'open' });
    hud.shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          position: fixed; z-index: 2147483647; bottom: 18px; left: 50%;
          transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px 8px 14px; border-radius: 999px;
          background: #101014; color: #fff;
          font: 500 13px/1.2 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
          box-shadow: 0 8px 30px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08);
          user-select: none;
        }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #ff4d4f; animation: pulse 1.4s infinite; }
        .dot.paused { background: #a1a1aa; animation: none; }
        .dot.waiting { background: #fbbf24; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
        .count { opacity: .75; font-variant-numeric: tabular-nums; }
        button {
          all: unset; cursor: pointer; padding: 6px 12px; border-radius: 999px;
          background: rgba(255,255,255,.1); font-size: 12.5px; font-weight: 600;
        }
        button:hover { background: rgba(255,255,255,.2); }
        button.done { background: #4f46e5; }
        button.done:hover { background: #6366f1; }
        .status { font-size: 12px; opacity: .6; min-width: 0; max-width: 220px;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .busy .dot { background: #fbbf24; }
      </style>
      <div class="bar">
        <span class="dot"></span>
        <span class="count">0 steps</span>
        <span class="status"></span>
        <button data-act="capture">Capture step</button>
        <button data-act="pause">Pause</button>
        <button data-act="undo">Undo</button>
        <button class="done" data-act="done">Finish</button>
      </div>`;
    document.documentElement.appendChild(hud);
    countEl = hud.shadowRoot.querySelector('.count');
    statusEl = hud.shadowRoot.querySelector('.status');

    hud.shadowRoot.addEventListener('click', async (e) => {
      const act = e.target?.getAttribute?.('data-act');
      if (!act) return;
      e.stopPropagation();

      if (act === 'capture') {
        await capture({ reason: 'manual' });
      } else if (act === 'undo') {
        const r = await send({ type: 'undo' });
        if (r && typeof r.stepCount === 'number') setCount(r.stepCount);
      } else if (act === 'done') {
        await send({ type: 'done' });
      } else if (act === 'pause') {
        paused = !paused;
        e.target.textContent = paused ? 'Resume' : 'Pause';
        hud.shadowRoot.querySelector('.dot').classList.toggle('paused', paused);
        setStatus(paused ? 'paused — interact freely' : '');
      }
    });
  }

  const setCount = (n) => {
    stepCount = n;
    if (countEl) countEl.textContent = `${n} step${n === 1 ? '' : 's'}`;
  };
  const setStatus = (s) => {
    if (statusEl) statusEl.textContent = s || '';
  };

  function setBusy(on) {
    busy = on;
    hud?.shadowRoot?.querySelector('.bar')?.classList.toggle('busy', on);
    if (on) setStatus('capturing…');
    else setStatus('');
  }

  // ---- capture -----------------------------------------------------------

  // `meta` carries the interaction kind under `reason` — never `type`, which is reserved for
  // the message envelope the server switches on.
  // Deliberately does NOT refuse while another capture is in flight. The server serialises
  // captures in a queue, and dropping one here would lose real steps — typically the click
  // that immediately follows a form entry, which is usually the most important step of all.
  async function capture(meta) {
    setBusy(true);
    try {
      const res = await withTimeout(send({ ...meta, type: 'capture' }));
      if (res && typeof res.stepCount === 'number') setCount(res.stepCount);
      syncArmed(res);
      return res;
    } finally {
      setBusy(false);
      if (!armed) renderArmed(); // setBusy cleared the status line; put the waiting notice back
    }
  }

  // Intercept the click, snapshot the pre-click screen, then replay the click so the app
  // behaves exactly as it would have. Without the interception we would only ever capture
  // the *result* of an action and never the screen that invited it.
  document.addEventListener(
    'click',
    (ev) => {
      if (paused || !armed) return;
      if (ev.__demoReplay) return;
      if (!ev.isTrusted) return;

      const path = ev.composedPath?.() || [];
      if (path.some((n) => n?.getAttribute?.('data-demo-hud'))) return;

      const el = path[0]?.nodeType === 1 ? path[0] : ev.target;
      if (!el || el.nodeType !== 1) return;

      ev.preventDefault();
      ev.stopImmediatePropagation();

      // Tag and describe the whole control; replay the click on the exact node that was hit.
      const control = interactiveFor(el);
      const targetId = tagTarget(control);
      const info = describe(control);

      // Viewport coordinates of the real click, so playback can land its guide cursor on the
      // exact spot rather than the geometric centre of the element.
      const point = { x: Math.round(ev.clientX), y: Math.round(ev.clientY) };

      capture({ reason: 'click', targetId, target: info, point }).then(() => {
        const replay = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: ev.clientX,
          clientY: ev.clientY,
          button: ev.button,
          ctrlKey: ev.ctrlKey,
          metaKey: ev.metaKey,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
        });
        replay.__demoReplay = true;
        el.dispatchEvent(replay);
      });
    },
    true,
  );

  // Typed input: one step per keystroke would be noise, so capture on commit (blur or Enter),
  // which yields the filled-in screen.
  document.addEventListener(
    'change',
    (ev) => {
      if (paused || !armed || !ev.isTrusted) return;
      const el = ev.target;
      if (!el || el.nodeType !== 1) return;
      if (el.closest?.('[data-demo-hud]')) return;
      // Ticking a box is one interaction that fires both click and change. The click already
      // captured it (with the pre-click screen, which is the useful one), so capturing the
      // change too would put two near-identical steps back to back.
      if (/^(checkbox|radio)$/.test(el.type || '')) return;
      const targetId = tagTarget(el);
      // Only text-like fields carry a replayable value; a checkbox's "on" or a select's option
      // key would just animate as gibberish. Passwords stay blank — the snapshot already shows
      // masking bullets and the real characters must never reach disk.
      const texty =
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && /^(text|email|search|url|tel|number)$/.test(el.type || 'text'));
      capture({ reason: 'input', targetId, target: describe(el), value: texty ? String(el.value ?? '').slice(0, 200) : '' });
    },
    true,
  );

  // Enter inside a field commits without firing change in some frameworks.
  document.addEventListener(
    'keydown',
    (ev) => {
      if (paused || !armed || !ev.isTrusted) return;
      if (ev.key !== 'Enter') return;
      const el = ev.target;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName || '')) return;
      if (el.closest?.('[data-demo-hud]')) return;
      capture({ reason: 'submit', targetId: tagTarget(el), target: describe(el) });
    },
    true,
  );

  // Route changes in single-page apps produce no load event. Patch the history API so a
  // client-side navigation still registers as a new screen.
  function announceNav(kind) {
    // Only the top frame's route changes represent a new screen. A widget iframe rewriting its
    // own history would otherwise trigger a spurious capture.
    if (paused || !IS_TOP) return;
    // Never gated on `armed` — this is how the server notices an SPA route change has
    // finally landed on the start page. The response carries the (possibly new) armed state.
    send({ type: 'navigated', kind, url: location.href }).then(syncArmed);
  }
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(() => announceNav(m), 0);
      return r;
    };
  }
  addEventListener('popstate', () => announceNav('popstate'));
  addEventListener('hashchange', () => announceNav('hashchange'));

  // Keyboard shortcut for a manual step, for when the HUD is in the way.
  addEventListener('keydown', (e) => {
    if (e.key === 'S' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      capture({ reason: 'manual' });
    }
  });

  const boot = () => {
    if (IS_TOP) buildHud(); // subframes record interactions but own no chrome
    // Every frame checks in, so subframes also learn whether recording is armed yet.
    send({ type: 'ready', url: location.href }).then((r) => {
      if (r && typeof r.stepCount === 'number') setCount(r.stepCount);
      syncArmed(r);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Some apps replace document.body wholesale on route change; keep the HUD alive.
  new MutationObserver(() => {
    if (hud && !hud.isConnected && document.documentElement) {
      document.documentElement.appendChild(hud);
    }
  }).observe(document.documentElement, { childList: true, subtree: false });
}
