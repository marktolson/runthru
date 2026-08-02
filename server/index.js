// Runthru server: REST API, static hosting for the studio and player, and the local
// play page. Everything runs on your machine; nothing is uploaded anywhere.

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ROOT,
  DEMOS_DIR,
  DIST_DIR,
  demoDir,
  listDemos,
  readDemo,
  writeDemo,
  createDemo,
  deleteDemo,
  undoDemo,
  redoDemo,
  clearRedo,
  historyDepth,
  withDemoLock,
} from './store.js';
import { applyOp, OPS } from './docops.js';
import { startCapture, captureStatus, stopCapture, startPrep, prepStatus, stopPrep } from './capture.js';
import { startAutopilot, rememberedRun } from './autopilot.js';
import { chat, autoDraft, rewrite, AI_ACTIONS } from './ai.js';
import { aiStatus, hasKey, resetModelCache, resolveModel, verifyKey, PROVIDERS } from './llm.js';
import { polishDemo, polishJob } from './polish.js';
import { exportDemo } from './export.js';
import { listShowcases, readShowcase, createShowcase, saveShowcase, deleteShowcase, exportShowcase } from './showcase.js';

const app = express();
const PORT = Number(process.env.PORT || 4400);

app.use(express.json({ limit: '25mb' }));

// Snapshots must be same-origin with the player so it can measure targets inside the iframe.
app.use('/demos', express.static(DEMOS_DIR, { dotfiles: 'ignore' }));
app.use('/player', express.static(path.join(ROOT, 'player')));
app.use('/studio', express.static(path.join(ROOT, 'studio')));
app.use('/dist', express.static(DIST_DIR));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

// ---------------------------------------------------------------- demos

app.get('/api/demos', wrap(async (req, res) => res.json(await listDemos())));

app.post('/api/demos', wrap(async (req, res) => {
  const { name, startUrl, slug } = req.body || {};
  if (!name?.trim()) throw new Error('A demo needs a name.');
  res.json(await createDemo({ name: name.trim(), startUrl: (startUrl || '').trim(), slug }));
}));

app.get('/api/demos/:slug', wrap(async (req, res) => {
  const doc = await readDemo(req.params.slug);
  res.json({ doc, history: await historyDepth(req.params.slug) });
}));

app.put('/api/demos/:slug', wrap(async (req, res) => {
  const out = await withDemoLock(req.params.slug, async () => {
    await clearRedo(req.params.slug);
    const doc = await writeDemo(req.params.slug, req.body.doc, { history: true });
    return { doc, history: await historyDepth(req.params.slug) };
  });
  res.json(out);
}));

app.delete('/api/demos/:slug', wrap(async (req, res) => {
  await deleteDemo(req.params.slug);
  res.json({ ok: true });
}));

// Single mutation surface — the editor sends the same ops the AI calls.
app.post('/api/demos/:slug/op', wrap(async (req, res) => {
  const { op, args } = req.body || {};
  const out = await withDemoLock(req.params.slug, async () => {
    const current = await readDemo(req.params.slug);
    const applied = applyOp(current, op, args || {});
    if (applied.readonly) return { result: applied.result };
    await clearRedo(req.params.slug);
    const doc = await writeDemo(req.params.slug, applied.doc, { history: true });
    return { doc, summary: applied.summary, history: await historyDepth(req.params.slug) };
  });
  res.json(out);
}));

app.get('/api/ops', (req, res) => {
  res.json(
    Object.entries(OPS).map(([name, op]) => ({
      name,
      description: op.description,
      readonly: !!op.readonly,
      params: op.params,
    })),
  );
});

app.post('/api/demos/:slug/undo', wrap(async (req, res) => {
  const doc = await withDemoLock(req.params.slug, () => undoDemo(req.params.slug));
  if (!doc) throw new Error('Nothing left to undo.');
  res.json({ doc, history: await historyDepth(req.params.slug) });
}));

app.post('/api/demos/:slug/redo', wrap(async (req, res) => {
  const doc = await withDemoLock(req.params.slug, () => redoDemo(req.params.slug));
  if (!doc) throw new Error('Nothing to redo.');
  res.json({ doc, history: await historyDepth(req.params.slug) });
}));

// Delete a step's files along with the node.
app.delete('/api/demos/:slug/nodes/:nodeId', wrap(async (req, res) => {
  const { slug, nodeId } = req.params;
  const out = await withDemoLock(slug, async () => {
    const current = await readDemo(slug);
    const node = current.nodes.find((n) => n.id === nodeId);
    const applied = applyOp(current, 'delete_step', { nodeId });
    await clearRedo(slug);
    const doc = await writeDemo(slug, applied.doc, { history: true });
    if (node) {
      const dir = demoDir(slug);
      for (const f of [node.snapshot, node.shot]) {
        if (f) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
      }
    }
    return { doc, summary: applied.summary };
  });
  res.json(out);
}));

// ---------------------------------------------------------------- capture

app.post('/api/capture/start', wrap(async (req, res) => {
  const { slug, url, viewport } = req.body || {};
  if (!slug) throw new Error('Which demo should this recording go into?');
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Enter a full URL starting with http:// or https://');
  res.json(await startCapture({ slug, url, viewport }));
}));

app.get('/api/capture/status', (req, res) => res.json(captureStatus()));
app.post('/api/capture/stop', wrap(async (req, res) => res.json(await stopCapture())));

// Prep browser: the recording profile opened with nothing attached, so the app can be put
// into the right state before a take without any of it becoming steps.
app.post('/api/capture/prep', wrap(async (req, res) => {
  const { slug, url, viewport } = req.body || {};
  if (!slug) throw new Error('Which demo should this prep session use?');
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Enter a full URL starting with http:// or https://');
  res.json(await startPrep({ slug, url, viewport }));
}));

app.get('/api/capture/prep', (req, res) => res.json(prepStatus()));
app.post('/api/capture/prep/stop', wrap(async (req, res) => res.json(await stopPrep())));

// AI autopilot: the model drives the recording browser through a scenario. Credentials are
// held in memory for the run only — never persisted, never logged.
app.post('/api/capture/auto', wrap(async (req, res) => {
  const { slug, name, startUrl, scenario, docsUrl, email, password, maxActions } = req.body || {};
  if (!scenario?.trim()) throw new Error('Describe the scenario the AI should demonstrate.');

  // No demo yet? Make one. Starting from a scenario alone is the whole point of AI recording,
  // so requiring the user to create and name a demo first is ceremony. The provisional name is
  // replaced by the AI's own title when it drafts the story at the end.
  let target = slug;
  if (!target) {
    if (!/^https?:\/\//i.test(startUrl || '')) throw new Error('Enter a full start URL starting with http:// or https://');
    const doc = await createDemo({ name: (name || '').trim() || provisionalName(scenario), startUrl: startUrl.trim() });
    target = doc.slug;
  }

  res.json(await startAutopilot({
    slug: target,
    scenario: scenario.trim(),
    docsUrl: (docsUrl || '').trim() || null,
    credentials: { email: (email || '').trim(), password: password || '' },
    maxActions: Number(maxActions) || undefined,
  }));
}));

// Throw the recording away and have the AI shoot it again from the demo's description.
// The old steps go through the history system rather than being deleted, so one Undo brings
// the previous take back — and snapshot files are left on disk for exactly that reason
// (the monotonic step counter means a new take never overwrites them).
app.post('/api/capture/rerecord', wrap(async (req, res) => {
  const { slug, scenario, docsUrl, email, password, maxActions } = req.body || {};
  if (!slug) throw new Error('Which demo should be re-recorded?');
  const doc = await readDemo(slug);

  const brief = (scenario ?? doc.description ?? '').trim();
  if (!brief) throw new Error('Add a description first — that is what the AI re-records from.');
  if (!doc.startUrl) throw new Error('This demo has no start URL to record from.');

  // Editing the brief here is editing the demo's description; they are the same thing.
  doc.description = brief;
  doc.nodes = [];
  doc.settings ||= {};
  doc.settings.startNodeId = null;
  await clearRedo(slug);
  await writeDemo(slug, doc, { history: true });

  res.json(await startAutopilot({
    slug,
    scenario: brief,
    docsUrl: docsUrl?.trim() || undefined,
    credentials: { email: (email || '').trim(), password: password || '' },
    maxActions: Number(maxActions) || undefined,
  }));
}));

// What the last AI run for this demo used, so the re-record dialog can say whether it still
// has a sign-in and avoid asking again. Never returns the password itself.
app.get('/api/capture/remembered/:slug', (req, res) => res.json(rememberedRun(req.params.slug) || { docsUrl: '', email: '', hasPassword: false }));

// A readable placeholder title from the scenario's first clause, until the AI writes the real
// one when it drafts the story.
function provisionalName(scenario) {
  const first = String(scenario).split(/[.\n]/)[0].trim().replace(/\s+/g, ' ');
  const short = first.length > 60 ? `${first.slice(0, 57)}…` : first;
  return short.charAt(0).toUpperCase() + short.slice(1) || 'AI recording';
}

// ---------------------------------------------------------------- setup

// First-run onboarding: the studio asks for an API key in the UI, works out from its prefix
// whether it is an OpenAI or an Anthropic key, verifies it against that provider here, and
// stores it in .env. The key never reaches any browser page — this is the one endpoint that
// ever sees it, and it lives on localhost.
app.post('/api/setup/key', wrap(async (req, res) => {
  const k = String(req.body?.key || '').trim();
  if (!k) throw new Error('Paste your API key first.');
  if (k.length < 20) throw new Error('That key looks too short — make sure it was copied in full.');

  const provider = await verifyKey(k);

  await writeEnvValue(PROVIDERS[provider].keyEnv, k);
  process.env[PROVIDERS[provider].keyEnv] = k;
  // Pin the provider too, so connecting a second key switches to it rather than leaving the
  // studio quietly talking to whichever one it found first.
  await writeEnvValue('AI_PROVIDER', provider);
  process.env.AI_PROVIDER = provider;
  resetModelCache();
  await resolveModel(true);
  res.json(await aiStatus());
}));

// Set a value in .env, creating the file (from .env.example if present) when it doesn't exist
// yet. Everything else in the file is left untouched.
async function writeEnvValue(name, value) {
  const envPath = path.join(ROOT, '.env');
  let text = await fs.readFile(envPath, 'utf8').catch(() => null);
  if (text === null) text = await fs.readFile(path.join(ROOT, '.env.example'), 'utf8').catch(() => '');
  const line = `${name}=${value}`;
  const re = new RegExp(`^#?\\s*${name}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  if (!text.endsWith('\n')) text += '\n';
  await fs.writeFile(envPath, text, 'utf8');
}

// ---------------------------------------------------------------- ai

app.get('/api/ai/status', wrap(async (req, res) => res.json({ ...(await aiStatus()), actions: AI_ACTIONS })));

app.post('/api/ai/chat', wrap(async (req, res) => {
  const { slug, messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) throw new Error('No message to send.');
  res.json(await chat({ slug, messages }));
}));

app.post('/api/ai/autodraft', wrap(async (req, res) => {
  const { slug, guidance } = req.body || {};
  res.json(await autoDraft({ slug, guidance }));
}));

// Watch the take back: drop the steps that went nowhere and make the copy match the screens.
// Reviewing twenty-odd screens takes a while, so it runs as a job the studio can watch rather
// than one long silent request that is indistinguishable from a hang.
app.post('/api/ai/review', wrap(async (req, res) => {
  const { slug, scenario, draft } = req.body || {};
  if (!slug) throw new Error('Which demo should be reviewed?');
  // Fire and forget: the studio watches the shared job for progress.
  polishDemo({ slug, scenario, draft: !!draft }).catch(() => {});
  res.json({ started: true, slug });
}));

app.get('/api/ai/review/status', (req, res) => res.json(polishJob));

app.post('/api/ai/rewrite', wrap(async (req, res) => res.json(await rewrite(req.body || {}))));

// ---------------------------------------------------------------- showcase

app.get('/api/showcases', wrap(async (req, res) => res.json(await listShowcases())));
app.post('/api/showcases', wrap(async (req, res) => res.json(await createShowcase(req.body || {}))));
app.get('/api/showcases/:slug', wrap(async (req, res) => res.json({ doc: await readShowcase(req.params.slug) })));
app.put('/api/showcases/:slug', wrap(async (req, res) => res.json({ doc: await saveShowcase(req.params.slug, req.body.doc) })));
app.delete('/api/showcases/:slug', wrap(async (req, res) => {
  await deleteShowcase(req.params.slug);
  res.json({ ok: true });
}));
app.post('/api/showcases/:slug/export', wrap(async (req, res) => res.json(await exportShowcase(req.params.slug, req.body || {}))));

// ---------------------------------------------------------------- export

app.post('/api/export/:slug', wrap(async (req, res) => res.json(await exportDemo(req.params.slug, req.body || {}))));

// ---------------------------------------------------------------- analytics

// Local collection so the studio can show a funnel without any external service.
app.post('/api/analytics', wrap(async (req, res) => {
  const { slug } = req.body || {};
  if (slug) {
    const file = path.join(demoDir(slug), 'analytics.jsonl');
    await fs.appendFile(file, JSON.stringify({ ...req.body, at: Date.now() }) + '\n', 'utf8').catch(() => {});
  }
  res.json({ ok: true });
}));

app.get('/api/analytics/:slug', wrap(async (req, res) => {
  const file = path.join(demoDir(req.params.slug), 'analytics.jsonl');
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  const events = raw.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const byStep = {};
  let views = 0;
  let completes = 0;
  for (const e of events) {
    if (e.event === 'demo_view') views++;
    if (e.event === 'demo_complete') completes++;
    if (e.event === 'step_view') byStep[e.nodeId] = (byStep[e.nodeId] || 0) + 1;
  }
  res.json({ views, completes, byStep, total: events.length });
}));

// ---------------------------------------------------------------- pages

// Local play page, so a demo can be shared on the LAN or previewed outside the editor.
app.get('/play/:slug', wrap(async (req, res) => {
  const doc = await readDemo(req.params.slug);
  res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(doc.name)}</title>
<link rel="icon" href="/studio/favicon.svg">
<link rel="stylesheet" href="/player/player.css">
<style>
  html,body{margin:0;height:100%;background:#0b0b0f}
  body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  #demo{width:100%;max-width:1440px}
</style>
</head><body>
<div id="demo"></div>
<script type="module">
  import { DemoPlayer } from '/player/player.js';
  const demo = await fetch('/api/demos/${doc.slug}').then(r=>r.json()).then(d=>d.doc);
  const p = new DemoPlayer(document.getElementById('demo'), {
    demo, base: '/demos/${doc.slug}',
    onEvent: (event, payload) => navigator.sendBeacon?.('/api/analytics',
      new Blob([JSON.stringify({event, ...payload})], {type:'application/json'})),
  });
  await p.start();
</script>
</body></html>`);
}));

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'studio', 'index.html')));
app.get('/editor', (req, res) => res.sendFile(path.join(ROOT, 'studio', 'editor.html')));
app.get('/showcase', (req, res) => res.sendFile(path.join(ROOT, 'studio', 'showcase.html')));

// Browsers request this path on their own, whatever the page declares.
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(ROOT, 'studio', 'favicon.svg')));

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

await fs.mkdir(DEMOS_DIR, { recursive: true });
await fs.mkdir(DIST_DIR, { recursive: true });

app.listen(PORT, () => {
  console.log(`\n  \x1b[1mRunthru\x1b[0m  →  http://localhost:${PORT}\n`);
  if (!hasKey()) {
    console.log('  No API key yet — the studio will walk you through connecting an OpenAI or Anthropic one.\n');
  }
});
