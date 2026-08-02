// Studio editor.
//
// Every mutation goes through the server's /op endpoint, which runs the same docops functions
// the AI copilot calls. That is deliberate: the UI and the AI cannot drift apart, and undo
// works identically no matter which one made the change.

import { DemoPlayer } from '/player/player.js';
import { api, toast, modal, esc, debounce } from '/studio/util.js';

const slug = new URLSearchParams(location.search).get('demo');
if (!slug) location.href = '/';

let doc = null;
let sel = null; // selected node id
let player = null;
let history = { undo: 0, redo: 0 };
let aiInfo = { configured: false, model: null };
// True while the preview is being rebuilt and walked back to the selected step, so the
// player's own startup navigation is not mistaken for the viewer moving through the demo.
let syncingPreview = false;
const chatLog = [];

// ---------------------------------------------------------------- data

async function load() {
  const res = await api(`/api/demos/${slug}`);
  doc = res.doc;
  history = res.history;
  if (!sel || !doc.nodes.some((n) => n.id === sel)) sel = doc.nodes[0]?.id ?? null;
  renderAll();
}

// Apply a named docops operation. This is the single write path for the whole editor.
//
// `render` says how much of the editor the change actually affects. Re-rendering more than
// necessary is not just wasteful: rebuilding the preview restarts the player on step one, and
// rebuilding the inspector replaces the field being typed into and drops its focus.
//   'all'    — everything, preview player included. For changes to the captured screen or the
//              step list: overlays, duplicate, delete, reorder.
//   'chrome' — everything except the preview, which is updated in place. For annotation edits,
//              where the tooltip changes but the screen behind it does not.
//   'light'  — filmstrip and preview tip only, leaving the inspector alone so a field being
//              typed into keeps its focus and caret.
async function op(name, args, { quiet = false, render = 'all' } = {}) {
  try {
    const res = await api(`/api/demos/${slug}/op`, { method: 'POST', body: { op: name, args } });
    doc = res.doc;
    history = res.history || history;
    if (!quiet && res.summary) toast(res.summary);
    if (render === 'light') renderLight();
    else renderAll({ keepPreview: render === 'chrome' });
    return res;
  } catch (e) {
    toast(e.message, 'bad');
    throw e;
  }
}

const opQuiet = debounce((name, args) => op(name, args, { quiet: true, render: 'light' }), 500);

// ---------------------------------------------------------------- render

function renderAll({ keepPreview = false } = {}) {
  document.getElementById('crumb').innerHTML = `<strong>${esc(doc.name)}</strong>`;
  document.getElementById('stepCount').textContent = doc.nodes.length || '';
  document.getElementById('playBtn').href = `/play/${slug}`;
  document.getElementById('undoBtn').disabled = !history.undo;
  document.getElementById('redoBtn').disabled = !history.redo;
  renderStrip();
  // Rebuilding the player reloads the snapshot and restarts on step one. Only do it when the
  // screen itself changed; an annotation edit just needs the tip repainted where it stands.
  if (keepPreview && player) player.refresh(doc);
  else renderPreview();
  renderStep();
  renderDemo();
}

// What a debounced text save refreshes: the filmstrip title and the history buttons. The
// inspector keeps the user's focus and the preview keeps playing; both catch up on the next
// full render.
function renderLight() {
  document.getElementById('crumb').innerHTML = `<strong>${esc(doc.name)}</strong>`;
  document.getElementById('undoBtn').disabled = !history.undo;
  document.getElementById('redoBtn').disabled = !history.redo;
  renderStrip();
  player?.refresh(doc);
}

function renderStrip() {
  const strip = document.getElementById('strip');
  if (!doc.nodes.length) {
    strip.innerHTML = `<div class="hint" style="padding:8px 4px">No steps yet. Hit <strong>Record</strong> to capture some.</div>`;
    return;
  }
  strip.innerHTML = doc.nodes
    .map(
      (n, i) => `
      <div class="shot ${n.id === sel ? 'shot--on' : ''}" data-node="${n.id}" draggable="true">
        ${n.shot ? `<img src="/demos/${slug}/${n.shot}" alt="" loading="lazy">` : '<div style="aspect-ratio:16/10"></div>'}
        <span class="shot__n">${i + 1}</span>
        <span class="shot__k">${esc(n.annotation?.kind || 'tooltip')}</span>
        <button class="shot__x" data-del="${n.id}" title="Delete step (Undo restores it)">×</button>
        <div class="shot__t">${esc(n.annotation?.title || n.pageTitle || '—')}</div>
      </div>`,
    )
    .join('');
}

function renderPreview() {
  const host = document.getElementById('preview');
  player?.destroy();
  host.innerHTML = '';
  host.className = '';
  if (!doc.nodes.length) {
    host.innerHTML = `<div class="empty"><h2>Nothing recorded yet</h2><p>Click <strong>Record</strong> above. A browser window opens — drive it as you normally would and every interaction becomes a step.</p></div>`;
    return;
  }
  // A fresh player always opens on step one and announces it. That announcement is not the
  // viewer navigating, so it must not move the selection — otherwise rebuilding the preview
  // (which any non-typed edit used to do) threw the user back to step one mid-edit.
  const want = sel;
  syncingPreview = true;

  player = new DemoPlayer(host, {
    demo: doc,
    base: `/demos/${slug}`,
    editing: true,
    // Follow the preview: stepping through the demo there selects the step in the filmstrip
    // and the inspector, so it is always visible which step is on screen.
    onEvent: (type, data) => {
      if (syncingPreview) return;
      if (type !== 'step_view' || !data?.nodeId || data.nodeId === sel) return;
      if (!doc.nodes.some((n) => n.id === data.nodeId)) return;
      sel = data.nodeId;
      renderStrip();
      renderStep();
      document.querySelector('.shot--on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
  player
    .start()
    .then(() => (want ? player.goTo(want, { record: false }) : null))
    .finally(() => {
      syncingPreview = false;
    });
}

// ---------------------------------------------------------------- step pane

function renderStep() {
  const pane = document.getElementById('paneStep');
  const n = doc.nodes.find((x) => x.id === sel);
  if (!n) {
    pane.innerHTML = `<div class="hint">Select a step to edit it.</div>`;
    return;
  }
  const a = n.annotation || {};
  const others = doc.nodes.filter((x) => x.id !== n.id);

  pane.innerHTML = `
    <div class="group">
      <h4>Presentation</h4>
      <div class="seg" id="kindSeg">
        ${['tooltip', 'modal', 'caption', 'hotspot', 'none']
          .map((k) => `<button data-kind="${k}" class="${(a.kind || 'tooltip') === k ? 'on' : ''}">${k}</button>`)
          .join('')}
      </div>
    </div>

    <div class="group">
      <h4>Copy</h4>
      <div class="field withai">
        <label>Headline</label>
        <input class="input" id="fTitle" value="${esc(a.title || '')}" placeholder="Click “New project”">
        <div class="aibtns" data-ai-for="title">${aiChips()}</div>
      </div>
      <div class="field withai">
        <label>Body</label>
        <textarea class="input" id="fBody" placeholder="Explain why this matters.">${esc(a.body || '')}</textarea>
        <div class="aibtns" data-ai-for="body">${aiChips()}</div>
      </div>
      <div class="field">
        <label>Button label</label>
        <input class="input" id="fCta" value="${esc(a.ctaLabel || '')}" placeholder="Next">
      </div>
    </div>

    <div class="group">
      <h4>Target</h4>
      <div class="field">
        <label>Element</label>
        <div class="row">
          <input class="input" id="fTarget" value="${esc(a.target || '')}" placeholder="Not anchored">
          <button class="btn btn--sm" id="pickBtn">Pick</button>
        </div>
        ${n.targetHint?.text ? `<div class="hint" style="margin-top:5px">Recorded: “${esc(n.targetHint.text.slice(0, 60))}”</div>` : ''}
      </div>
      <div class="row">
        <div class="field" style="flex:1">
          <label>Placement</label>
          <select class="input" id="fPlace">
            ${['auto', 'top', 'bottom', 'left', 'right', 'center']
              .map((p) => `<option ${(a.placement || 'auto') === p ? 'selected' : ''}>${p}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      <label class="check"><input type="checkbox" id="fBeacon" ${a.beacon !== false ? 'checked' : ''}> Pulsing beacon on target</label>
    </div>

    <div class="group">
      <h4>Advance</h4>
      <select class="input" id="fAdvance">
        <option value="click-target" ${n.advance?.on === 'click-target' ? 'selected' : ''}>When the target is clicked</option>
        <option value="any-click" ${n.advance?.on === 'any-click' ? 'selected' : ''}>On any click</option>
        <option value="next" ${n.advance?.on === 'next' ? 'selected' : ''}>Only via the Next button</option>
        <option value="timer" ${n.advance?.on === 'timer' ? 'selected' : ''}>Automatically after a delay</option>
      </select>
      ${n.advance?.on === 'timer' ? `<div class="field" style="margin-top:9px"><label>Delay (ms)</label><input class="input" id="fMs" type="number" value="${n.advance?.ms || 3000}"></div>` : ''}
      <!-- The preview deliberately never advances on its own, or editing a step would be a
           moving target. Say so, because a delay that "does nothing" reads as broken. -->
      <div class="hint" style="margin-top:7px">${
        n.advance?.on === 'timer'
          ? 'Auto-advance is switched off in this preview so the step holds still while you edit it — open <strong>Preview</strong> to watch it run.'
          : 'The preview always offers a Next button so you can step through while editing; in the real demo only the rule above applies.'
      }</div>
      <div class="field" style="margin-top:9px">
        <label>Then go to</label>
        <select class="input" id="fNext">
          <option value="">Next step in order</option>
          ${others.map((o, i) => `<option value="${o.id}" ${n.next === o.id ? 'selected' : ''}>${doc.nodes.indexOf(o) + 1}. ${esc((o.annotation?.title || o.pageTitle || o.id).slice(0, 34))}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="group">
      <h4>Branches</h4>
      <div class="hint" style="margin-bottom:8px">Offer a choice and send viewers down different paths.</div>
      <div id="branchList">
        ${(n.branches || [])
          .map(
            (b, i) => `<div class="listrow">
            <input class="input" data-b-label="${i}" value="${esc(b.label)}" placeholder="I run marketing" style="flex:1">
            <select class="input" data-b-next="${i}" style="flex:0 0 88px">
              ${doc.nodes.map((o) => `<option value="${o.id}" ${b.next === o.id ? 'selected' : ''}>${doc.nodes.indexOf(o) + 1}</option>`).join('')}
            </select>
            <button class="x" data-b-del="${i}">×</button>
          </div>`,
          )
          .join('')}
      </div>
      <button class="btn btn--sm" id="addBranch">+ Add choice</button>
    </div>

    <div class="group">
      <h4>Overlays</h4>
      <div class="hint" style="margin-bottom:8px">Blur figures, hide elements or swap text. Applied at playback — the recording is never altered.</div>
      <div>
        ${(n.overlays || [])
          .map(
            (o, i) => `<div class="listrow">
              <span style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:700">${esc(o.type)}</span>
              <span style="flex:1;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.value || o.target)}</span>
              <button class="x" data-o-del="${i}">×</button>
            </div>`,
          )
          .join('')}
      </div>
      <div class="row">
        <button class="btn btn--sm" data-overlay="blur">Blur…</button>
        <button class="btn btn--sm" data-overlay="hide">Hide…</button>
        <button class="btn btn--sm" data-overlay="text">Swap text…</button>
      </div>
      ${n.overlays?.length ? `<button class="btn btn--sm btn--ghost" id="clearOverlays" style="margin-top:6px">Clear all</button>` : ''}
    </div>

    <div class="group">
      <div class="row">
        <button class="btn btn--sm" id="dupStep">Duplicate</button>
        <button class="btn btn--sm btn--danger" id="delStep">Delete step</button>
      </div>
    </div>`;

  wireStep(n);
}

const aiChips = () =>
  ['shorten', 'expand', 'punchy', 'fix']
    .map((a) => `<button class="aichip" data-ai="${a}">${a}</button>`)
    .join('');

function wireStep(n) {
  const pane = document.getElementById('paneStep');
  const $ = (id) => pane.querySelector(id);

  // These all change the guide drawn over the step, never the captured screen underneath, so
  // the preview is updated in place and stays on the step being edited.
  const chrome = { quiet: true, render: 'chrome' };

  pane.querySelector('#kindSeg').onclick = (e) => {
    const k = e.target.dataset.kind;
    if (k) op('set_annotation', { nodeId: n.id, kind: k }, chrome);
  };

  $('#fTitle').oninput = (e) => opQuiet('set_step_copy', { nodeId: n.id, title: e.target.value });
  $('#fBody').oninput = (e) => opQuiet('set_step_copy', { nodeId: n.id, body: e.target.value });
  $('#fCta').oninput = (e) => opQuiet('set_annotation', { nodeId: n.id, ctaLabel: e.target.value });
  $('#fTarget').onchange = (e) => op('set_annotation', { nodeId: n.id, target: e.target.value || null }, chrome);
  $('#fPlace').onchange = (e) => op('set_annotation', { nodeId: n.id, placement: e.target.value }, chrome);
  $('#fBeacon').onchange = (e) => op('set_annotation', { nodeId: n.id, beacon: e.target.checked }, chrome);
  $('#fAdvance').onchange = (e) => op('set_advance', { nodeId: n.id, on: e.target.value }, chrome);
  if ($('#fMs')) $('#fMs').onchange = (e) => op('set_advance', { nodeId: n.id, on: 'timer', ms: Number(e.target.value) }, chrome);
  $('#fNext').onchange = (e) => op('set_next', { nodeId: n.id, next: e.target.value || null }, chrome);

  $('#pickBtn').onclick = () => {
    toast('Click an element in the preview');
    player?.startPick((selector) => {
      if (selector) op('set_annotation', { nodeId: n.id, target: selector }, { render: 'chrome' });
    });
  };

  $('#dupStep').onclick = () => op('duplicate_step', { nodeId: n.id });
  $('#delStep').onclick = async () => {
    if (!confirm('Delete this step and its captured screen?')) return;
    // Land on a neighbour rather than jumping back to step one, the same as the filmstrip's
    // quick delete. This one also removes the snapshot files, so it is not undoable in full.
    const i = doc.nodes.findIndex((x) => x.id === n.id);
    const after = (doc.nodes[i + 1] || doc.nodes[i - 1])?.id ?? null;
    const res = await api(`/api/demos/${slug}/nodes/${n.id}`, { method: 'DELETE' });
    doc = res.doc;
    sel = doc.nodes.some((x) => x.id === after) ? after : (doc.nodes[0]?.id ?? null);
    toast('Step deleted');
    renderAll();
  };

  // branches — buttons inside the tooltip, so the same in-place update applies
  $('#addBranch').onclick = () => {
    const branches = [...(n.branches || []), { label: 'Tell me more', next: doc.nodes[0].id }];
    op('set_branches', { nodeId: n.id, branches }, { render: 'chrome' });
  };
  pane.querySelectorAll('[data-b-del]').forEach((b) => {
    b.onclick = () => {
      const branches = (n.branches || []).filter((_, i) => i !== Number(b.dataset.bDel));
      op('set_branches', { nodeId: n.id, branches }, { render: 'chrome' });
    };
  });
  pane.querySelectorAll('[data-b-label],[data-b-next]').forEach((el) => {
    el.onchange = () => {
      const branches = (n.branches || []).map((b, i) => ({
        label: pane.querySelector(`[data-b-label="${i}"]`)?.value ?? b.label,
        next: pane.querySelector(`[data-b-next="${i}"]`)?.value ?? b.next,
      }));
      op('set_branches', { nodeId: n.id, branches }, chrome);
    };
  });

  // overlays
  pane.querySelectorAll('[data-overlay]').forEach((b) => {
    b.onclick = () => addOverlay(n, b.dataset.overlay);
  });
  pane.querySelectorAll('[data-o-del]').forEach((b) => {
    b.onclick = () => {
      const keep = (n.overlays || []).filter((_, i) => i !== Number(b.dataset.oDel));
      op('clear_overlays', { nodeId: n.id }, { quiet: true }).then(async () => {
        for (const o of keep) await op('add_overlay', { nodeId: n.id, ...o }, { quiet: true });
      });
    };
  });
  if ($('#clearOverlays')) $('#clearOverlays').onclick = () => op('clear_overlays', { nodeId: n.id });

  // inline AI rewrite
  pane.querySelectorAll('[data-ai-for]').forEach((box) => {
    const field = box.dataset.aiFor;
    box.querySelectorAll('[data-ai]').forEach((chip) => {
      chip.onclick = async () => {
        const input = field === 'title' ? $('#fTitle') : $('#fBody');
        if (!input.value.trim()) return toast('Nothing to rewrite yet', 'bad');
        if (!aiInfo.configured) return toast('Connect an API key from the home page first', 'bad');
        box.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          const r = await api('/api/ai/rewrite', {
            method: 'POST',
            body: { text: input.value, action: chip.dataset.ai, context: n.pageTitle || '' },
          });
          input.value = r.text;
          await op('set_step_copy', { nodeId: n.id, [field]: r.text }, { quiet: true, render: 'chrome' });
        } catch (e) {
          toast(e.message, 'bad');
        } finally {
          box.querySelectorAll('button').forEach((b) => (b.disabled = false));
        }
      };
    });
  });
}

function addOverlay(n, type) {
  const finish = (selector, value) => op('add_overlay', { nodeId: n.id, type, target: selector, value });
  if (type === 'text') {
    toast('Click the text you want to replace');
    player?.startPick((selector) => {
      if (!selector) return;
      modal({
        title: 'Replace text',
        body: `<div class="field"><label>New text</label><input class="input" id="ovText" autofocus></div>`,
        confirm: 'Apply',
        onConfirm: (root) => finish(selector, root.querySelector('#ovText').value),
      });
    });
    return;
  }
  toast(`Click the element to ${type}`);
  player?.startPick((selector) => selector && finish(selector, ''));
}

// ---------------------------------------------------------------- demo pane

function renderDemo() {
  const pane = document.getElementById('paneDemo');
  const t = doc.theme || {};
  const s = doc.settings || {};
  const lf = doc.leadForm || {};
  const cta = doc.endCta || {};

  pane.innerHTML = `
    <div class="group">
      <h4>Details</h4>
      <div class="field"><label>Name</label><input class="input" id="dName" value="${esc(doc.name)}"></div>
      <div class="field"><label>Description</label>
        <textarea class="input" id="dDesc" rows="3" placeholder="Create an empty project, add and schedule the first task, then activate it.">${esc(doc.description || '')}</textarea>
        <div class="hint">Doubles as the brief for <strong>↻ Re-record</strong> — edit it, then re-record to shoot the demo again.</div>
      </div>
    </div>

    <div class="group">
      <h4>Branding</h4>
      <div class="row">
        <div class="field" style="flex:0 0 66px"><label>Accent</label><input class="input" type="color" id="dAccent" value="${esc(t.accent || '#5b5bd6')}" style="padding:3px;height:36px"></div>
        <div class="field" style="flex:1"><label>Font</label>
          <select class="input" id="dFont">
            ${['system', 'inter', 'serif', 'mono'].map((f) => `<option ${t.font === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label>Backdrop dimming (${Math.round((t.overlay ?? 0.55) * 100)}%)</label>
        <input type="range" id="dOverlay" min="0" max="0.9" step="0.05" value="${t.overlay ?? 0.55}" style="width:100%">
      </div>
      <label class="check"><input type="checkbox" id="dSpot" ${t.spotlight !== false ? 'checked' : ''}> Spotlight the target</label>
    </div>

    <div class="group">
      <h4>Playback</h4>
      <label class="check"><input type="checkbox" id="sProg" ${s.showProgress !== false ? 'checked' : ''}> Progress bar</label>
      <label class="check"><input type="checkbox" id="sCtrl" ${s.showControls !== false ? 'checked' : ''}> Back / next controls</label>
      <label class="check"><input type="checkbox" id="sCursor" ${s.cursor !== false ? 'checked' : ''}> Guide cursor</label>
      <label class="check"><input type="checkbox" id="sType" ${s.typing !== false ? 'checked' : ''}> Replay typing</label>
      <label class="check"><input type="checkbox" id="sFree" ${s.freeRoam ? 'checked' : ''}> Free roam (click anywhere)</label>
      <label class="check"><input type="checkbox" id="sLoop" ${s.loop ? 'checked' : ''}> Loop at the end</label>
      <label class="check"><input type="checkbox" id="sAuto" ${s.autoplay ? 'checked' : ''}> Autoplay</label>
      ${s.autoplay ? `<div class="field"><label>Seconds per step</label><input class="input" type="number" id="sAutoMs" value="${(s.autoplayMs || 4000) / 1000}" step="0.5" min="1"></div>` : ''}
    </div>

    <div class="group">
      <h4>Variables</h4>
      <div class="hint" style="margin-bottom:8px">Write <code>{{company}}</code> in any copy. Override per viewer with <code>?company=Acme</code>.</div>
      ${(doc.variables || [])
        .map(
          (v, i) => `<div class="listrow">
          <input class="input" data-v-key="${i}" value="${esc(v.key)}" placeholder="company" style="flex:0 0 88px">
          <input class="input" data-v-def="${i}" value="${esc(v.default || '')}" placeholder="default" style="flex:1">
          <button class="x" data-v-del="${i}">×</button>
        </div>`,
        )
        .join('')}
      <button class="btn btn--sm" id="addVar">+ Add variable</button>
    </div>

    <div class="group">
      <h4>Lead capture</h4>
      <label class="check"><input type="checkbox" id="lfOn" ${lf.enabled ? 'checked' : ''}> Ask for details</label>
      ${
        lf.enabled
          ? `<div class="field"><label>When</label>
              <select class="input" id="lfPos">
                <option value="start" ${lf.position === 'start' ? 'selected' : ''}>Before the demo</option>
                <option value="end" ${lf.position === 'end' ? 'selected' : ''}>After the demo</option>
              </select></div>
             <div class="field"><label>Headline</label><input class="input" id="lfHead" value="${esc(lf.headline || '')}"></div>`
          : ''
      }
    </div>

    <div class="group">
      <h4>Closing call to action</h4>
      <label class="check"><input type="checkbox" id="ctaOn" ${cta.enabled ? 'checked' : ''}> Show at the end</label>
      ${
        cta.enabled
          ? `<div class="field"><label>Message</label><input class="input" id="ctaBody" value="${esc(cta.body || '')}"></div>
             <div class="field"><label>Button</label><input class="input" id="ctaLabel" value="${esc(cta.label || '')}"></div>
             <div class="field"><label>Link</label><input class="input" id="ctaHref" value="${esc(cta.href || '')}" placeholder="https://"></div>`
          : ''
      }
    </div>`;

  wireDemo();
}

function wireDemo() {
  const pane = document.getElementById('paneDemo');
  const $ = (id) => pane.querySelector(id);

  $('#dName').oninput = (e) => opQuiet('set_meta', { name: e.target.value });
  $('#dDesc').oninput = (e) => opQuiet('set_meta', { description: e.target.value });
  $('#dAccent').onchange = (e) => op('set_theme', { accent: e.target.value }, { quiet: true });
  $('#dFont').onchange = (e) => op('set_theme', { font: e.target.value }, { quiet: true });
  $('#dOverlay').onchange = (e) => op('set_theme', { overlay: Number(e.target.value) }, { quiet: true });
  $('#dSpot').onchange = (e) => op('set_theme', { spotlight: e.target.checked }, { quiet: true });

  const setting = (id, key, val) => {
    const el = $(id);
    if (el) el.onchange = (e) => op('set_settings', { [key]: val(e.target) }, { quiet: true });
  };
  setting('#sProg', 'showProgress', (t) => t.checked);
  setting('#sCtrl', 'showControls', (t) => t.checked);
  setting('#sCursor', 'cursor', (t) => t.checked);
  setting('#sType', 'typing', (t) => t.checked);
  setting('#sFree', 'freeRoam', (t) => t.checked);
  setting('#sLoop', 'loop', (t) => t.checked);
  setting('#sAuto', 'autoplay', (t) => t.checked);
  setting('#sAutoMs', 'autoplayMs', (t) => Number(t.value) * 1000);

  $('#addVar').onclick = () =>
    op('set_variables', { variables: [...(doc.variables || []), { key: `var${(doc.variables || []).length + 1}`, default: '' }] });
  pane.querySelectorAll('[data-v-del]').forEach((b) => {
    b.onclick = () => op('set_variables', { variables: doc.variables.filter((_, i) => i !== Number(b.dataset.vDel)) });
  });
  pane.querySelectorAll('[data-v-key],[data-v-def]').forEach((el) => {
    el.onchange = () => {
      const variables = doc.variables.map((v, i) => ({
        key: pane.querySelector(`[data-v-key="${i}"]`)?.value ?? v.key,
        default: pane.querySelector(`[data-v-def="${i}"]`)?.value ?? v.default,
      }));
      op('set_variables', { variables }, { quiet: true });
    };
  });

  $('#lfOn').onchange = (e) => op('set_lead_form', { enabled: e.target.checked }, { quiet: true });
  if ($('#lfPos')) $('#lfPos').onchange = (e) => op('set_lead_form', { position: e.target.value }, { quiet: true });
  if ($('#lfHead')) $('#lfHead').oninput = (e) => opQuiet('set_lead_form', { headline: e.target.value });

  $('#ctaOn').onchange = (e) => op('set_end_cta', { enabled: e.target.checked }, { quiet: true });
  for (const [id, key] of [['#ctaBody', 'body'], ['#ctaLabel', 'label'], ['#ctaHref', 'href']]) {
    if ($(id)) $(id).oninput = (e) => opQuiet('set_end_cta', { [key]: e.target.value });
  }
}

// ---------------------------------------------------------------- ai pane

function renderAi() {
  const pane = document.getElementById('paneAi');
  pane.innerHTML = `
    <div class="chat">
      <div class="chat__log" id="chatLog">
        ${
          chatLog.length
            ? ''
            : `<div class="msg msg--sys">${
                aiInfo.configured
                  ? `Connected to ${esc(aiInfo.model)}. Ask for changes in plain language — I'll apply them to the demo.`
                  : 'No API key connected. Use “Connect AI” on the <a href="/">home page</a> to set one up.'
              }</div>`
        }
      </div>
      <div class="chat__form">
        <div class="chat__ideas">
          <button class="aichip" data-idea="draft">Draft the whole story</button>
          <button class="aichip" data-idea="review">Review &amp; polish</button>
          <button class="aichip" data-idea="tighten">Tighten every step</button>
          <button class="aichip" data-idea="cfo">Aim it at a CFO</button>
        </div>
        <textarea class="input" id="chatInput" rows="3" placeholder="e.g. make step 3 shorter and add a branch after the dashboard"></textarea>
        <button class="btn btn--primary" id="chatSend" style="width:100%;margin-top:8px">Send</button>
      </div>
    </div>`;

  drawChat();
  pane.querySelector('#chatSend').onclick = send;
  pane.querySelector('#chatInput').onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  };
  pane.querySelectorAll('[data-idea]').forEach((b) => {
    b.onclick = () => {
      const map = {
        draft: null, // handled specially — uses the vision auto-draft endpoint
        tighten: 'Tighten every step to a single clear sentence. Keep the meaning and the targets.',
        cfo: 'Rewrite the whole demo for a CFO audience: emphasise time saved, cost and risk. Keep it concrete.',
      };
      if (b.dataset.idea === 'draft') return autodraft();
      if (b.dataset.idea === 'review') return reviewTake();
      pane.querySelector('#chatInput').value = map[b.dataset.idea];
      send();
    };
  });
}

function drawChat() {
  const log = document.getElementById('chatLog');
  if (!log || !chatLog.length) return;
  log.innerHTML = chatLog
    .map((m) => {
      if (m.role === 'user') return `<div class="msg msg--user">${esc(m.content)}</div>`;
      // A long job says what it is doing; a short one just thinks.
      if (m.role === 'pending') return `<div class="msg msg--sys thinking">${esc(m.note || 'Thinking')}</div>`;
      return `<div class="msg msg--ai">${esc(m.content || '')}${
        m.applied?.length
          ? `<div class="msg__ops">${m.applied.map((a) => `<div class="msg__op">✓ ${esc(a.summary)}</div>`).join('')}</div>`
          : ''
      }</div>`;
    })
    .join('');
  log.scrollTop = log.scrollHeight;
}

async function send() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!aiInfo.configured) return toast('Connect an API key from the home page first', 'bad');

  chatLog.push({ role: 'user', content: text });
  chatLog.push({ role: 'pending' });
  input.value = '';
  drawChat();

  try {
    const res = await api('/api/ai/chat', {
      method: 'POST',
      body: {
        slug,
        messages: chatLog.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })),
      },
    });
    chatLog.pop();
    chatLog.push({ role: 'assistant', content: res.reply, applied: res.applied });
    if (res.applied?.length) {
      doc = res.doc;
      const r = await api(`/api/demos/${slug}`);
      history = r.history;
      renderAll();
    }
  } catch (e) {
    chatLog.pop();
    chatLog.push({ role: 'assistant', content: `⚠ ${e.message}` });
    toast(e.message, 'bad');
  }
  drawChat();
}

// Watch the take back with the model: cut the steps that went nowhere, and make every step's
// copy match the screen it is actually sitting on.
async function reviewTake() {
  if (!aiInfo.configured) return toast('Connect an API key from the home page first', 'bad');
  if (!doc.nodes.length) return toast('Record some steps first', 'bad');

  modal({
    title: 'Review & polish this take',
    body: `<p>AI looks at all ${doc.nodes.length} steps in order — every screenshot — and removes the ones
        that went nowhere: mis-clicks, error screens, duplicates and abandoned menus. It then rewrites the
        remaining copy so it describes what is genuinely on each screen.</p>
      <div class="field"><label>What should the demo show? (optional)</label>
        <textarea class="input" id="revScenario" rows="2" placeholder="Leave blank to use the description">${esc(doc.description || '')}</textarea></div>
      <p class="hint">It will never cut more than about a third of the demo. Undo restores everything.</p>`,
    confirm: 'Review it',
    onConfirm: async (root, close) => {
      const scenario = root.querySelector('#revScenario').value.trim();
      close();
      chatLog.push({ role: 'pending', note: 'Starting the review…' });
      drawChat();
      try {
        await api('/api/ai/review', { method: 'POST', body: { slug, scenario } });
        // Reviewing every screen takes a while. Report what it is up to, so a long wait reads
        // as work in progress rather than a stall.
        const res = await new Promise((resolve, reject) => {
          const poll = setInterval(async () => {
            try {
              const s = await api('/api/ai/review/status');
              const last = chatLog[chatLog.length - 1];
              if (last?.role === 'pending') {
                last.note = s.total ? `${s.message} (${s.done}/${s.total})` : s.message;
                drawChat();
              }
              if (!s.running) {
                clearInterval(poll);
                if (s.error) reject(new Error(s.error));
                else if (s.result) resolve(s.result);
                else reject(new Error('The review ended without a result.'));
              }
            } catch (e) {
              clearInterval(poll);
              reject(e);
            }
          }, 1200);
        });
        chatLog.pop();
        const applied = [
          ...res.dropped.map((d) => ({ summary: `Removed ${d.nodeId} — ${d.reason}` })),
          ...(res.edited ? [{ summary: `Polished copy on ${res.edited} step${res.edited === 1 ? '' : 's'}` }] : []),
          ...(res.refused ? [{ summary: `Kept ${res.refused} step${res.refused === 1 ? '' : 's'} it wanted to cut — too much of the demo` }] : []),
        ];
        chatLog.push({
          role: 'assistant',
          content: res.summary || `Reviewed the take — ${res.kept} steps remain.`,
          applied: applied.length ? applied : [{ summary: 'Nothing needed changing' }],
        });
        await load();
        toast(res.dropped.length || res.edited ? 'Take reviewed' : 'Nothing needed changing');
      } catch (e) {
        chatLog.pop();
        chatLog.push({ role: 'assistant', content: `⚠ ${e.message}` });
        toast(e.message, 'bad');
      }
    },
  });
}

async function autodraft() {
  if (!aiInfo.configured) return toast('Connect an API key from the home page first', 'bad');
  if (!doc.nodes.length) return toast('Record some steps first', 'bad');

  modal({
    title: 'Draft the story with AI',
    body: `<p>AI reads every captured screen — headings, labels, what you clicked, and a screenshot of each — then writes the whole walkthrough.</p>
      <div class="field"><label>Anything it should know? (optional)</label>
      <textarea class="input" id="guide" placeholder="Aimed at agency owners evaluating us against spreadsheets. Emphasise scheduling."></textarea></div>
      <p class="hint">This replaces the copy on every step. Undo restores it.</p>`,
    confirm: 'Draft it',
    onConfirm: async (root, close) => {
      const guidance = root.querySelector('#guide').value.trim();
      close();
      chatLog.push({ role: 'pending' });
      drawChat();
      try {
        const res = await api('/api/ai/autodraft', { method: 'POST', body: { slug, guidance } });
        chatLog.pop();
        chatLog.push({
          role: 'assistant',
          content: `Drafted “${res.draft.name}” across ${res.draft.steps.length} steps.`,
          applied: [{ summary: 'Wrote copy for the whole demo' }],
        });
        await load();
        toast('Story drafted');
      } catch (e) {
        chatLog.pop();
        chatLog.push({ role: 'assistant', content: `⚠ ${e.message}` });
        toast(e.message, 'bad');
      }
      drawChat();
    },
  });
}

// ---------------------------------------------------------------- chrome

document.querySelector('.insp__tabs').onclick = (e) => {
  const b = e.target.closest('[data-pane]');
  if (!b) return;
  document.querySelectorAll('.insp__tab').forEach((t) => t.classList.toggle('insp__tab--on', t === b));
  for (const p of ['step', 'demo', 'ai']) {
    document.getElementById('pane' + p[0].toUpperCase() + p.slice(1)).hidden = p !== b.dataset.pane;
  }
  if (b.dataset.pane === 'ai') renderAi();
};

// filmstrip: select + drag to reorder + quick delete
const strip = document.getElementById('strip');

// No confirm: this goes through the op history, so the toolbar Undo brings the step straight
// back (the captured files stay on disk — only the dedicated delete endpoint removes those).
async function deleteStep(id) {
  if (sel === id) {
    const i = doc.nodes.findIndex((n) => n.id === id);
    sel = (doc.nodes[i + 1] || doc.nodes[i - 1])?.id ?? null;
  }
  await op('delete_step', { nodeId: id }, { quiet: true });
  toast('Step deleted — Undo restores it');
}

strip.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) return void deleteStep(del.dataset.del);
  const s = e.target.closest('[data-node]');
  if (!s) return;
  sel = s.dataset.node;
  renderStrip();
  renderStep();
  player?.goTo(sel, { record: false });
});

// Delete/Backspace removes the selected step — but only when focus is parked somewhere inert
// (the page body or the filmstrip itself). A whitelist, not a "not typing" blacklist: focus
// can be silently lost mid-edit (a re-render swapping the field out from under the caret, a
// click into the preview iframe), and a backspace meant for text must never cost a step.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (!sel || !doc?.nodes.some((n) => n.id === sel)) return;
  const t = document.activeElement;
  if (t && t !== document.body && !strip.contains(t)) return;
  e.preventDefault();
  deleteStep(sel);
});

let dragId = null;
strip.addEventListener('dragstart', (e) => {
  const s = e.target.closest('[data-node]');
  if (!s) return;
  dragId = s.dataset.node;
  s.classList.add('shot--drag');
  e.dataTransfer.effectAllowed = 'move';
});
strip.addEventListener('dragend', (e) => e.target.closest('[data-node]')?.classList.remove('shot--drag'));
strip.addEventListener('dragover', (e) => e.preventDefault());
strip.addEventListener('drop', (e) => {
  e.preventDefault();
  const over = e.target.closest('[data-node]');
  if (!over || !dragId || over.dataset.node === dragId) return;
  const order = doc.nodes.map((n) => n.id).filter((id) => id !== dragId);
  order.splice(order.indexOf(over.dataset.node), 0, dragId);
  dragId = null;
  op('reorder_steps', { order });
});

document.getElementById('undoBtn').onclick = async () => {
  try {
    const r = await api(`/api/demos/${slug}/undo`, { method: 'POST' });
    doc = r.doc;
    history = r.history;
    if (!doc.nodes.some((n) => n.id === sel)) sel = doc.nodes[0]?.id ?? null;
    renderAll();
    toast('Undone');
  } catch (e) {
    toast(e.message, 'bad');
  }
};
document.getElementById('redoBtn').onclick = async () => {
  try {
    const r = await api(`/api/demos/${slug}/redo`, { method: 'POST' });
    doc = r.doc;
    history = r.history;
    renderAll();
    toast('Redone');
  } catch (e) {
    toast(e.message, 'bad');
  }
};

addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    e.preventDefault();
    document.getElementById(e.shiftKey ? 'redoBtn' : 'undoBtn').click();
  }
});

document.getElementById('prepBtn').onclick = () => startPrep();
document.getElementById('recordBtn').onclick = () => startRecording();
document.getElementById('aiRecordBtn').onclick = () => startAiRecording();
document.getElementById('reRecordBtn').onclick = () => startReRecording();

// Change the description, press this, and the whole demo is shot again from scratch. The
// description *is* the brief, so it is editable right here and saved with the run.
async function startReRecording() {
  const known = await api(`/api/capture/remembered/${encodeURIComponent(slug)}`).catch(() => null);
  const signedIn = known?.hasPassword;

  modal({
    title: 'Re-record this demo',
    body: `<p>AI runs the whole demo again from the description below and replaces all
        ${doc.nodes.length} step${doc.nodes.length === 1 ? '' : 's'}. <strong>Undo brings the old take back.</strong></p>
      <div class="field"><label>What the demo should show</label>
        <textarea class="input" id="rrScenario" rows="4" placeholder="Create an empty project, add and schedule the first task, then activate it.">${esc(doc.description || '')}</textarea>
        <div class="hint">This is the demo's description — editing it here updates it.</div></div>
      <div class="field"><label>Docs URL <span class="hint">(optional)</span></label>
        <input class="input" id="rrDocs" value="${esc(known?.docsUrl || '')}" placeholder="https://docs.example.com/getting-started"></div>
      ${
        signedIn
          ? `<p class="hint">Signing in with the details you gave earlier${known.email ? ` (${esc(known.email)})` : ''}. The recording browser usually stays logged in anyway.</p>`
          : `<div class="row">
               <div class="field" style="flex:1"><label>Sign-in email</label><input class="input" id="rrEmail" value="${esc(known?.email || '')}" autocomplete="off"></div>
               <div class="field" style="flex:1"><label>Password</label><input class="input" id="rrPass" type="password" autocomplete="new-password"></div>
             </div>
             <p class="hint">Leave blank if the recording browser is still signed in. Credentials are never saved to disk.</p>`
      }`,
    confirm: 'Re-record',
    onConfirm: async (root, close) => {
      const scenario = root.querySelector('#rrScenario').value.trim();
      if (!scenario) throw new Error('Describe what the demo should show');
      await api('/api/capture/rerecord', {
        method: 'POST',
        body: {
          slug,
          scenario,
          docsUrl: root.querySelector('#rrDocs').value.trim(),
          email: root.querySelector('#rrEmail')?.value.trim() || '',
          password: root.querySelector('#rrPass')?.value || '',
        },
      });
      close();
      await load();
      watchRecording();
    },
  });
}

function startAiRecording() {
  modal({
    title: 'Let AI record the tutorial',
    body: `<p>AI opens the browser, signs in with the credentials you provide, follows your scenario using
        realistic data, and every action it takes becomes a step — then it drafts the copy. Watch it work;
        hit Finish any time to stop it.</p>
      <div class="field"><label>Scenario to demonstrate</label>
        <textarea class="input" id="aiScenario" rows="3" placeholder="Create a new project for a beverage client, add two tasks with due dates, and assign one to a teammate.">${esc(doc.description || '')}</textarea>
        <div class="hint">Saved as the demo's description, so <strong>↻ Re-record</strong> can reuse it.</div></div>
      <div class="field"><label>Docs URL <span class="hint">(optional — AI reads it to follow the intended flow)</span></label>
        <input class="input" id="aiDocs" placeholder="https://docs.example.com/getting-started"></div>
      <div class="row">
        <div class="field" style="flex:1"><label>Sign-in email</label><input class="input" id="aiEmail" autocomplete="off"></div>
        <div class="field" style="flex:1"><label>Password</label><input class="input" id="aiPass" type="password" autocomplete="new-password"></div>
      </div>
      <p class="hint">Credentials are used for this run only — they are never saved, and the sign-in screens are never recorded.</p>`,
    confirm: 'Start AI recording',
    onConfirm: async (root, close) => {
      const scenario = root.querySelector('#aiScenario').value.trim();
      // Throwing keeps the modal open with everything typed so far; returning would close it.
      if (!scenario) throw new Error('Describe the scenario first');
      await api('/api/capture/auto', {
        method: 'POST',
        body: {
          slug,
          scenario,
          docsUrl: root.querySelector('#aiDocs').value.trim(),
          email: root.querySelector('#aiEmail').value.trim(),
          password: root.querySelector('#aiPass').value,
        },
      });
      close();
      watchRecording();
    },
  });
}

// Open the recording browser with nothing attached, so the app can be signed into and set up
// before a take. Same profile as the recording, so everything done here carries over.
function startPrep() {
  modal({
    title: 'Prep the app',
    body: `<p>Opens the same browser the recording uses, but records nothing. Sign in, create the data you
        need, dismiss any first-run tour — then hit <strong>Record</strong> and start the take from a clean, ready screen.</p>
      <div class="field"><label>Open at</label><input class="input" id="pUrl" value="${esc(doc.startUrl || '')}" placeholder="https://app.example.com"></div>
      <p class="hint">The browser profile is shared with recording, so anything you set up here is still there when you record.</p>`,
    confirm: 'Open browser',
    onConfirm: async (root, close) => {
      const url = root.querySelector('#pUrl').value.trim();
      await api('/api/capture/prep', { method: 'POST', body: { slug, url } });
      close();
      watchPrep();
    },
  });
}

// Sit alongside the prep browser: report that it is open, and offer to close it. Closing the
// window directly works too — the poll notices and clears the banner.
function watchPrep() {
  const banner = document.createElement('div');
  banner.className = 'toast';
  banner.style.cssText = 'display:flex;gap:12px;align-items:center';
  banner.innerHTML = `<span style="color:var(--accent)">⚑</span>
    <span>Prep mode — nothing is being recorded</span>
    <button class="btn btn--sm" id="prepRec">Record now</button>
    <button class="btn btn--sm" id="prepDone">Close</button>`;
  document.body.appendChild(banner);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    banner.remove();
  };

  banner.querySelector('#prepDone').onclick = async () => {
    await api('/api/capture/prep/stop', { method: 'POST' }).catch(() => {});
    finish();
  };
  // Starting a recording hands the profile over server-side, so no need to close it here.
  banner.querySelector('#prepRec').onclick = () => {
    finish();
    startRecording();
  };

  const timer = setInterval(async () => {
    const s = await api('/api/capture/prep').catch(() => null);
    if (s && !s.open) finish();
  }, 2500);
}

function startRecording() {
  modal({
    title: 'Record steps',
    body: `<p>A browser window opens. Drive it exactly as you would normally — every click, entry and page change becomes a step. Use the bar at the bottom to take a manual step or finish.</p>
      <div class="field"><label>Start URL</label><input class="input" id="rUrl" value="${esc(doc.startUrl || '')}" placeholder="https://app.example.com"></div>
      <div class="row">
        <div class="field" style="flex:1"><label>Width</label><input class="input" id="rW" type="number" value="1440"></div>
        <div class="field" style="flex:1"><label>Height</label><input class="input" id="rH" type="number" value="900"></div>
      </div>
      <p class="hint">You stay logged in between sessions — the browser profile is kept. Steps are appended to what you already have.</p>`,
    confirm: 'Open browser',
    onConfirm: async (root, close) => {
      const url = root.querySelector('#rUrl').value.trim();
      const viewport = { width: Number(root.querySelector('#rW').value) || 1440, height: Number(root.querySelector('#rH').value) || 900 };
      await api('/api/capture/start', { method: 'POST', body: { slug, url, viewport } });
      close();
      watchRecording();
    },
  });
}

function watchRecording() {
  const banner = document.createElement('div');
  banner.className = 'toast';
  banner.style.cssText = 'display:flex;gap:12px;align-items:center';
  banner.innerHTML = `<span style="color:var(--bad)">●</span><span id="recTxt">Recording — drive the browser window</span>
    <button class="btn btn--sm" id="recStop">Finish</button>`;
  document.body.appendChild(banner);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await api('/api/capture/stop', { method: 'POST' }).catch(() => {});
    await load();

    // The server starts the polish when the session ends — for hand-driven and AI recordings
    // alike — so that it happens even if this tab was reloaded or the recording was finished
    // from the browser's own bar. Here we only follow along.
    if (!doc.nodes.length || !aiInfo.configured) return banner.remove();
    try {
      await watchPolish(banner);
    } catch (e) {
      toast(e.message, 'bad');
    }
    banner.remove();
    await load();
  };
  banner.querySelector('#recStop').onclick = stop;

  const timer = setInterval(async () => {
    try {
      const s = await api('/api/capture/status');
      const lastNote = s.log?.length ? s.log[s.log.length - 1].msg : '';
      banner.querySelector('#recTxt').textContent =
        s.status !== 'recording'
          ? 'Finishing…'
          : s.mode === 'auto'
            ? `${lastNote || 'AI is driving…'} (${s.stepCount} step${s.stepCount === 1 ? '' : 's'})`
            : s.armed === false
              ? 'Waiting — sign in and go to the start page; nothing is recorded until then'
              : `Recording — ${s.stepCount} step${s.stepCount === 1 ? '' : 's'} captured`;
      if (s.status !== 'recording' && s.status !== 'starting') stop();
      else await load();
    } catch {}
  }, 2500);
}

// Follow the shared polish job to completion, narrating it in the recording banner. Waits a
// moment first, because an AI run starts its pass server-side and the job may not have flipped
// to running by the time the browser closes.
async function watchPolish(banner) {
  const txt = banner.querySelector('#recTxt');
  const stopBtn = banner.querySelector('#recStop');
  if (stopBtn) stopBtn.style.display = 'none';
  txt.textContent = 'Reviewing and polishing the recording…';

  const started = Date.now();
  let seenRunning = false;
  while (Date.now() - started < 15 * 60 * 1000) {
    const s = await api('/api/ai/review/status').catch(() => null);
    if (s?.running) {
      seenRunning = true;
      txt.textContent = s.total ? `${s.message} (${s.done}/${s.total})` : s.message || 'Polishing…';
    } else if (seenRunning || Date.now() - started > 8000) {
      // Finished, or never started at all.
      if (s?.error) toast(`Polish failed: ${s.error}`, 'bad');
      else if (s?.result) {
        const r = s.result;
        const bits = [];
        if (r.dropped?.length) bits.push(`removed ${r.dropped.length} step${r.dropped.length === 1 ? '' : 's'}`);
        if (r.edited) bits.push(`polished ${r.edited}`);
        toast(bits.length ? `Reviewed — ${bits.join(', ')}. Undo restores it.` : 'Reviewed — nothing needed changing');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function offerDraft() {
  modal({
    title: 'Draft the story with AI?',
    body: `<p>You captured ${doc.nodes.length} steps. AI can read every screen and write the whole walkthrough for you — then you refine it.</p>`,
    confirm: 'Draft it',
    cancel: 'I\'ll write it myself',
    onConfirm: (root, close) => {
      close();
      document.querySelector('[data-pane="ai"]').click();
      autodraft();
    },
  });
}

document.getElementById('exportBtn').onclick = () => {
  modal({
    title: 'Export a static bundle',
    body: `<p>Writes a self-contained folder with no backend — player, snapshots and assets. Host it anywhere.</p>
      <div class="field"><label>Public URL (optional, for the embed snippet)</label>
      <input class="input" id="xUrl" placeholder="https://demos.yoursite.com/${esc(slug)}/"></div>`,
    confirm: 'Export',
    onConfirm: async (root, close) => {
      const r = await api(`/api/export/${slug}`, { method: 'POST', body: { publicUrl: root.querySelector('#xUrl').value.trim() } });
      close();
      modal({
        title: 'Exported',
        body: `<p>${r.steps} steps · ${(r.bytes / 1024 / 1024).toFixed(1)} MB
            ${r.zipBytes ? `· zipped to ${(r.zipBytes / 1024 / 1024).toFixed(1)} MB` : ''}</p>
          ${
            r.zipUrl
              ? `<p><a class="btn btn--primary" href="${esc(r.zipUrl)}" download style="display:inline-block;text-decoration:none">⤓ Download ${esc(r.fileName || slug)}.zip</a></p>`
              : ''
          }
          <div class="field"><label>Written to</label><input class="input" value="${esc(r.dir)}" readonly onclick="this.select()"></div>
          <p class="hint">Preview it with <code>npm run serve-export -- ${esc(slug)}</code>, then open <code>http://localhost:4500</code>. It must be served over http — opening index.html from disk will not work.</p>`,
        confirm: 'Done',
        cancel: 'Close',
      });
    },
  });
};

// ---------------------------------------------------------------- boot

api('/api/ai/status')
  .then((s) => {
    aiInfo = s;
  })
  .catch(() => {});

await load();

const params = new URLSearchParams(location.search);
if (params.get('record') === '1') startRecording();
// An AI recording started on the library page: attach to the run already in flight rather
// than starting anything, so its steps appear here as they are captured.
else if (params.get('watch') === '1') watchRecording();
