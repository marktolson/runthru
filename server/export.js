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
import { demoDir, readDemo, slugify, DIST_DIR, ROOT } from './store.js';
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

function embedSnippet(doc, publicUrl) {
  const url = publicUrl || `https://YOUR-HOST/${doc.slug}/`;
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

export async function exportDemo(slug, { publicUrl = '' } = {}) {
  const doc = await readDemo(slug);
  const src = demoDir(slug);
  const out = path.join(DIST_DIR, slug);

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
  for (const n of published.nodes) {
    delete n.pageContext;
    delete n.capture;
  }

  await fs.writeFile(path.join(out, 'demo.json'), JSON.stringify(published, null, 2), 'utf8');
  await fs.writeFile(path.join(out, 'index.html'), indexHtml(doc), 'utf8');
  await fs.writeFile(path.join(out, 'embed.txt'), embedSnippet(doc, publicUrl), 'utf8');

  const size = await dirSize(out);

  // Ship it as one file too. A bundle is hundreds of snapshot files; the zip is what actually
  // gets emailed, attached to a ticket or dragged onto a host — so it is named after the demo
  // rather than its slug. The slug is derived from whatever the demo was first called (often
  // the whole recording brief), while the name is the title the author settled on.
  const fileName = slugify(doc.name) || slug;
  const zipPath = path.join(DIST_DIR, `${fileName}.zip`);
  const zip = await zipDirectory(out, zipPath, { root: fileName });

  return {
    slug,
    fileName,
    dir: out,
    bytes: size,
    steps: doc.nodes.length,
    zipPath,
    zipBytes: zip.bytes,
    zipUrl: `/dist/${encodeURIComponent(fileName)}.zip`,
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
