// Serves dist/ over HTTP so exported bundles can be clicked through exactly as a real host
// would deliver them. Needed because browsers give file:// iframes an opaque origin, which
// stops the player measuring elements inside a snapshot.
//
//   npm run serve-export            → lists every export
//   npm run serve-export -- <slug>  → opens that one at the root

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIST_DIR } from './store.js';

const app = express();
const PORT = Number(process.env.EXPORT_PORT || 4500);
const only = process.argv[2];

app.use('/', express.static(only ? path.join(DIST_DIR, only) : DIST_DIR));

if (!only) {
  app.get('/', async (req, res) => {
    const entries = await fs.readdir(DIST_DIR, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    res.type('html').send(`<!doctype html><meta charset="utf-8">
      <title>Exports</title>
      <style>
        body{font:15px/1.6 ui-sans-serif,-apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#18181b}
        h1{font-size:20px;margin-bottom:4px} p{color:#71717a;margin-top:0}
        a{display:block;padding:12px 14px;border:1px solid #e4e4e7;border-radius:10px;margin-bottom:8px;
          text-decoration:none;color:#18181b;font-weight:600}
        a:hover{border-color:#5b5bd6;color:#5b5bd6}
      </style>
      <h1>Exported demos</h1>
      <p>Served from <code>dist/</code> on port ${PORT}.</p>
      ${dirs.length ? dirs.map((d) => `<a href="/${d}/">${d}</a>`).join('') : '<p>Nothing exported yet.</p>'}`);
  });
}

app.listen(PORT, () => {
  console.log(`\n  Exports → http://localhost:${PORT}${only ? `  (${only})` : ''}\n`);
});
