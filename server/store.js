// Demo document persistence + undo history.
//
// Layout on disk:
//   demos/<slug>/demo.json
//   demos/<slug>/steps/step-001.html      self-contained DOM snapshots
//   demos/<slug>/shots/step-001.png       thumbnails (also fed to AI auto-draft)
//   demos/<slug>/assets/<sha1>.<ext>      deduped images/fonts pulled during capture
//   demos/<slug>/.history/<n>.json        previous doc versions, for undo

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMOS_DIR = path.join(ROOT, 'demos');
export const DIST_DIR = path.join(ROOT, 'dist');
export const PROFILES_DIR = path.join(ROOT, '.profiles');
export { ROOT };

const HISTORY_LIMIT = 60;

export function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'demo'
  );
}

export function demoDir(slug) {
  // Guard against traversal — slug comes off the wire.
  const clean = slugify(slug);
  return path.join(DEMOS_DIR, clean);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function blankDemo(slug, name, startUrl = '') {
  const now = new Date().toISOString();
  return {
    slug,
    name: name || slug,
    description: '',
    startUrl,
    createdAt: now,
    updatedAt: now,
    theme: {
      accent: '#5b5bd6',
      accentText: '#ffffff',
      font: 'system',
      radius: 12,
      overlay: 0.55,
      spotlight: true,
      logo: '',
    },
    settings: {
      showProgress: true,
      showControls: true,
      cursor: true,
      typing: true,
      freeRoam: false,
      autoplay: false,
      autoplayMs: 4000,
      startNodeId: null,
      loop: false,
    },
    variables: [],
    nodes: [],
    // Monotonic snapshot counter. Never reset — see capture.js for why reusing a filename
    // corrupts undo.
    stepSeq: 0,
    leadForm: {
      enabled: false,
      position: 'end',
      headline: 'See it with your own data',
      body: '',
      submitLabel: 'Continue',
      fields: [
        { key: 'email', label: 'Work email', type: 'email', required: true },
        { key: 'company', label: 'Company', type: 'text', required: false },
      ],
    },
    endCta: { enabled: false, label: 'Book a demo', href: '', body: '' },
    analytics: { enabled: true, endpoint: '' },
  };
}

export async function listDemos() {
  await fs.mkdir(DEMOS_DIR, { recursive: true });
  const entries = await fs.readdir(DEMOS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const doc = await readDemo(e.name);
      out.push({
        slug: doc.slug,
        name: doc.name,
        description: doc.description,
        startUrl: doc.startUrl,
        steps: doc.nodes.length,
        // The first step's screenshot, whatever it is called. Never assume step-001: deleting
        // or reordering steps in the editor invalidates any guessed filename.
        poster: doc.nodes.find((n) => n.shot)?.shot ?? null,
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
      });
    } catch {
      // Skip unreadable/half-written demo folders rather than failing the list.
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

export async function readDemo(slug) {
  const file = path.join(demoDir(slug), 'demo.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Serialises every mutation of a demo. Each writer here follows read → modify → write of the
// whole demo.json, and several of them hold their copy across slow work — a capture spends
// seconds serializing the page, an AI pass spends minutes — so two writers interleaving means
// the later write silently resurrects whatever the earlier one changed (deleted steps
// reappearing mid-recording, most visibly). Everything that writes demo.json must run inside
// this lock, and anything that was slow before its write must re-read once inside it.
const demoLocks = new Map();
export function withDemoLock(slug, fn) {
  const tail = (demoLocks.get(slug) || Promise.resolve()).catch(() => {}).then(fn);
  demoLocks.set(slug, tail);
  tail
    .finally(() => {
      if (demoLocks.get(slug) === tail) demoLocks.delete(slug);
    })
    .catch(() => {});
  return tail;
}

export async function demoExists(slug) {
  return exists(path.join(demoDir(slug), 'demo.json'));
}

export async function createDemo({ name, startUrl, slug }) {
  let base = slugify(slug || name || 'demo');
  let candidate = base;
  let n = 2;
  while (await demoExists(candidate)) candidate = `${base}-${n++}`;

  const dir = demoDir(candidate);
  await fs.mkdir(path.join(dir, 'steps'), { recursive: true });
  await fs.mkdir(path.join(dir, 'shots'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, '.history'), { recursive: true });

  const doc = blankDemo(candidate, name, startUrl);
  await writeDemo(candidate, doc, { history: false });
  return doc;
}

// Persist a doc. `history: true` snapshots the *previous* version first so it can be undone.
export async function writeDemo(slug, doc, { history = true } = {}) {
  const dir = demoDir(slug);
  await fs.mkdir(path.join(dir, '.history'), { recursive: true });
  const file = path.join(dir, 'demo.json');

  if (history && (await exists(file))) {
    const prev = await fs.readFile(file, 'utf8');
    await fs.writeFile(path.join(dir, '.history', `${historyStamp()}.json`), prev, 'utf8');
    await trimHistory(dir);
  }

  doc.updatedAt = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

// History entries are named by timestamp and undo reads them back in filename order, so two
// entries may never share a name. Date.now() alone is not enough: several writes routinely
// land in the same millisecond (a debounced save landing with a click, an AI turn applying
// a few ops), and the second silently overwrote the first, losing a step of undo. Advance a
// virtual clock instead, so stamps are always unique and always sort chronologically.
let lastHistoryStamp = 0;
function historyStamp() {
  lastHistoryStamp = Math.max(Date.now(), lastHistoryStamp + 1);
  return String(lastHistoryStamp).padStart(14, '0');
}

async function trimHistory(dir) {
  const hdir = path.join(dir, '.history');
  const files = (await fs.readdir(hdir)).filter((f) => f.endsWith('.json')).sort();
  const excess = files.length - HISTORY_LIMIT;
  for (let i = 0; i < excess; i++) {
    await fs.rm(path.join(hdir, files[i]), { force: true });
  }
}

// Undo: restore the most recent history entry, pushing the current doc onto a redo stack.
export async function undoDemo(slug) {
  const dir = demoDir(slug);
  const hdir = path.join(dir, '.history');
  if (!(await exists(hdir))) return null;
  const files = (await fs.readdir(hdir)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;

  const last = files[files.length - 1];
  const restored = JSON.parse(await fs.readFile(path.join(hdir, last), 'utf8'));

  // Current version becomes the redo entry.
  const current = await readDemo(slug);
  await fs.mkdir(path.join(dir, '.redo'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.redo', `${String(Date.now()).padStart(14, '0')}.json`),
    JSON.stringify(current, null, 2),
    'utf8',
  );

  await fs.rm(path.join(hdir, last), { force: true });
  await writeDemo(slug, restored, { history: false });
  return restored;
}

export async function redoDemo(slug) {
  const dir = demoDir(slug);
  const rdir = path.join(dir, '.redo');
  if (!(await exists(rdir))) return null;
  const files = (await fs.readdir(rdir)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;

  const last = files[files.length - 1];
  const restored = JSON.parse(await fs.readFile(path.join(rdir, last), 'utf8'));
  await fs.rm(path.join(rdir, last), { force: true });
  await writeDemo(slug, restored, { history: true });
  return restored;
}

// Any fresh edit invalidates the redo stack.
export async function clearRedo(slug) {
  await fs.rm(path.join(demoDir(slug), '.redo'), { recursive: true, force: true });
}

export async function deleteDemo(slug) {
  await fs.rm(demoDir(slug), { recursive: true, force: true });
}

export async function historyDepth(slug) {
  const dir = demoDir(slug);
  const count = async (sub) => {
    const p = path.join(dir, sub);
    if (!(await exists(p))) return 0;
    return (await fs.readdir(p)).filter((f) => f.endsWith('.json')).length;
  };
  return { undo: await count('.history'), redo: await count('.redo') };
}
