// Static export.
//
// Writes a folder with no backend of any kind: the same player used in the studio, the demo
// document, the snapshots and their assets. Drop it on any static host.
//
// It must be served over HTTP rather than opened as a file:// path — browsers give file://
// iframes an opaque origin, which blocks the player from measuring targets inside the
// snapshot. `npm run serve-export` exists for exactly this.

import fs from 'node:fs/promises';
import path from 'node:path';
import { demoDir, readDemo, writeDemo, withDemoLock, slugify, DIST_DIR, ROOT } from './store.js';
import { zipDirectory } from './zip.js';

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function indexHtml(doc) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.name || doc.slug)}</title>
<meta name="description" content="${esc(doc.description || '')}">
<meta property="og:title" content="${esc(doc.name || doc.slug)}">
<meta property="og:description" content="${esc(doc.description || '')}">
<link rel="stylesheet" href="./player.css">
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; }
  body { display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  #demo { width: 100%; max-width: 1440px; }
</style>
</head>
<body>
  <div id="demo"></div>
  <script type="module">
    import { DemoPlayer, makeBeacon } from './player.js';
    const demo = await fetch('./demo.json').then(r => r.json());
    const player = new DemoPlayer(document.getElementById('demo'), {
      demo, base: '.', onEvent: makeBeacon(demo),
    });
    await player.start();
  </script>
</body>
</html>`;
}

function embedSnippet(doc, publicUrl, exportSlug) {
  const url = publicUrl || `https://YOUR-HOST/${exportSlug}/`;
  return `<!-- ${doc.name || doc.slug} — responsive embed -->
<div style="position:relative;width:100%;padding-bottom:62.5%;height:0;overflow:hidden;border-radius:12px">
  <iframe
    src="${url}"
    title="${esc(doc.name || doc.slug)}"
    loading="lazy"
    allowfullscreen
    style="position:absolute;top:0;left:0;width:100%;height:100%;border:0"
  ></iframe>
</div>

Replace YOUR-HOST with wherever you upload this folder.
The demo must be served over http(s) — opening index.html directly from disk will not work,
because browsers give file:// iframes an opaque origin and the player cannot measure targets.
`;
}

export async function exportDemo(slug, { publicUrl = '', name = '' } = {}) {
  const doc = await readDemo(slug);
  const src = demoDir(slug);

  // What the export is called: its folder, its zip, and the last segment of the URL it will be
  // hosted at. Defaults to the demo's title rather than its slug, because the slug is derived
  // from whatever the demo was first called — often the entire recording brief — which reads
  // badly in a public link. Slugified here rather than trusted, since it arrives off the wire
  // and names a directory.
  // Cleaned here rather than via slugify(), whose own "demo" fallback would send every
  // unusably-named demo to the same dist/demo folder to overwrite each other. An empty result
  // falls back to this demo's slug, which is unique by construction.
  const exportSlug =
    String(name || doc.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || slug;
  const out = path.join(DIST_DIR, exportSlug);

  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });

  await copyDir(path.join(src, 'steps'), path.join(out, 'steps'));
  await copyDir(path.join(src, 'assets'), path.join(out, 'assets'));

  // Screenshots are only needed by the studio and the showcase poster frames.
  await copyDir(path.join(src, 'shots'), path.join(out, 'shots'));

  const playerDir = path.join(ROOT, 'player');
  await fs.copyFile(path.join(playerDir, 'player.js'), path.join(out, 'player.js'));
  await fs.copyFile(path.join(playerDir, 'player.css'), path.join(out, 'player.css'));

  // Strip studio-only fields so the published document carries nothing internal.
  const published = JSON.parse(JSON.stringify(doc));
  delete published.export; // remembered dialog state, of no interest to a viewer
  for (const n of published.nodes) {
    delete n.pageContext;
    delete n.capture;
  }

  await fs.writeFile(path.join(out, 'demo.json'), JSON.stringify(published, null, 2), 'utf8');
  await fs.writeFile(path.join(out, 'index.html'), indexHtml(doc), 'utf8');
  await fs.writeFile(path.join(out, 'embed.txt'), embedSnippet(doc, publicUrl, exportSlug), 'utf8');

  const size = await dirSize(out);

  // Ship it as one file too. A bundle is hundreds of snapshot files; the zip is what actually
  // gets emailed, attached to a ticket or dragged onto a host. It carries the same name as the
  // folder so that what you download, what you unzip and what the URL says all agree.
  const zipPath = path.join(DIST_DIR, `${exportSlug}.zip`);
  const zip = await zipDirectory(out, zipPath, { root: exportSlug });

  // Remember what this export was called and where it is hosted, so the next one offers them
  // back instead of making the author retype both. Re-read inside the lock because everything
  // above is slow and the document may have moved on; written without a history entry, since
  // exporting is not an edit to the demo and must never cost an undo step.
  // The name is stored as it was typed, not as the slug it became: slugifying is deterministic,
  // so it still comes back to the same folder, and the author sees the title they wrote rather
  // than having it collapse to a slug the moment they reopen the dialog.
  await withDemoLock(slug, async () => {
    const fresh = await readDemo(slug);
    fresh.export = { name: name || doc.name, publicUrl };
    await writeDemo(slug, fresh, { history: false });
  }).catch(() => {}); // a bundle that is already on disk must not fail over a bookkeeping write

  return {
    slug,
    exportSlug,
    fileName: exportSlug,
    dir: out,
    bytes: size,
    steps: doc.nodes.length,
    zipPath,
    zipBytes: zip.bytes,
    zipUrl: `/dist/${encodeURIComponent(exportSlug)}.zip`,
  };
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await fs.stat(p)).size;
  }
  return total;
}
