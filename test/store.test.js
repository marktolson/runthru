// Persistence, undo history, and the per-demo lock.
//
// The lock tests matter most: every writer here does read -> modify -> write of the whole
// demo.json, and several hold their copy across slow work (a capture spends seconds
// serialising a page, an AI pass spends minutes). Without serialisation the later write
// silently resurrects whatever an earlier one changed, which is how deleted steps came back
// mid-recording. These are the regression tests for that.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  slugify,
  blankDemo,
  demoDir,
  createDemo,
  demoExists,
  readDemo,
  writeDemo,
  deleteDemo,
  undoDemo,
  redoDemo,
  clearRedo,
  historyDepth,
  listDemos,
  withDemoLock,
} from '../server/store.js';

// Every demo this file creates, removed at the end whatever happens.
const made = new Set();
let counter = 0;
const uniqueSlug = () => {
  const s = `zz-unittest-${process.pid}-${counter++}`;
  made.add(s);
  return s;
};

async function seed(nodes = []) {
  const slug = uniqueSlug();
  await createDemo({ name: slug, startUrl: 'https://example.test/', slug });
  const doc = await readDemo(slug);
  doc.nodes = nodes;
  await writeDemo(slug, doc, { history: false });
  return slug;
}

after(async () => {
  for (const slug of made) await fs.rm(demoDir(slug), { recursive: true, force: true });
});

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    assert.equal(slugify('Create A Project With Ru'), 'create-a-project-with-ru');
  });

  test('collapses runs of punctuation and trims the edges', () => {
    assert.equal(slugify('  Hello --- World!!  '), 'hello-world');
  });

  test('caps length so a whole recording brief cannot become a filename', () => {
    assert.ok(slugify('x'.repeat(200)).length <= 60);
  });

  test('falls back to "demo" when nothing usable is left', () => {
    assert.equal(slugify('!!!'), 'demo');
    assert.equal(slugify(''), 'demo');
    assert.equal(slugify(null), 'demo');
  });
});

describe('blankDemo', () => {
  test('has the shape the player and editor expect', () => {
    const d = blankDemo('s', 'Name', 'https://x.test/');
    assert.equal(d.slug, 's');
    assert.equal(d.name, 'Name');
    assert.equal(d.startUrl, 'https://x.test/');
    assert.deepEqual(d.nodes, []);
    assert.deepEqual(d.variables, []);
    assert.equal(typeof d.theme.accent, 'string');
    assert.equal(d.settings.startNodeId, null);
  });

  test('falls back to the slug when given no name', () => {
    assert.equal(blankDemo('my-slug', '').name, 'my-slug');
  });
});

describe('create, read, write, delete', () => {
  test('createDemo writes a readable document and the folders capture needs', async () => {
    const slug = uniqueSlug();
    await createDemo({ name: 'Read me back', startUrl: 'https://x.test/', slug });
    const doc = await readDemo(slug);
    assert.equal(doc.name, 'Read me back');
    for (const sub of ['steps', 'shots', 'assets']) {
      assert.ok(await fs.stat(path.join(demoDir(slug), sub)).then(() => true, () => false), `missing ${sub}/`);
    }
  });

  test('a colliding slug gets suffixed rather than overwriting the original', async () => {
    const slug = uniqueSlug();
    const a = await createDemo({ name: 'Dup', slug });
    const b = await createDemo({ name: 'Dup', slug });
    made.add(b.slug);
    assert.equal(a.slug, slug);
    assert.equal(b.slug, `${slug}-2`);
    assert.notEqual(a.slug, b.slug);
  });

  test('writeDemo stamps updatedAt and round-trips through readDemo', async () => {
    const slug = await seed();
    const doc = await readDemo(slug);
    doc.name = 'Renamed';
    const written = await writeDemo(slug, doc, { history: false });
    assert.ok(written.updatedAt);
    assert.equal((await readDemo(slug)).name, 'Renamed');
  });

  test('demoExists and deleteDemo agree about reality', async () => {
    const slug = await seed();
    assert.equal(await demoExists(slug), true);
    await deleteDemo(slug);
    assert.equal(await demoExists(slug), false);
  });

  test('listDemos includes a demo it just made', async () => {
    const slug = await seed();
    assert.ok((await listDemos()).some((d) => d.slug === slug));
  });
});

describe('undo and redo', () => {
  test('history:false writes leave nothing to undo', async () => {
    const slug = await seed();
    assert.equal((await historyDepth(slug)).undo, 0);
  });

  test('undo restores the previous version', async () => {
    const slug = await seed();
    const doc = await readDemo(slug);
    doc.name = 'Second';
    await writeDemo(slug, doc, { history: true });
    assert.equal((await readDemo(slug)).name, 'Second');

    const restored = await undoDemo(slug);
    assert.equal(restored.name, slug, 'should be back to the original name');
    assert.equal((await readDemo(slug)).name, slug);
  });

  test('redo reapplies what undo took away', async () => {
    const slug = await seed();
    const doc = await readDemo(slug);
    doc.name = 'Second';
    await writeDemo(slug, doc, { history: true });
    await undoDemo(slug);
    const redone = await redoDemo(slug);
    assert.equal(redone.name, 'Second');
  });

  test('undo returns null when there is nothing left', async () => {
    const slug = await seed();
    assert.equal(await undoDemo(slug), null);
  });

  test('clearRedo drops the redo stack, as any fresh edit should', async () => {
    const slug = await seed();
    const doc = await readDemo(slug);
    doc.name = 'Second';
    await writeDemo(slug, doc, { history: true });
    await undoDemo(slug);
    assert.equal((await historyDepth(slug)).redo, 1);
    await clearRedo(slug);
    assert.equal((await historyDepth(slug)).redo, 0);
  });

  // History files are named by timestamp; several writes routinely land in the same
  // millisecond, and they used to overwrite each other and lose a step of undo.
  test('writes inside the same millisecond each get their own undo entry', async () => {
    const slug = await seed();
    for (let i = 0; i < 5; i++) {
      const doc = await readDemo(slug);
      doc.name = `rapid-${i}`;
      await writeDemo(slug, doc, { history: true }); // no delay: same ms on any fast machine
    }
    assert.equal((await historyDepth(slug)).undo, 5, 'history entries collided and were lost');

    // And they unwind in the order they were made.
    for (let i = 4; i >= 1; i--) {
      const restored = await undoDemo(slug);
      assert.equal(restored.name, `rapid-${i - 1}`);
    }
  });

  test('historyDepth counts both stacks', async () => {
    const slug = await seed();
    for (const name of ['a', 'b', 'c']) {
      const doc = await readDemo(slug);
      doc.name = name;
      await writeDemo(slug, doc, { history: true });
    }
    assert.equal((await historyDepth(slug)).undo, 3);
    await undoDemo(slug);
    const d = await historyDepth(slug);
    assert.equal(d.undo, 2);
    assert.equal(d.redo, 1);
  });
});

describe('withDemoLock', () => {
  test('runs tasks one at a time, never overlapping', async () => {
    const slug = 'lock-a';
    let running = 0;
    let maxConcurrent = 0;
    const task = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all(Array.from({ length: 8 }, () => withDemoLock(slug, task)));
    assert.equal(maxConcurrent, 1, 'two writers were inside the lock at once');
  });

  test('preserves the order tasks were queued in', async () => {
    const order = [];
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        withDemoLock('lock-order', async () => {
          await new Promise((r) => setTimeout(r, 6 - i));
          order.push(i);
        }),
      ),
    );
    assert.deepEqual(order, [1, 2, 3, 4]);
  });

  test('different demos do not block one another', async () => {
    let bStarted = false;
    const slow = withDemoLock('lock-b1', async () => {
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(bStarted, true, 'a second demo should not wait on the first');
    });
    const fast = withDemoLock('lock-b2', async () => {
      bStarted = true;
    });
    await Promise.all([slow, fast]);
  });

  test('a task that throws does not wedge the lock for the next one', async () => {
    const slug = 'lock-c';
    await assert.rejects(() => withDemoLock(slug, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withDemoLock(slug, async () => 'still works'), 'still works');
  });

  test('returns the task result to its own caller', async () => {
    assert.equal(await withDemoLock('lock-d', async () => 42), 42);
  });

  // The bug this was written for: a capture read demo.json, spent seconds serialising, then
  // wrote its stale copy back, undoing every step deleted in the meantime.
  test('concurrent read-modify-write cycles all survive', async () => {
    const slug = await seed([]);
    const append = (id) =>
      withDemoLock(slug, async () => {
        const doc = await readDemo(slug);
        await new Promise((r) => setTimeout(r, 5)); // stand-in for slow capture work
        doc.nodes.push({ id });
        await writeDemo(slug, doc, { history: false });
      });

    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(append));
    const doc = await readDemo(slug);
    assert.equal(doc.nodes.length, 5, 'a write clobbered another writer');
    assert.deepEqual(doc.nodes.map((n) => n.id).sort(), ['a', 'b', 'c', 'd', 'e']);
  });

  test('a deletion is not resurrected by a slow write that started before it', async () => {
    const slug = await seed([{ id: 'keep' }, { id: 'doomed' }]);

    // A slow writer appending a step, and a delete queued behind it.
    const slowAppend = withDemoLock(slug, async () => {
      const doc = await readDemo(slug);
      await new Promise((r) => setTimeout(r, 20));
      doc.nodes.push({ id: 'fresh' });
      await writeDemo(slug, doc, { history: false });
    });
    const remove = withDemoLock(slug, async () => {
      const doc = await readDemo(slug);
      doc.nodes = doc.nodes.filter((n) => n.id !== 'doomed');
      await writeDemo(slug, doc, { history: false });
    });
    await Promise.all([slowAppend, remove]);

    const ids = (await readDemo(slug)).nodes.map((n) => n.id);
    assert.ok(!ids.includes('doomed'), 'the deleted step came back');
    assert.deepEqual(ids.sort(), ['fresh', 'keep']);
  });
});
