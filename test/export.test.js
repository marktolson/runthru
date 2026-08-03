// Static export and the zip writer.
//
// An export is what actually leaves the machine, so the things worth pinning are: it is
// self-contained, it carries nothing internal, and it is named by whatever the author calls
// the export — falling back to the demo's title, never to its slug, which is derived from
// whatever the demo was first called and is often the entire recording brief.
//
// Every demo seeded here is named "Zz exporttest …" on purpose. The export name now decides a
// real folder under dist/, and these tests delete the folders they create, so a test demo
// called something ordinary like "Rebuilt" could delete a genuine export of the same name.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createDemo, demoDir, readDemo, writeDemo, DIST_DIR } from '../server/store.js';
import { exportDemo } from '../server/export.js';
import { zipDirectory } from '../server/zip.js';

const run = promisify(execFile);
const made = new Set();
const cleanup = new Set();
let counter = 0;

after(async () => {
  for (const slug of made) {
    await fs.rm(demoDir(slug), { recursive: true, force: true });
    await fs.rm(path.join(DIST_DIR, slug), { recursive: true, force: true });
  }
  for (const p of cleanup) await fs.rm(p, { recursive: true, force: true });
});

// A demo with one real step on disk, so the export has something to copy.
async function seedDemo(name) {
  const slug = `zz-exporttest-${process.pid}-${counter++}`;
  made.add(slug);
  await createDemo({ name, startUrl: 'https://example.test/', slug });
  const dir = demoDir(slug);
  await fs.writeFile(path.join(dir, 'steps', 'step-001.html'), '<!doctype html><title>Step</title><p>hi</p>', 'utf8');
  await fs.writeFile(path.join(dir, 'shots', 'step-001.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

  const doc = await readDemo(slug);
  doc.nodes = [
    {
      id: 'n1',
      snapshot: 'steps/step-001.html',
      shot: 'shots/step-001.png',
      url: 'https://example.test/',
      pageTitle: 'Step',
      annotation: { kind: 'tooltip', title: 'Only step', body: '' },
      advance: { on: 'next', ms: 0 },
      next: null,
      branches: [],
      overlays: [],
      // Studio-only fields that must not survive into a published bundle.
      pageContext: { secret: 'internal notes' },
      capture: { reason: 'click', at: '2026-01-01T00:00:00.000Z' },
    },
  ];
  await writeDemo(slug, doc, { history: false });
  return slug;
}

describe('exportDemo', () => {
  test('names the downloadable zip after the demo, not its slug', async () => {
    const slug = await seedDemo('Zz exporttest create a project with Ru');
    const r = await exportDemo(slug);
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    assert.equal(r.fileName, 'zz-exporttest-create-a-project-with-ru');
    assert.equal(path.basename(r.zipPath), 'zz-exporttest-create-a-project-with-ru.zip');
    assert.equal(r.zipUrl, '/dist/zz-exporttest-create-a-project-with-ru.zip');
    assert.notEqual(r.fileName, slug, 'the slug should not be the download name');
    assert.ok(await fs.stat(r.zipPath).then(() => true, () => false), 'zip was not written');
  });

  test('falls back to the slug when the name has no usable characters', async () => {
    const slug = await seedDemo('!!!');
    const r = await exportDemo(slug);
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);
    assert.ok(r.fileName.length > 0);
    assert.doesNotMatch(r.fileName, /[^a-z0-9-]/, 'filename must be filesystem-safe');
    // Specifically this demo's slug, not a shared generic fallback: two demos that both name
    // themselves unusably must not export into the same folder and overwrite each other.
    assert.equal(r.exportSlug, slug);
  });

  test('writes a self-contained bundle: player, document, snapshot and entry point', async () => {
    const slug = await seedDemo('Zz exporttest bundle contents');
    const r = await exportDemo(slug);
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    for (const f of ['index.html', 'demo.json', 'player.js', 'player.css', 'embed.txt', 'steps/step-001.html']) {
      assert.ok(await fs.stat(path.join(r.dir, f)).then(() => true, () => false), `bundle is missing ${f}`);
    }
    assert.equal(r.steps, 1);
    assert.ok(r.bytes > 0);
  });

  test('strips studio-only fields from the published document', async () => {
    const slug = await seedDemo('Zz exporttest stripped');
    const r = await exportDemo(slug);
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    const published = JSON.parse(await fs.readFile(path.join(r.dir, 'demo.json'), 'utf8'));
    assert.equal(published.nodes[0].pageContext, undefined, 'internal page context was published');
    assert.equal(published.nodes[0].capture, undefined, 'capture metadata was published');
    assert.equal(published.nodes[0].annotation.title, 'Only step', 'viewer-facing copy must survive');
  });

  test('the entry point references only relative paths, so any static host works', async () => {
    const slug = await seedDemo('Zz exporttest relative paths');
    const r = await exportDemo(slug);
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    const html = await fs.readFile(path.join(r.dir, 'index.html'), 'utf8');
    assert.match(html, /\.\/player\.css/);
    assert.match(html, /\.\/player\.js/);
    assert.doesNotMatch(html, /(src|href)="\//, 'an absolute path would break a subfolder deploy');
  });

  test('an explicit export name decides the folder, the zip and the embed URL', async () => {
    const slug = await seedDemo('Zz exporttest whatever');
    const r = await exportDemo(slug, { name: 'Zz exporttest create a project with Ru!' });
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    assert.equal(r.exportSlug, 'zz-exporttest-create-a-project-with-ru');
    assert.equal(path.basename(r.dir), 'zz-exporttest-create-a-project-with-ru', 'the folder should take the export name');
    assert.equal(path.basename(r.zipPath), 'zz-exporttest-create-a-project-with-ru.zip');

    // The folder, the zip and the URL in the embed snippet must all agree, or the snippet
    // points somewhere the bundle was never published to.
    const embed = await fs.readFile(path.join(r.dir, 'embed.txt'), 'utf8');
    assert.match(embed, /YOUR-HOST\/zz-exporttest-create-a-project-with-ru\//);
  });

  test('the export name is slugified, so it cannot escape dist/', async () => {
    const slug = await seedDemo('Zz exporttest traversal');
    const r = await exportDemo(slug, { name: '../../etc/passwd' });
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    assert.doesNotMatch(r.exportSlug, /[^a-z0-9-]/, 'the name arrives off the wire and names a directory');
    assert.equal(path.dirname(path.resolve(r.dir)), path.resolve(DIST_DIR), 'the bundle escaped dist/');
  });

  test('remembers the export name and public URL for next time', async () => {
    const slug = await seedDemo('Zz exporttest remembered');
    const r = await exportDemo(slug, { name: 'Zz exporttest pick me', publicUrl: 'https://demos.example.test/pick-me/' });
    cleanup.add(r.zipPath);
    cleanup.add(r.dir);

    const doc = await readDemo(slug);
    // Stored as typed, not as the slug it became — reopening the dialog should show the title
    // the author wrote, and it still slugifies back to the same folder.
    assert.equal(doc.export.name, 'Zz exporttest pick me');
    assert.equal(doc.export.publicUrl, 'https://demos.example.test/pick-me/');
  });

  test('the remembered export settings are never published to viewers', async () => {
    const slug = await seedDemo('Zz exporttest not published');
    const first = await exportDemo(slug, { name: 'Zz exporttest round one', publicUrl: 'https://internal.example.test/' });
    cleanup.add(first.zipPath);
    cleanup.add(first.dir);

    // Only the second export can carry it: the first is what writes it in the first place.
    const second = await exportDemo(slug, { name: 'Zz exporttest round two' });
    cleanup.add(second.zipPath);
    cleanup.add(second.dir);

    const published = JSON.parse(await fs.readFile(path.join(second.dir, 'demo.json'), 'utf8'));
    assert.equal(published.export, undefined, 'studio dialog state was published to viewers');
  });

  test('re-exporting replaces the bundle rather than accumulating stale files', async () => {
    const slug = await seedDemo('Zz exporttest rebuilt');
    const first = await exportDemo(slug);
    cleanup.add(first.zipPath);
    cleanup.add(first.dir);
    await fs.writeFile(path.join(first.dir, 'stale.txt'), 'left over', 'utf8');

    const second = await exportDemo(slug);
    cleanup.add(second.zipPath);
    cleanup.add(second.dir);
    assert.equal(await fs.stat(path.join(second.dir, 'stale.txt')).then(() => true, () => false), false);
  });
});

describe('zipDirectory', () => {
  test('produces an archive the system unzip can read', async () => {
    const src = path.join(DIST_DIR, `zz-ziptest-${process.pid}`);
    const zipPath = `${src}.zip`;
    cleanup.add(src);
    cleanup.add(zipPath);

    await fs.mkdir(path.join(src, 'nested'), { recursive: true });
    await fs.writeFile(path.join(src, 'a.txt'), 'hello', 'utf8');
    await fs.writeFile(path.join(src, 'nested', 'b.txt'), 'world', 'utf8');

    const out = await zipDirectory(src, zipPath, { root: 'bundle' });
    assert.equal(out.files, 2);
    assert.ok(out.bytes > 0);

    // Local file header magic: a real zip, not just bytes on disk.
    const head = await fs.readFile(zipPath);
    assert.deepEqual([...head.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

    const { stdout } = await run('unzip', ['-l', zipPath]);
    assert.match(stdout, /bundle\/a\.txt/);
    assert.match(stdout, /bundle\/nested\/b\.txt/, 'nested paths must survive with forward slashes');
  });

  test('everything nests under one folder, so unzipping never scatters files', async () => {
    const src = path.join(DIST_DIR, `zz-ziproot-${process.pid}`);
    const zipPath = `${src}.zip`;
    cleanup.add(src);
    cleanup.add(zipPath);

    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'only.txt'), 'x', 'utf8');
    await zipDirectory(src, zipPath, { root: 'my-demo' });

    const { stdout } = await run('unzip', ['-Z', '-1', zipPath]);
    const entries = stdout.trim().split('\n').filter(Boolean);
    assert.ok(entries.every((e) => e.startsWith('my-demo/')), `found a stray top-level entry: ${entries}`);
  });

  test('dotfiles are skipped, so .history never ships to a viewer', async () => {
    const src = path.join(DIST_DIR, `zz-zipdot-${process.pid}`);
    const zipPath = `${src}.zip`;
    cleanup.add(src);
    cleanup.add(zipPath);

    await fs.mkdir(path.join(src, '.history'), { recursive: true });
    await fs.writeFile(path.join(src, '.history', 'old.json'), '{}', 'utf8');
    await fs.writeFile(path.join(src, '.secret'), 'nope', 'utf8');
    await fs.writeFile(path.join(src, 'keep.txt'), 'yes', 'utf8');

    const out = await zipDirectory(src, zipPath, { root: 'r' });
    assert.equal(out.files, 1, 'only the non-dot file should be archived');

    const { stdout } = await run('unzip', ['-Z', '-1', zipPath]);
    assert.doesNotMatch(stdout, /\.history|\.secret/);
    assert.match(stdout, /keep\.txt/);
  });
});
