// Feature showcases.
//
// A showcase groups several recorded demos into one embeddable component: a list of feature
// names, and for each one an interactive demo (or a video) with explanatory commentary beside
// it. The viewer moves between features by clicking a name or simply scrolling.
//
// Stored separately from demos because a showcase references demos rather than owning them —
// the same demo can appear in several showcases.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, DIST_DIR, slugify, readDemo, demoDir } from './store.js';
import { zipDirectory } from './zip.js';

export const SHOWCASES_DIR = path.join(ROOT, 'showcases');

const dirFor = (slug) => path.join(SHOWCASES_DIR, slugify(slug));

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function blankShowcase(slug, name) {
  const now = new Date().toISOString();
  return {
    slug,
    name: name || slug,
    description: '',
    createdAt: now,
    updatedAt: now,
    theme: {
      accent: '#5b5bd6',
      accentText: '#ffffff',
      radius: 14,
      layout: 'rail', // rail | tabs
      dark: false,
    },
    settings: {
      advanceOnScroll: true,
      showCommentary: true,
      showFeatureNumbers: true,
      ctaLabel: '',
      ctaHref: '',
    },
    features: [],
  };
}

export function blankFeature(showcase, partial = {}) {
  let max = 0;
  for (const f of showcase.features || []) {
    const m = /^f(\d+)$/.exec(f.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return {
    id: `f${max + 1}`,
    name: 'New feature',
    tagline: '',
    commentary: '',
    media: 'demo', // demo | video
    demoSlug: '',
    videoSrc: '',
    poster: '',
    ...partial,
  };
}

export async function listShowcases() {
  await fs.mkdir(SHOWCASES_DIR, { recursive: true });
  const entries = await fs.readdir(SHOWCASES_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const doc = await readShowcase(e.name);
      out.push({
        slug: doc.slug,
        name: doc.name,
        description: doc.description,
        features: doc.features.length,
        updatedAt: doc.updatedAt,
      });
    } catch {}
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

export async function readShowcase(slug) {
  return JSON.parse(await fs.readFile(path.join(dirFor(slug), 'showcase.json'), 'utf8'));
}

export async function createShowcase({ name, slug }) {
  let base = slugify(slug || name || 'showcase');
  let candidate = base;
  let n = 2;
  while (await exists(path.join(dirFor(candidate), 'showcase.json'))) candidate = `${base}-${n++}`;
  await fs.mkdir(dirFor(candidate), { recursive: true });
  const doc = blankShowcase(candidate, name);
  await fs.writeFile(path.join(dirFor(candidate), 'showcase.json'), JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

export async function saveShowcase(slug, doc) {
  doc.updatedAt = new Date().toISOString();
  await fs.mkdir(dirFor(slug), { recursive: true });
  await fs.writeFile(path.join(dirFor(slug), 'showcase.json'), JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

export async function deleteShowcase(slug) {
  await fs.rm(dirFor(slug), { recursive: true, force: true });
}

// ---------------------------------------------------------------- export

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Produces a folder containing the widget, every referenced demo, a ready-to-open demo page,
// and a one-line script-tag snippet for dropping into an existing site.
export async function exportShowcase(slug, { publicUrl = '' } = {}) {
  const doc = await readShowcase(slug);
  const out = path.join(DIST_DIR, `showcase-${slug}`);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });

  const playerDir = path.join(ROOT, 'player');
  for (const f of ['player.js', 'player.css', 'showcase.js', 'showcase.css', 'embed.js']) {
    await fs.copyFile(path.join(playerDir, f), path.join(out, f));
  }

  // Bundle every demo the showcase points at, so the export is genuinely standalone.
  // Each demo is copied once even if several features reference it, but every feature still
  // gets its poster resolved.
  const bundled = [];
  const loaded = new Map();
  const published = JSON.parse(JSON.stringify(doc));

  for (const feature of published.features) {
    if (feature.media !== 'demo' || !feature.demoSlug) continue;
    try {
      let demo = loaded.get(feature.demoSlug);
      if (!demo) {
        demo = await readDemo(feature.demoSlug);
        const dst = path.join(out, 'demos', feature.demoSlug);
        for (const sub of ['steps', 'assets', 'shots']) {
          await copyDir(path.join(demoDir(feature.demoSlug), sub), path.join(dst, sub));
        }
        const clean = JSON.parse(JSON.stringify(demo));
        for (const n of clean.nodes) {
          delete n.pageContext;
          delete n.capture;
        }
        await fs.writeFile(path.join(dst, 'demo.json'), JSON.stringify(clean, null, 2), 'utf8');
        loaded.set(feature.demoSlug, demo);
        bundled.push(feature.demoSlug);
      }

      // Resolve the poster against the demo's actual first step rather than a stored filename.
      // Deleting or reordering steps in the editor invalidates any hardcoded path.
      const storedOk = feature.poster ? await exists(path.join(out, feature.poster)) : false;
      if (!storedOk) {
        const firstShot = demo.nodes.find((n) => n.shot)?.shot;
        feature.poster = firstShot ? `demos/${feature.demoSlug}/${firstShot}` : '';
      }
    } catch {
      // A missing demo should not sink the whole export; the widget renders a placeholder.
      feature.missing = true;
    }
  }

  await fs.writeFile(path.join(out, 'showcase.json'), JSON.stringify(published, null, 2), 'utf8');

  await fs.writeFile(
    path.join(out, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.name)}</title>
<meta name="description" content="${esc(doc.description || '')}">
<link rel="stylesheet" href="./player.css">
<link rel="stylesheet" href="./showcase.css">
<style>
  body { margin: 0; background: ${doc.theme?.dark ? '#0b0b0f' : '#fff'};
         font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 48px 24px; }
</style>
</head>
<body>
  <div class="wrap"><div id="showcase"></div></div>
  <script type="module">
    import { FeatureShowcase } from './showcase.js';
    const doc = await fetch('./showcase.json').then(r => r.json());
    new FeatureShowcase(document.getElementById('showcase'), { doc, base: '.' }).mount();
  </script>
</body>
</html>`,
    'utf8',
  );

  const host = publicUrl ? publicUrl.replace(/\/$/, '') : 'https://YOUR-HOST/showcase-' + slug;
  await fs.writeFile(
    path.join(out, 'embed.txt'),
    `${doc.name} — drop-in embed
================================================================

One script tag. It creates the showcase wherever you put the div.

<div id="feature-showcase"></div>
<script src="${host}/embed.js"
        data-showcase="${host}/showcase.json"
        data-target="#feature-showcase"
        defer></script>

The script injects its own styles and is scoped under .sc, so it will not
collide with your site's CSS.

Alternative — iframe the whole page instead:

<iframe src="${host}/index.html" style="width:100%;height:820px;border:0"
        title="${esc(doc.name)}" loading="lazy"></iframe>

Serve over http(s), not file:// — the player measures elements inside the
snapshot iframe, which an opaque file:// origin blocks.
`,
    'utf8',
  );

  const name = `showcase-${slug}`;
  const zipPath = path.join(DIST_DIR, `${name}.zip`);
  const zip = await zipDirectory(out, zipPath, { root: name });

  return {
    slug,
    dir: out,
    features: doc.features.length,
    demos: bundled,
    zipPath,
    zipBytes: zip.bytes,
    zipUrl: `/dist/${encodeURIComponent(name)}.zip`,
  };
}
