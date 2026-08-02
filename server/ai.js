// The AI passes over a demo.
//
// Whichever provider is connected — OpenAI or Anthropic — is llm.js's business; everything
// here is written once, in the OpenAI request shape, and goes out through callModel(). Four
// entry points:
//   chat()            a copilot that edits the demo through real docops tool-calls
//   autoDraft()       drafts the whole walkthrough from a fresh capture, using the screenshots
//   reviewRecording() watches a take back and cuts what doesn't earn its place
//   rewrite()         a single-field rewrite for the inline editor buttons

import fs from 'node:fs/promises';
import path from 'node:path';
import { OPS, applyOp, toolSchemas } from './docops.js';
import { demoDir, readDemo, writeDemo, clearRedo, withDemoLock } from './store.js';
import { shrinkImages } from './images.js';
import { callModel, resolveModel } from './llm.js';

// Key handling and model choice live with the providers; re-exported so callers keep one
// import for the AI layer.
export { hasKey, resolveModel, resetModelCache, aiStatus, callModel } from './llm.js';

// What the recorder knows about a step, written for a model that has never seen the app.
// The distinction that matters most: the text on the thing that was interacted with is often
// the control's *current value* ("No dates", "Unassigned"), not its name — copy that treats it
// as a command reads as nonsense.
function stepFacts(n, i, total) {
  const ctx = n.pageContext || {};
  const hint = n.targetHint || {};
  const reason = n.capture?.reason;
  const how =
    reason === 'input'
      ? 'typed into a field'
      : reason === 'submit'
        ? 'pressed Enter to commit a field'
        : reason === 'click'
          ? 'clicked something'
          : 'arrived on this screen (no interaction)';

  let acted = '  (screen arrival — nothing was interacted with)';
  if (hint.text || hint.label || hint.control) {
    const kind = hint.control || hint.role || hint.tag || 'element';
    const bits = [`a ${kind}`];
    if (hint.label) bits.push(`labelled "${hint.label}"`);
    if (hint.text && hint.text !== hint.label) bits.push(`showing the text "${hint.text}" (this may be its current VALUE or an empty state, not its name)`);
    acted = `  interacted with: ${bits.join(', ')}`;
  }

  return [
    `[${n.id}] step ${i + 1} of ${total}`,
    `  url: ${n.url}`,
    `  page title: ${n.pageTitle || '—'}`,
    ctx.headings?.length ? `  headings: ${ctx.headings.slice(0, 8).join(' | ')}` : '',
    `  what happened: ${how}`,
    acted,
    n.capture?.value ? `  text that was typed: "${String(n.capture.value).slice(0, 60)}"` : '',
    `  current headline: ${n.annotation?.title || '(none)'}`,
    n.annotation?.body ? `  current body: ${n.annotation.body}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Rules that keep generated copy tied to what a screen actually shows. Shared by the drafting
// pass and the review pass, because copy written by one is judged by the other.
const COPY_RULES = `Naming the action:
- The text on a control is often its current VALUE, not its name. A timeline cell reading
  "No dates", an assignee reading "Unassigned", a field showing what is already in it — none of
  those are commands. Never write copy that reads as if that text were an instruction
  ("Select No dates" is nonsense). Say what the control is for: "Open the timeline picker to
  schedule this task".
- Use only verbs the screen supports. Do not write "Confirm" unless something is actually being
  confirmed or saved on that screen. Do not write "Select X" unless X is a real option in a
  list being chosen.
- Match the verb to what happened: opening a picker, menu or dialog is "Open"; typing is
  "Enter"; choosing from a list is "Choose"; ticking a box is "Turn on"; committing is "Save".
- Work out what a step does by comparing its screen with the step that follows it, and describe
  that effect. If the next screen shows a date picker, this step opens the date picker.
- A step's copy must describe THAT screen. Never describe something only visible later.
- Current headlines are often placeholders the recorder generated from an element's text. If one
  reads as a command built from a value, rewrite it rather than preserving it.`;

const SYSTEM = `You edit interactive product demos.

A demo is an ordered list of steps. Each step is a frozen snapshot of a real screen from the
product, plus an annotation (a tooltip anchored to an element on that screen, a centred modal,
a corner caption, or a bare hotspot). Viewers move through the steps by clicking the
highlighted element, so the copy should tell them what to do and why it matters.

You have tools that read and modify the demo. Rules:
- Call get_demo first unless you already know the current state from this conversation.
- Prefer bulk_set_step_copy over many single edits when changing several steps.
- Never invent product capabilities. Ground every claim in the captured page titles, headings
  and element labels you can see in the demo data.
- Headlines: imperative and short, under about 60 characters. Body: one or two plain sentences.
- Do not put the step number in the copy; the player shows progress on its own.
- Keep {{variable}} tokens intact unless asked to change them.
- Copy renders as plain text in a small tooltip: no markdown, no bullet lists, no line breaks.
  Bodies should be at most two sentences.
- Never change a step's "target" selector unless explicitly asked. Those anchors come from the
  recording and repointing them breaks the demo.

Be concise in your replies. State what you changed, not how tools work. Your reply is shown in
a small chat pane as plain text: no markdown, no **bold**, no bullet characters, no headings.
Write short sentences instead.`;

// Cap the tool loop so a confused model cannot spin forever on the user's key.
const MAX_ROUNDS = 8;

export async function chat({ slug, messages, model }) {
  const startDoc = await readDemo(slug);
  let doc = startDoc;
  const applied = [];

  const convo = [
    { role: 'system', content: SYSTEM },
    // Ground the model in the current demo so trivial questions need no tool round-trip.
    { role: 'system', content: `Current demo state:\n${JSON.stringify(applyOp(doc, 'get_demo', {}).result, null, 1)}` },
    ...messages,
  ];

  const useModel = model || (await resolveModel());
  let reply = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await callModel({
      model: useModel,
      messages: convo,
      tools: toolSchemas(),
      tool_choice: 'auto',
      temperature: 0.4,
    });

    const msg = res.choices?.[0]?.message;
    if (!msg) break;
    convo.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      reply = msg.content || '';
      break;
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {}

      let content;
      try {
        const out = applyOp(doc, name, args);
        if (out.readonly) {
          content = JSON.stringify(out.result);
        } else {
          doc = out.doc;
          applied.push({ op: name, args, summary: out.summary });
          content = JSON.stringify({ ok: true, summary: out.summary });
        }
      } catch (e) {
        content = JSON.stringify({ ok: false, error: e.message });
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  // One write for the whole turn, so the entire AI edit is a single undo. The chat may have
  // taken a while, so re-apply its ops to the doc as it stands now rather than writing back
  // the copy read at the start — that copy would resurrect anything edited away meanwhile.
  if (applied.length) {
    doc = await withDemoLock(slug, async () => {
      let fresh = await readDemo(slug);
      for (const a of applied) {
        try {
          fresh = applyOp(fresh, a.op, a.args).doc;
        } catch {} // the step it targeted was deleted mid-chat; skip that edit
      }
      await clearRedo(slug);
      return writeDemo(slug, fresh, { history: true });
    });
  }

  return { reply, applied, doc: applied.length ? doc : startDoc, model: useModel };
}

// ---------------------------------------------------------------- autodraft

const DRAFT_SYSTEM = `You write the script for an interactive product demo.

You will see, for each captured step: the page URL and title, the headings and navigation
labels on that screen, what the user clicked to move on, and a screenshot of the screen.

Write a walkthrough that a prospect who has never seen this product could follow. For each
step produce a headline and a body. The headline should say what to do or what to notice; the
body should say why it matters, in plain language and without marketing filler.

Ground everything in what is actually visible. Never claim a feature you cannot see. If a step
is just a navigation transition, keep the copy brief and orienting.

${COPY_RULES}

Never quote sample data that was typed; name the field instead.

Return an entry for EVERY step id you are given, including ones with no screenshot.

This copy renders inside a small tooltip, roughly 300 pixels wide, as plain text. So:
- PLAIN TEXT ONLY. No markdown, no **bold**, no bullet lists, no headings, no line breaks.
- Headline: under 55 characters.
- Body: at most two sentences and under 200 characters. Shorter is better.
- Name specific things you can see (a panel, a tab, a button) rather than listing all of them.

Also produce a short demo title and a one-line description.`;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['nodeId', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'description', 'steps'],
  additionalProperties: false,
};

// keepDescription: the demo's description is the brief someone wrote and re-records from, so
// an AI-driven recording must not overwrite it with a generated blurb.
// scope: node ids whose copy may be rewritten. A recording pass limits this to the steps it
// just shot, so adding to a demo never rewords the steps already written and approved.
export async function autoDraft({ slug, guidance = '', model, keepDescription = false, scope = null }) {
  const doc = await readDemo(slug);
  if (!doc.nodes.length) throw new Error('Nothing to draft — record some steps first.');
  const writable = scope?.length ? new Set(scope) : null;
  if (writable && !doc.nodes.some((n) => writable.has(n.id))) return { doc, draft: null };

  const dir = demoDir(slug);
  const content = [
    {
      type: 'text',
      text:
        `Product demo with ${doc.nodes.length} captured steps.` +
        (guidance ? `\n\nThe person recording it says: ${guidance}` : '') +
        `\n\nSteps:\n` +
        doc.nodes.map((n, i) => stepFacts(n, i, doc.nodes.length)).join('\n'),
    },
  ];

  // Attach screenshots so the model can describe what is genuinely on screen. Capped to keep
  // the request affordable on a long recording.
  const withShots = doc.nodes.filter((n) => n.shot).slice(0, 24);
  for (const n of withShots) {
    try {
      const buf = await fs.readFile(path.join(dir, n.shot));
      content.push({ type: 'text', text: `Screenshot of ${n.id}:` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${buf.toString('base64')}`, detail: 'low' },
      });
    } catch {}
  }

  const res = await callModel({
    model: model || (await resolveModel()),
    messages: [
      { role: 'system', content: DRAFT_SYSTEM },
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'demo_script', schema: DRAFT_SCHEMA, strict: true },
    },
    temperature: 0.6,
  });

  const draft = JSON.parse(res.choices[0].message.content);

  // The model call above took a while — apply the draft to the doc as it stands now, and only
  // to steps that still exist, so edits made in the editor meanwhile are kept.
  const next = await withDemoLock(slug, async () => {
    const fresh = await readDemo(slug);
    // Retitling the demo is only this pass's business when it drafted the whole thing.
    // Appending a few steps must not rename a demo off the back of them.
    const wholeDemo = !writable || fresh.nodes.every((n) => writable.has(n.id));
    let out = wholeDemo
      ? applyOp(fresh, 'set_meta', {
          name: plain(draft.name),
          ...(keepDescription ? {} : { description: plain(draft.description) }),
        }).doc
      : fresh;
    const valid = new Set(fresh.nodes.map((n) => n.id));
    out = applyOp(out, 'bulk_set_step_copy', {
      steps: (draft.steps || [])
        .filter((s) => valid.has(s.nodeId) && (!writable || writable.has(s.nodeId)))
        .map((s) => ({ nodeId: s.nodeId, title: plain(s.title), body: plain(s.body) })),
    }).doc;

    await clearRedo(slug);
    await writeDemo(slug, out, { history: true });
    return out;
  });
  return { doc: next, draft };
}

// Tooltips render as plain text in a narrow card. Models reach for markdown by habit, so
// strip it rather than trusting the prompt alone — literal asterisks in a demo look broken.
function plain(s) {
  return String(s ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)[*_`](\S[^*_`]*?)[*_`](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s*[-•*]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ------------------------------------------------------------------- review

// An AI-driven recording is a first take: it contains mis-clicks, screens that went nowhere,
// duplicated views and the occasional error state. This pass watches the take back — every
// screenshot, in order — and decides per step whether it earns its place, then makes the copy
// describe what is actually on that screen.

const REVIEW_SYSTEM = `You are reviewing a recorded product demo before it ships, like an editor
watching raw footage.

You see every captured step in order: its screenshot, the page it was on, what the user clicked
to leave it, and the copy currently written on it. Judge each step and return a verdict for
EVERY step id you are given.

What the finished tutorial has to be, and what you are accountable for:
1. EVERY LABEL MATCHES ITS STEP. The headline and body must describe the action actually taken
   on that exact screen. A step whose copy describes a different screen, a different control, or
   an action that did not happen is wrong and must be rewritten — this is the failure that
   matters most.
2. NO ERRORS SURVIVE. Anything that shows a mistake — an error message, a validation complaint,
   a failed or empty result, a wrong turn the recording backs out of, a value that was set
   incorrectly and never fixed — is removed, not explained away.
3. IT READS AS ONE CLEAN TUTORIAL. Someone who has never seen this product should be able to
   follow it start to finish without confusion: each step follows naturally from the one before,
   nothing is repeated, nothing is skipped over, and the sequence reaches the stated goal.
4. EVERYTHING MAKES SENSE. If a step's purpose is not obvious from its own screen, either write
   copy that makes it obvious or drop it. Never leave a step the viewer would stare at and
   wonder why it is there.
5. NOTHING IS DEMONSTRATED TWICE. A tutorial shows a pattern once and moves on.

Repetition is the most common way a recording gets boring, and it is your job to cut it:
- When the same action is repeated across further items — a second and third task created the
  same way, hours entered row after row, the same field filled down a list — keep the first
  complete demonstration and DROP the repeats. Two steps showing one task being named and saved
  teach everything three tasks would.
- Keep a repeat only when it genuinely shows something new: a different control, a different
  outcome, or a variation the viewer could not infer from the first time.
- After cutting repeats, the surviving copy must not refer to positions that no longer exist.
  Never say "the second task" when the first was cut, or "the third estimate" when only one is
  shown. Describe the action plainly: "Enter the planned hours for the task".
- Prefer cutting the later repeats, so what remains is the first, cleanest example.

Give "drop" to steps that hurt the tutorial:
- a mis-click or wrong turn that the recording then backtracks from
- a screen showing an error, an empty failed state, or a validation complaint
- a duplicate: the same screen as the step before it with nothing meaningfully changed
- a dead end that does not move the story forward
- a modal or menu that was opened and abandoned without being used
- an action that produced no visible result on the screen that follows it
- a step whose purpose cannot be explained from its own screen
- a repeat of something already demonstrated: the second, third and later time the same action
  is performed on another item, with nothing new to show

Give "keep" or "edit" to steps that belong. Prefer "edit" whenever the copy could be better:

- The copy MUST describe what is genuinely visible in that step's screenshot. If it names a
  button, panel or value that is not on screen, rewrite it. This is the most important rule:
  the words and the picture must agree.
- Headline: imperative, under 55 characters, plain text. Body: one or two short sentences
  saying why the step matters. Never quote sample data that was typed; name the field instead.

${COPY_RULES}
- Read as one continuous tutorial: consecutive steps should not repeat the same sentence, and
  the sequence should flow from opening to result.
- No markdown, no bullet lists, no line breaks.

Be conservative with "drop": a step that is merely ordinary is a "keep". Never drop so much
that the tutorial no longer demonstrates its stated goal.`;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One sentence on the state of the take and what you changed.' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          verdict: { type: 'string', enum: ['keep', 'edit', 'drop'] },
          reason: { type: 'string', description: 'Short justification, shown to the user.' },
          confidence: {
            type: ['integer', 'null'],
            description: 'For "drop" only: 1-5, how certain you are this step hurts the tutorial. 5 = an obvious error screen or exact duplicate. Null otherwise.',
          },
          title: { type: ['string', 'null'], description: 'Required for "edit", else null.' },
          body: { type: ['string', 'null'], description: 'Required for "edit", else null.' },
        },
        required: ['nodeId', 'verdict', 'reason', 'confidence', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'steps'],
  additionalProperties: false,
};

// A review that guts the demo is worse than no review, and a model that misreads an unfamiliar
// app can be confidently wrong. Never remove more than this share of the take, and always leave
// enough steps to still be a tutorial. A first take really can be half junk, so the ceiling is
// deliberately not stingy — the floor is what does the protecting.
const MAX_DROP_SHARE = 0.5;
const MIN_KEPT_STEPS = 3;
const REVIEW_SHOT_CAP = 30;

// Steps judged per request. Small enough that the first progress update arrives quickly and
// no single call carries an unwieldy pile of images.
const REVIEW_BATCH = 6;

export async function reviewRecording({ slug, scenario = '', model, scope = null, onProgress = () => {} }) {
  const doc = await readDemo(slug);
  if (!doc.nodes.length) throw new Error('Nothing to review — record some steps first.');

  // Steps this pass is allowed to touch. Everything else is context it can read but never
  // rewrite or delete, so appending a take cannot prune the ones already signed off on.
  const inScope = scope?.length ? doc.nodes.filter((n) => scope.includes(n.id)) : doc.nodes;
  if (!inScope.length) {
    return { doc, summary: '', dropped: [], edited: 0, kept: doc.nodes.length, refused: 0 };
  }

  const dir = demoDir(slug);
  const useModel = model || (await resolveModel());

  // Every batch gets the whole story as text, so judging "is this a duplicate of the step
  // before it" or "does this dead-end" still has the full arc to reason about. Only the
  // screenshots are batched, because they are what makes a request heavy.
  const outline =
    `Demo: ${doc.name || slug}\n` +
    (scenario || doc.description ? `It is meant to demonstrate: ${scenario || doc.description}\n` : '') +
    `\n${doc.nodes.length} captured steps, in order:\n` +
    doc.nodes.map((n, i) => stepFacts(n, i, doc.nodes.length)).join('\n');

  const shotNodes = inScope.filter((n) => n.shot).slice(0, REVIEW_SHOT_CAP);
  onProgress({ done: 0, total: shotNodes.length, message: 'Preparing screenshots…' });

  // Shrink once, up front: the same image is never sent twice, and this is what keeps a long
  // review from spending minutes uploading.
  const buffers = [];
  for (const n of shotNodes) {
    try {
      buffers.push({ id: n.id, buffer: await fs.readFile(path.join(dir, n.shot)) });
    } catch {}
  }
  const shots = await shrinkImages(buffers);

  const batches = [];
  for (let i = 0; i < inScope.length; i += REVIEW_BATCH) batches.push(inScope.slice(i, i + REVIEW_BATCH));

  const verdictsRaw = [];
  let summary = '';
  for (const [bi, batch] of batches.entries()) {
    const from = bi * REVIEW_BATCH + 1;
    const to = from + batch.length - 1;
    onProgress({ done: from - 1, total: inScope.length, message: `Reviewing steps ${from}–${to} of ${inScope.length}…` });

    const content = [
      {
        type: 'text',
        text:
          `${outline}\n\nJudge ONLY these step ids in this pass: ${batch.map((n) => n.id).join(', ')}.\n` +
          `Return one verdict for each of them. The other steps are listed above purely as context.`,
      },
    ];
    for (const n of batch) {
      if (!shots[n.id]) continue;
      content.push({ type: 'text', text: `Screenshot of ${n.id}:` });
      content.push({ type: 'image_url', image_url: { url: shots[n.id], detail: 'low' } });
    }
    const missing = batch.filter((n) => !shots[n.id]);
    if (missing.length) {
      content.push({
        type: 'text',
        text: `No screenshot available for: ${missing.map((n) => n.id).join(', ')}. Judge those from the text alone and prefer "keep" unless it shows a clear problem.`,
      });
    }

    const res = await callModel({
      model: useModel,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'demo_review', schema: REVIEW_SCHEMA, strict: true } },
      temperature: 0.2,
    });
    const part = JSON.parse(res.choices[0].message.content);
    const ids = new Set(batch.map((n) => n.id));
    for (const s of part.steps || []) if (ids.has(s.nodeId)) verdictsRaw.push(s);
    if (part.summary && !summary) summary = part.summary;
  }

  onProgress({ done: inScope.length, total: inScope.length, message: 'Applying changes…' });
  const review = { summary, steps: verdictsRaw };
  // A verdict only counts for a step this pass was allowed to touch.
  const valid = new Map(inScope.map((n) => [n.id, n]));
  const verdicts = (review.steps || []).filter((s) => valid.has(s.nodeId));

  // When the cap bites, cut the steps the model was surest about rather than whichever came
  // first — an obvious error screen should not survive because two mis-clicks preceded it.
  const order = new Map(doc.nodes.map((n, i) => [n.id, i]));
  const wanted = verdicts
    .filter((s) => s.verdict === 'drop')
    .sort((a, b) => (b.confidence ?? 3) - (a.confidence ?? 3) || order.get(a.nodeId) - order.get(b.nodeId));
  // Both ceilings are measured against what this pass may touch, never the whole demo: a pass
  // over 3 new steps must not be handed a budget to delete half of a 27-step recording.
  const allowed = Math.max(
    0,
    Math.min(Math.floor(inScope.length * MAX_DROP_SHARE), doc.nodes.length - MIN_KEPT_STEPS),
  );
  const dropping = wanted.slice(0, allowed);
  const refused = wanted.length - dropping.length;

  const edits = verdicts
    .filter((s) => s.verdict === 'edit' && !dropping.some((d) => d.nodeId === s.nodeId))
    .map((s) => ({ nodeId: s.nodeId, ...(s.title ? { title: plain(s.title) } : {}), ...(s.body ? { body: plain(s.body) } : {}) }))
    .filter((s) => s.title || s.body);

  // The review itself ran for a minute or more — apply its verdicts to the doc as it stands
  // now, dropping verdicts whose steps the user already removed, so nothing edited away in
  // the meantime gets written back.
  const applied = await withDemoLock(slug, async () => {
    const fresh = await readDemo(slug);
    const have = new Set(fresh.nodes.map((n) => n.id));
    const dropNow = dropping.filter((s) => have.has(s.nodeId));
    const editNow = edits.filter((s) => have.has(s.nodeId));
    let next = fresh;
    for (const s of dropNow) next = applyOp(next, 'delete_step', { nodeId: s.nodeId }).doc;
    if (editNow.length) next = applyOp(next, 'bulk_set_step_copy', { steps: editNow }).doc;
    if (dropNow.length || editNow.length) {
      await clearRedo(slug);
      await writeDemo(slug, next, { history: true });
    }
    return { next, dropNow, editNow };
  });

  return {
    doc: applied.next,
    summary: review.summary || '',
    dropped: applied.dropNow.map((s) => ({ nodeId: s.nodeId, reason: s.reason })),
    edited: applied.editNow.length,
    kept: applied.next.nodes.length,
    refused,
  };
}

// ------------------------------------------------------------------ rewrite

const REWRITE_ACTIONS = {
  shorten: 'Make it noticeably shorter while keeping the meaning.',
  expand: 'Add one more sentence of useful, concrete detail.',
  punchy: 'Rewrite it to be more direct and energetic. No hype words.',
  formal: 'Rewrite it in a more formal, professional register.',
  friendly: 'Rewrite it in a warmer, more conversational register.',
  fix: 'Fix spelling, grammar and punctuation. Change nothing else.',
};

export async function rewrite({ text, action = 'shorten', instruction = '', context = '', model }) {
  if (!text?.trim()) throw new Error('Nothing to rewrite.');
  const how = instruction || REWRITE_ACTIONS[action] || REWRITE_ACTIONS.shorten;

  const res = await callModel({
    model: model || (await resolveModel()),
    messages: [
      {
        role: 'system',
        content:
          'You rewrite short copy for interactive product demos. Reply with the rewritten text only — no quotes, no preamble, no explanation.',
      },
      {
        role: 'user',
        content: `${how}\n\n${context ? `Context: this is shown on a demo step about "${context}".\n\n` : ''}Text:\n${text}`,
      },
    ],
    temperature: 0.6,
  });

  return { text: plain(res.choices[0].message.content) };
}

export const AI_ACTIONS = Object.keys(REWRITE_ACTIONS);
export const OP_NAMES = Object.keys(OPS);
