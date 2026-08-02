// The op table is the single mutation surface: the editor, the REST API and the AI tool-calls
// all go through it. A bug here is a bug in all three at once, so this is the file that earns
// its keep. Every op is exercised through applyOp, the way real callers reach it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyOp, resolveNext, nextNodeId, newNode, clone, toolSchemas, OPS, CONSTANTS } from '../server/docops.js';

// Three linear steps, no explicit flow. Enough to exercise ordering, flow repair and branching.
function fixture() {
  return {
    slug: 'fix',
    name: 'Fixture',
    description: '',
    settings: { startNodeId: null },
    variables: [],
    nodes: [
      { id: 'n1', annotation: { kind: 'tooltip', title: 'One' }, advance: { on: 'next', ms: 0 }, next: null, branches: [], overlays: [] },
      { id: 'n2', annotation: { kind: 'tooltip', title: 'Two' }, advance: { on: 'next', ms: 0 }, next: null, branches: [], overlays: [] },
      { id: 'n3', annotation: { kind: 'tooltip', title: 'Three' }, advance: { on: 'next', ms: 0 }, next: null, branches: [], overlays: [] },
    ],
  };
}

const ids = (doc) => doc.nodes.map((n) => n.id);

describe('applyOp', () => {
  test('never mutates the document it was given', () => {
    const before = fixture();
    const snapshot = JSON.stringify(before);
    applyOp(before, 'delete_step', { nodeId: 'n2' });
    assert.equal(JSON.stringify(before), snapshot, 'input doc was mutated in place');
  });

  test('returns a new document plus a human-readable summary', () => {
    const doc = fixture();
    const out = applyOp(doc, 'delete_step', { nodeId: 'n2' });
    assert.notEqual(out.doc, doc);
    assert.equal(out.readonly, false);
    assert.match(out.summary, /n2/);
  });

  test('readonly ops return a result and leave the doc alone', () => {
    const doc = fixture();
    const out = applyOp(doc, 'get_step', { nodeId: 'n1' });
    assert.equal(out.readonly, true);
    assert.equal(out.doc, doc, 'readonly op should not clone');
    assert.equal(out.result.id, 'n1');
  });

  test('rejects an unknown op by name, listing what is available', () => {
    assert.throws(() => applyOp(fixture(), 'launch_missiles', {}), /Unknown operation/);
  });

  test('rejects an op aimed at a step that does not exist', () => {
    assert.throws(() => applyOp(fixture(), 'set_step_copy', { nodeId: 'nope', title: 'x' }), /No step with id/);
  });
});

describe('flow resolution', () => {
  test('next is implicit: the following step in the array', () => {
    const doc = fixture();
    assert.equal(resolveNext(doc, 'n1'), 'n2');
    assert.equal(resolveNext(doc, 'n3'), null, 'last step ends the demo');
  });

  test('an explicit next overrides array order', () => {
    const doc = applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'n3' }).doc;
    assert.equal(resolveNext(doc, 'n1'), 'n3');
  });

  test('set_next refuses a destination that does not exist', () => {
    assert.throws(() => applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'ghost' }), /No step with id/);
  });

  test('passing null clears the override and restores linear order', () => {
    let doc = applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'n3' }).doc;
    doc = applyOp(doc, 'set_next', { nodeId: 'n1', next: null }).doc;
    assert.equal(doc.nodes[0].next, null);
    assert.equal(resolveNext(doc, 'n1'), 'n2');
  });

  test('resolveNext on an unknown id is null rather than a throw', () => {
    assert.equal(resolveNext(fixture(), 'ghost'), null);
  });
});

describe('node ids', () => {
  test('nextNodeId takes the highest numbered id, not the count', () => {
    assert.equal(nextNodeId({ nodes: [{ id: 'n1' }, { id: 'n7' }] }), 'n8');
  });

  test('ids that do not match the pattern are ignored', () => {
    assert.equal(nextNodeId({ nodes: [{ id: 'old-a' }, { id: 'n2' }] }), 'n3');
  });

  test('an empty demo starts at n1', () => {
    assert.equal(nextNodeId({ nodes: [] }), 'n1');
  });

  test('newNode gets a fresh id and sane defaults', () => {
    const n = newNode(fixture());
    assert.equal(n.id, 'n4');
    assert.equal(n.annotation.kind, 'tooltip');
    assert.equal(n.advance.on, 'click-target');
    assert.deepEqual(n.overlays, []);
  });
});

describe('copy', () => {
  test('set_step_copy updates only the fields supplied', () => {
    const doc = applyOp(fixture(), 'set_step_copy', { nodeId: 'n1', body: 'Body only' }).doc;
    assert.equal(doc.nodes[0].annotation.title, 'One', 'title should be untouched');
    assert.equal(doc.nodes[0].annotation.body, 'Body only');
  });

  test('bulk_set_step_copy writes several steps in one op', () => {
    const doc = applyOp(fixture(), 'bulk_set_step_copy', {
      steps: [
        { nodeId: 'n1', title: 'A' },
        { nodeId: 'n3', title: 'C' },
      ],
    }).doc;
    assert.equal(doc.nodes[0].annotation.title, 'A');
    assert.equal(doc.nodes[1].annotation.title, 'Two', 'untargeted step unchanged');
    assert.equal(doc.nodes[2].annotation.title, 'C');
  });
});

describe('annotation and advance', () => {
  test('set_annotation merges rather than replaces', () => {
    const doc = applyOp(fixture(), 'set_annotation', { nodeId: 'n1', kind: 'modal' }).doc;
    assert.equal(doc.nodes[0].annotation.kind, 'modal');
    assert.equal(doc.nodes[0].annotation.title, 'One', 'existing copy survives a kind change');
  });

  test('set_advance to timer keeps a previously set delay when ms is omitted', () => {
    let doc = applyOp(fixture(), 'set_advance', { nodeId: 'n1', on: 'timer', ms: 2500 }).doc;
    doc = applyOp(doc, 'set_advance', { nodeId: 'n1', on: 'timer' }).doc;
    assert.equal(doc.nodes[0].advance.ms, 2500);
  });

  test('every advance mode the player understands is accepted', () => {
    for (const on of CONSTANTS.ADVANCE_MODES) {
      const doc = applyOp(fixture(), 'set_advance', { nodeId: 'n1', on }).doc;
      assert.equal(doc.nodes[0].advance.on, on);
    }
  });
});

describe('ordering', () => {
  test('reorder_steps applies the given order', () => {
    const doc = applyOp(fixture(), 'reorder_steps', { order: ['n3', 'n2', 'n1'] }).doc;
    assert.deepEqual(ids(doc), ['n3', 'n2', 'n1']);
  });

  test('ids left out of the order keep their relative order at the end', () => {
    const doc = applyOp(fixture(), 'reorder_steps', { order: ['n3'] }).doc;
    assert.deepEqual(ids(doc), ['n3', 'n1', 'n2']);
  });

  test('unknown and repeated ids in the order are ignored, losing no steps', () => {
    const doc = applyOp(fixture(), 'reorder_steps', { order: ['n2', 'ghost', 'n2'] }).doc;
    assert.deepEqual(ids(doc), ['n2', 'n1', 'n3']);
  });

  test('move_step places a step at a zero-based index', () => {
    const doc = applyOp(fixture(), 'move_step', { nodeId: 'n1', toIndex: 2 }).doc;
    assert.deepEqual(ids(doc), ['n2', 'n3', 'n1']);
  });

  test('move_step clamps an out-of-range index instead of dropping the step', () => {
    assert.deepEqual(ids(applyOp(fixture(), 'move_step', { nodeId: 'n1', toIndex: 99 }).doc), ['n2', 'n3', 'n1']);
    assert.deepEqual(ids(applyOp(fixture(), 'move_step', { nodeId: 'n3', toIndex: -5 }).doc), ['n3', 'n1', 'n2']);
  });
});

describe('delete_step repairs the flow it breaks', () => {
  test('removes the step', () => {
    const doc = applyOp(fixture(), 'delete_step', { nodeId: 'n2' }).doc;
    assert.deepEqual(ids(doc), ['n1', 'n3']);
  });

  test('an explicit next aimed at the deleted step is redirected past it', () => {
    let doc = applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'n2' }).doc;
    doc = applyOp(doc, 'delete_step', { nodeId: 'n2' }).doc;
    assert.equal(doc.nodes[0].next, 'n3', 'should point at what followed the deleted step');
  });

  test('deleting the last step leaves a dangling pointer null rather than broken', () => {
    let doc = applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'n3' }).doc;
    doc = applyOp(doc, 'delete_step', { nodeId: 'n3' }).doc;
    assert.equal(doc.nodes[0].next, null);
  });

  test('branches pointing at the deleted step are dropped, others kept', () => {
    let doc = applyOp(fixture(), 'set_branches', {
      nodeId: 'n1',
      branches: [
        { label: 'to two', next: 'n2' },
        { label: 'to three', next: 'n3' },
      ],
    }).doc;
    doc = applyOp(doc, 'delete_step', { nodeId: 'n2' }).doc;
    assert.deepEqual(doc.nodes[0].branches, [{ label: 'to three', next: 'n3' }]);
  });

  test('a start step that is deleted falls back to the new first step', () => {
    let doc = fixture();
    doc.settings.startNodeId = 'n1';
    doc = applyOp(doc, 'delete_step', { nodeId: 'n1' }).doc;
    assert.equal(doc.settings.startNodeId, 'n2');
  });

  test('deleting the only step leaves an empty demo, not a broken one', () => {
    let doc = { ...fixture(), nodes: [fixture().nodes[0]] };
    doc.settings.startNodeId = 'n1';
    doc = applyOp(doc, 'delete_step', { nodeId: 'n1' }).doc;
    assert.deepEqual(doc.nodes, []);
    assert.equal(doc.settings.startNodeId, null);
  });
});

describe('duplicate_step', () => {
  test('inserts the copy directly after the original with a fresh id', () => {
    const doc = applyOp(fixture(), 'duplicate_step', { nodeId: 'n1' }).doc;
    assert.deepEqual(ids(doc), ['n1', 'n4', 'n2', 'n3']);
  });

  test('the copy carries the original copy but not its explicit next', () => {
    let doc = applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'n3' }).doc;
    doc = applyOp(doc, 'duplicate_step', { nodeId: 'n1' }).doc;
    const copy = doc.nodes[1];
    assert.equal(copy.annotation.title, 'One');
    assert.equal(copy.next, null, 'a duplicate must not inherit a jump');
  });

  test('the copy is a deep clone, so editing it cannot touch the original', () => {
    const doc = applyOp(fixture(), 'duplicate_step', { nodeId: 'n1' }).doc;
    doc.nodes[1].annotation.title = 'Changed';
    assert.equal(doc.nodes[0].annotation.title, 'One');
  });
});

describe('branches', () => {
  test('set_branches records label and destination in order', () => {
    const doc = applyOp(fixture(), 'set_branches', {
      nodeId: 'n1',
      branches: [
        { label: 'A', next: 'n2' },
        { label: 'B', next: 'n3' },
      ],
    }).doc;
    assert.deepEqual(doc.nodes[0].branches, [
      { label: 'A', next: 'n2' },
      { label: 'B', next: 'n3' },
    ]);
  });

  test('a branch to a step that does not exist is refused outright', () => {
    assert.throws(
      () => applyOp(fixture(), 'set_branches', { nodeId: 'n1', branches: [{ label: 'A', next: 'ghost' }] }),
      /No step with id/,
    );
  });

  test('an empty array removes the fork', () => {
    let doc = applyOp(fixture(), 'set_branches', { nodeId: 'n1', branches: [{ label: 'A', next: 'n2' }] }).doc;
    doc = applyOp(doc, 'set_branches', { nodeId: 'n1', branches: [] }).doc;
    assert.deepEqual(doc.nodes[0].branches, []);
  });
});

describe('overlays', () => {
  test('add_overlay appends and defaults value to an empty string', () => {
    const doc = applyOp(fixture(), 'add_overlay', { nodeId: 'n1', type: 'blur', target: '.revenue' }).doc;
    assert.deepEqual(doc.nodes[0].overlays, [{ type: 'blur', target: '.revenue', value: '' }]);
  });

  test('overlays stack in the order added', () => {
    let doc = applyOp(fixture(), 'add_overlay', { nodeId: 'n1', type: 'blur', target: '.a' }).doc;
    doc = applyOp(doc, 'add_overlay', { nodeId: 'n1', type: 'text', target: '.b', value: 'Acme' }).doc;
    assert.equal(doc.nodes[0].overlays.length, 2);
    assert.equal(doc.nodes[0].overlays[1].value, 'Acme');
  });

  test('clear_overlays empties the list and says how many went', () => {
    let doc = applyOp(fixture(), 'add_overlay', { nodeId: 'n1', type: 'hide', target: '.x' }).doc;
    const out = applyOp(doc, 'clear_overlays', { nodeId: 'n1' });
    assert.deepEqual(out.doc.nodes[0].overlays, []);
    assert.match(out.summary, /1 overlay\b/);
  });
});

describe('variables', () => {
  test('keys are sanitised to letters, numbers and underscore', () => {
    const doc = applyOp(fixture(), 'set_variables', { variables: [{ key: 'com pany-name!' }] }).doc;
    assert.equal(doc.variables[0].key, 'companyname');
  });

  test('label falls back to the key and default to an empty string', () => {
    const doc = applyOp(fixture(), 'set_variables', { variables: [{ key: 'company' }] }).doc;
    assert.deepEqual(doc.variables[0], { key: 'company', label: 'company', default: '' });
  });
});

describe('demo-level settings', () => {
  test('set_meta changes only what it is given', () => {
    const doc = applyOp(fixture(), 'set_meta', { description: 'A tour' }).doc;
    assert.equal(doc.name, 'Fixture', 'name should be untouched');
    assert.equal(doc.description, 'A tour');
  });

  test('set_theme merges into existing branding', () => {
    let doc = applyOp(fixture(), 'set_theme', { accent: '#ff0000' }).doc;
    doc = applyOp(doc, 'set_theme', { radius: 4 }).doc;
    assert.equal(doc.theme.accent, '#ff0000', 'an earlier theme field was dropped');
    assert.equal(doc.theme.radius, 4);
  });

  test('set_settings merges, and accepts false without treating it as absent', () => {
    const doc = applyOp(fixture(), 'set_settings', { showProgress: false, autoplayMs: 2000 }).doc;
    assert.equal(doc.settings.showProgress, false);
    assert.equal(doc.settings.autoplayMs, 2000);
  });

  test('a start step must exist', () => {
    assert.throws(() => applyOp(fixture(), 'set_settings', { startNodeId: 'ghost' }), /No step with id/);
    const doc = applyOp(fixture(), 'set_settings', { startNodeId: 'n2' }).doc;
    assert.equal(doc.settings.startNodeId, 'n2');
  });
});

describe('get_demo outline', () => {
  test('summarises the demo and resolves each step’s real next', () => {
    const out = applyOp(fixture(), 'get_demo', {}).result;
    assert.equal(out.stepCount, 3);
    assert.deepEqual(
      out.steps.map((s) => s.next),
      ['n2', 'n3', null],
      'the outline must show resolved flow, not raw nulls',
    );
  });

  test('reflects an explicit jump so the model sees the real flow', () => {
    const doc = applyOp(fixture(), 'set_next', { nodeId: 'n1', next: 'n3' }).doc;
    const out = applyOp(doc, 'get_demo', {}).result;
    assert.equal(out.steps[0].next, 'n3');
  });

  test('omits overlays entirely when a step has none', () => {
    const out = applyOp(fixture(), 'get_demo', {}).result;
    assert.equal(out.steps[0].overlays, undefined);
  });
});

describe('tool schemas exposed to the model', () => {
  test('every op is offered, and only ops that exist', () => {
    const schemas = toolSchemas();
    assert.equal(schemas.length, Object.keys(OPS).length);
    assert.deepEqual(
      schemas.map((s) => s.function.name).sort(),
      Object.keys(OPS).sort(),
    );
  });

  test('each schema is a well-formed OpenAI function tool', () => {
    for (const s of toolSchemas()) {
      assert.equal(s.type, 'function');
      assert.ok(s.function.description, `${s.function.name} needs a description for the model`);
      assert.equal(s.function.parameters.type, 'object');
      assert.equal(s.function.parameters.additionalProperties, false);
      for (const req of s.function.parameters.required || []) {
        assert.ok(s.function.parameters.properties[req], `${s.function.name} requires "${req}" but never declares it`);
      }
    }
  });
});

describe('clone', () => {
  test('is deep, so nested edits cannot leak back', () => {
    const a = fixture();
    const b = clone(a);
    b.nodes[0].annotation.title = 'Changed';
    assert.equal(a.nodes[0].annotation.title, 'One');
  });
});
