// AI autopilot: an agent that drives the recording browser itself.
//
// You give it a scenario ("create a project for a beverage client and assign two tasks"),
// optionally product docs and sign-in credentials, and it runs the tutorial for real: it reads
// the live page, decides one action at a time, and performs it with real trusted input events.
//
// That last part is what makes this module small. Because the agent clicks and types the way a
// human does, the ordinary recorder pipeline sees ordinary interactions: the arming gate keeps
// the sign-in out of the demo, every click is captured pre-action with its click point, typed
// values are recorded for playback re-enactment, and whole controls get tagged. The agent
// drives; the existing machinery records.
//
// Credentials live in this process's memory for the duration of the run and are passed only to
// the model so it can fill the sign-in form. They are never written to disk or into the log —
// and the sign-in screens they are typed into are never captured (the session is unarmed
// there). Passwords in later, recorded steps are already masked by the serializer.

import { callModel, resolveModel } from './llm.js';
import { polishDemo } from './polish.js';
import { readDemo, writeDemo, withDemoLock } from './store.js';
import { startCapture, stopCapture, activeSession, waitForSettled } from './capture.js';

const MAX_ACTIONS_DEFAULT = 40;
const MAX_CONSECUTIVE_FAILURES = 3;

// What each demo was last driven with, so re-recording does not re-interrogate the user.
// Process memory only: this is never written to disk and dies with the studio, which keeps the
// promise made in the UI. Re-recording usually needs no password anyway — the browser profile
// per demo stays signed in — so this is a fallback for when the session has expired.
const lastRun = new Map();

export function rememberedRun(slug) {
  const r = lastRun.get(slug);
  return r ? { docsUrl: r.docsUrl || '', email: r.credentials?.email || '', hasPassword: !!r.credentials?.password } : null;
}

const DRIVER_SYSTEM = `You drive a real web browser to record an interactive product demo.

You are given a scenario to demonstrate, optionally product documentation, and possibly
sign-in credentials. Each turn you see the current page — URL, title, headings, visible text,
its interactive elements, and a screenshot — and you reply with exactly ONE next action.

Rules:
- If a sign-in screen appears, sign in with the provided credentials. Sign-in is not recorded,
  so just get through it without ceremony.
- Then demonstrate the scenario the way a careful, competent user would: navigate to the right
  place and click through the flow one deliberate step at a time.
- Fill forms with realistic data that fits the scenario — real-looking names, clients, dates,
  amounts. Never type placeholder junk like "test", "asdf" or "123".
- Follow the documentation's intended flow when you are unsure what to do next.
- One action per turn. Prefer clicking visible elements over typing URLs.
- Every click and form entry you make becomes a step of the demo, so avoid dead ends and
  exploratory clicking. If an action failed, read the page again and take a different route.
- To set a dropdown, use the "select" action with the element's ref and the option's exact
  visible text. NEVER click a <select> and then click an option — a native dropdown opens in
  the operating system, not the page, so clicking it does nothing and wastes a step.
- Apps do real work in the background — an in-app AI assistant writing a brief or creating a
  project, an import, a report being generated. That work can take 30 seconds or more. Be
  patient the way a real user would: while the page shows work still in progress (a spinner, a
  "thinking" or "working" indicator, a streaming reply, a result that has not appeared yet),
  use "wait" with how many seconds to wait — again and again if needed. Waits are never
  recorded as steps, so waiting too long costs nothing; acting too early ruins the take.
- React only when the result has actually appeared. Never "move on" by clicking a
  similar-looking item that already existed before the work started — what you are waiting
  for usually was not on the page yet. Prefer the link or button the finished work itself
  presents (for example in the assistant's reply) over lookalikes elsewhere on the page.
- When the scenario has been fully demonstrated, use the "done" action. If you are stuck or
  going in circles, use "done" with a note saying why rather than flailing. Waiting for the
  app to finish visible work is not "going in circles" — that is the product working.

Each action also carries the copy a viewer will read on that step of the finished demo. Write
it for someone being taught the product, describing the action in the product's own words:
"Enter the project name", "Choose the client", "Add the task details", "Assign hours to the
task", "Assign it to a teammate". Never quote the sample data you typed, never mention refs,
elements or yourself, and keep the headline under 55 characters. The optional body adds one
short sentence on why the step matters.`;

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'One short sentence: what you are doing and why. Shown in the studio log. Never include credentials.' },
    action: { type: 'string', enum: ['click', 'fill', 'select', 'press', 'goto', 'wait', 'done'] },
    ref: { type: ['integer', 'null'], description: 'Element ref for click/fill/select.' },
    value: {
      type: ['string', 'null'],
      description: 'Text for fill, exact option text for select, key name for press, URL for goto, seconds to wait for wait (e.g. "15"; up to 30 — pick enough to let the app finish).',
    },
    stepTitle: {
      type: ['string', 'null'],
      description: 'Imperative headline the demo viewer reads on this step, e.g. "Enter the project name". Under 55 characters. Null for non-recorded actions like wait or done.',
    },
    stepBody: { type: ['string', 'null'], description: 'One short sentence on why this step matters, or null.' },
  },
  required: ['thought', 'action', 'ref', 'value', 'stepTitle', 'stepBody'],
  additionalProperties: false,
};

// Compact, ref-addressed view of the live page. Refs are written into the DOM so the chosen
// element can be found again reliably; they are re-assigned on every observation.
async function observe(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-ap-ref]')) el.removeAttribute('data-ap-ref');
    const sel =
      'button, a[href], input, select, textarea, summary, [onclick], [role="button"], [role="link"], ' +
      '[role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="switch"]';
    const out = [];
    let ref = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.bottom < 0 || r.top > innerHeight * 1.5) continue; // on or just below the fold
      // A closed drawer parks its controls just outside the viewport or under visibility:
      // hidden; offering those to the agent lets it "type" into fields no viewer can see.
      if (r.right <= 0 || r.left >= innerWidth) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacityProperty: true })) continue;
      ref++;
      el.setAttribute('data-ap-ref', String(ref));
      const tag = el.tagName.toLowerCase();
      // A <select>'s innerText is every option run together, which reads as noise and hides
      // the field's real name. List its options explicitly instead so the agent can pick one.
      const isSelect = tag === 'select';
      out.push({
        ref,
        tag,
        type: el.type || undefined,
        role: el.getAttribute('role') || undefined,
        text: isSelect
          ? (el.getAttribute('aria-label') || el.name || '').trim().slice(0, 80) || undefined
          : (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80) || undefined,
        options: isSelect ? [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 40) : undefined,
        selected: isSelect ? el.selectedOptions[0]?.text.trim() : undefined,
        value: !isSelect && el.value ? String(el.value).slice(0, 60) : undefined,
        placeholder: el.placeholder || undefined,
        disabled: el.disabled || undefined,
      });
      if (out.length >= 120) break;
    }
    return {
      url: location.href,
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 10),
      text: document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 1800),
      elements: out,
    };
  });
}

async function fetchDocs(docsUrl) {
  if (!docsUrl) return '';
  try {
    const res = await fetch(docsUrl, { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 6000);
  } catch (e) {
    return `(docs could not be fetched: ${e.message})`;
  }
}

// "Timeout 8000ms exceeded" tells the model nothing it can act on. Say what actually stopped
// the click — the element re-rendered away mid-click, or something is drawn on top of it — so
// the next decision fixes the real problem instead of retrying the same doomed click.
async function clickFailure(page, sel, e) {
  const gone = !(await page.locator(sel).count().catch(() => 1));
  if (gone) return 'the page re-rendered mid-click and the element is gone — read the page again';
  const cover = e.message.match(/<[^>\n]{0,80}>(?=[^<]*intercepts pointer events)/g)?.pop();
  if (cover) return `the element is covered by ${cover.slice(0, 60)} — deal with what is on top first (dismiss it, or use it if it is the thing you need)`;
  return `click did not land: ${e.message.split('\n')[0]}`;
}

// In-app AI work (an assistant building a project, a generator writing a brief) routinely
// takes 25-30 seconds; the cap only bounds a single turn, and the model waits again if the
// work is still going.
function waitSecs(decision) {
  return Math.min(30, Math.max(1, Number(decision.value) || 5));
}

// Live apps re-render between the observation and the action, and a re-created element loses
// the ref attribute that was stamped on its predecessor — the click would then wait out its
// whole timeout on a selector that can never match again. Re-read the page and find the same
// element again by identity (tag plus visible text or placeholder).
async function refindRef(page, decision, obs) {
  const was = obs?.elements?.find((e) => e.ref === decision.ref);
  const name = was?.text || was?.placeholder || '';
  const fresh = await observe(page);
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const match =
    was &&
    norm(name) &&
    fresh.elements.find((e) => e.tag === was.tag && (norm(e.text) === norm(was.text) ? norm(e.text) : norm(e.placeholder) && norm(e.placeholder) === norm(was.placeholder)));
  if (!match) throw new Error(`the page changed and [${decision.ref}]${name ? ` "${name.slice(0, 40)}"` : ''} is no longer on it — read the page again`);
  return `[data-ap-ref="${match.ref}"]`;
}

async function act(page, decision, obs) {
  // The schema forces a ref field on every action, so ignore strays on wait/press/goto/done.
  const usesRef = decision.action === 'click' || decision.action === 'fill' || decision.action === 'select';
  let sel = usesRef && decision.ref ? `[data-ap-ref="${decision.ref}"]` : null;
  if (sel && !(await page.locator(sel).count())) sel = await refindRef(page, decision, obs);
  switch (decision.action) {
    case 'click':
      if (!sel) throw new Error('click needs a ref');
      try {
        await page.click(sel, { timeout: 8000 });
      } catch (e) {
        throw new Error(await clickFailure(page, sel, e));
      }
      return;
    case 'select': {
      if (!sel) throw new Error('select needs a ref');
      const loc = page.locator(sel);
      const want = String(decision.value ?? '');
      // Click first so the recorder captures the dropdown as the user found it, then set the
      // value through the real select machinery — a native dropdown's list is drawn by the OS
      // and cannot be clicked in the page.
      await loc.click({ timeout: 8000 }).catch(() => {});
      const options = await loc.evaluate((el) => [...el.options].map((o) => ({ text: o.text.trim(), value: o.value })));
      const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const match =
        options.find((o) => norm(o.text) === norm(want)) ||
        options.find((o) => norm(o.text).includes(norm(want))) ||
        options.find((o) => norm(want).includes(norm(o.text)) && o.text.trim());
      if (!match) throw new Error(`no option matching "${want}" (options: ${options.map((o) => o.text).join(' | ').slice(0, 200)})`);
      await loc.selectOption({ value: match.value });
      // selectOption fires change, but only a trusted one when it originates in the browser;
      // Playwright's does count as trusted, so the recorder captures this as an input step.
      return;
    }
    case 'fill': {
      if (!sel) throw new Error('fill needs a ref');
      const loc = page.locator(sel);
      // Focus rather than click: a click on the field is itself an interaction the recorder
      // captures, which would make every text entry cost two nearly identical steps. Typing
      // with real key events still produces the trusted change event that becomes the step.
      await loc.focus({ timeout: 8000 });
      await loc.fill('');
      await loc.pressSequentially(String(decision.value ?? ''), { delay: 25 });
      await page.keyboard.press('Tab'); // commit — fires the (trusted) change the recorder listens for
      return;
    }
    case 'press':
      await page.keyboard.press(decision.value || 'Enter');
      return;
    case 'goto': {
      const dest = new URL(decision.value, page.url());
      if (dest.origin !== new URL(page.url()).origin) throw new Error('goto is limited to the app being recorded');
      await page.goto(dest.href, { waitUntil: 'domcontentloaded' });
      return;
    }
    case 'wait':
      await page.waitForTimeout(waitSecs(decision) * 1000);
      return;
    default:
      throw new Error(`Unknown action ${decision.action}`);
  }
}

// Fire-and-forget from the API's point of view: starts the capture session, then runs the
// agent loop in the background, narrating into the session log the studio already polls.
export async function startAutopilot({ slug, scenario, docsUrl, credentials, maxActions, complete }) {
  const doc = await readDemo(slug);
  if (!doc.startUrl) throw new Error('This demo has no start URL.');

  // The scenario is the demo's brief, so it lives on the demo itself — visible and editable in
  // the Demo pane, and the thing Re-record shoots from. Keeping it only in memory meant the
  // brief was lost on restart and the AI's generated blurb took its place.
  if (scenario && doc.description !== scenario) {
    await withDemoLock(slug, async () => {
      const d = await readDemo(slug);
      d.description = scenario;
      await writeDemo(slug, d, { history: false });
    });
  }

  // Fill any gaps from the previous run, then remember this one for the next re-record.
  const prev = lastRun.get(slug);
  const creds = {
    email: credentials?.email || prev?.credentials?.email || '',
    password: credentials?.password || prev?.credentials?.password || '',
  };
  const docs = docsUrl ?? prev?.docsUrl ?? null;
  lastRun.set(slug, { scenario, docsUrl: docs, credentials: creds });
  await startCapture({ slug, url: doc.startUrl, viewport: undefined });
  const session = activeSession();
  session.mode = 'auto';
  session.note('AI autopilot: reading the docs and taking the wheel.');

  runLoop({ session, scenario, docsUrl: docs, credentials: creds, maxActions, complete }).catch((e) => {
    session.note(`AI autopilot failed: ${e.message}`);
  });

  return session.toJSON();
}

async function runLoop({ session, scenario, docsUrl, credentials, maxActions = MAX_ACTIONS_DEFAULT, complete }) {
  const page = session.page;
  const docs = await fetchDocs(docsUrl);
  const model = complete ? null : await resolveModel();
  const history = [];
  const startSteps = session.stepCount;
  let failures = 0;
  let sawArmed = false;
  let finished = 'ran out of actions';

  const decide =
    complete ||
    (async (messages) => {
      const res = await callModel({
        model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'browser_action', schema: ACTION_SCHEMA, strict: true },
        },
        temperature: 0.3,
      });
      return JSON.parse(res.choices[0].message.content);
    });

  for (let turn = 0; turn < maxActions; turn++) {
    if (session.status !== 'recording' || page.isClosed?.()) {
      finished = 'the recording was stopped';
      break;
    }

    // Landing on the start page arms recording only after a settle window. Don't act inside
    // it — the first real interactions of the tutorial would go unrecorded.
    for (let i = 0; i < 12 && !session.armed && session.urlMatches(page.url()); i++) {
      await page.waitForTimeout(300).catch(() => {});
    }
    // And once armed, let its capture of the start page land before acting, so the demo's
    // first step is the screen, not the agent's first click on it.
    if (!sawArmed && session.armed) {
      sawArmed = true;
      const before = session.stepCount;
      for (let i = 0; i < 10 && session.stepCount === before; i++) await page.waitForTimeout(300).catch(() => {});
      await Promise.resolve(session.queue).catch(() => {});
    }

    let obs;
    try {
      obs = await observe(page);
    } catch (e) {
      session.note(`AI: page not readable (${e.message}), waiting…`);
      await page.waitForTimeout(1500).catch(() => {});
      continue;
    }

    let shot = null;
    try {
      shot = (await page.screenshot({ type: 'jpeg', quality: 55 })).toString('base64');
    } catch {}

    // The conversation is rebuilt every turn — one observation, one screenshot, a running
    // action log — so a long tutorial never snowballs the context.
    const messages = [
      { role: 'system', content: DRIVER_SYSTEM },
      {
        role: 'system',
        content:
          `Scenario to demonstrate:\n${scenario}\n\n` +
          (docs ? `Product documentation (extract):\n${docs}\n\n` : '') +
          (credentials?.email || credentials?.password
            ? `Sign-in credentials — use ONLY on sign-in screens:\nemail/username: ${credentials.email || ''}\npassword: ${credentials.password || ''}`
            : 'No credentials were provided; if a sign-in screen blocks you, use "done" and say so.'),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              (history.length ? `Actions so far:\n${history.join('\n')}\n\n` : '') +
              `Current page:\nurl: ${obs.url}\ntitle: ${obs.title}\nheadings: ${obs.headings.join(' | ')}\n\n` +
              `Visible text:\n${obs.text}\n\n` +
              `Interactive elements:\n${obs.elements
                .map((e) => `[${e.ref}] ${e.tag}${e.type ? `:${e.type}` : ''}${e.role ? ` role=${e.role}` : ''}${e.disabled ? ' (disabled)' : ''} ${e.text || e.placeholder || ''}`.trim())
                .join('\n')}\n\nWhat is your next action?`,
          },
          ...(shot ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot}`, detail: 'low' } }] : []),
        ],
      },
    ];

    let decision;
    try {
      decision = await decide(messages, obs);
    } catch (e) {
      session.note(`AI: model call failed (${e.message})`);
      if (++failures >= MAX_CONSECUTIVE_FAILURES) {
        finished = 'the model kept failing';
        break;
      }
      continue;
    }

    session.note(`AI: ${decision.thought || decision.action}`);
    if (decision.action === 'done') {
      finished = decision.thought || 'scenario complete';
      break;
    }

    try {
      // Hand the step's copy to the recorder before acting, so the step this produces is
      // labelled with the intent rather than with whatever the button happened to say.
      session.setIntent(
        decision.stepTitle?.trim()
          ? { title: decision.stepTitle.trim().slice(0, 80), body: (decision.stepBody || '').trim().slice(0, 200) }
          : null,
      );
      await act(page, decision, obs);
      failures = 0;
      history.push(
        `${turn + 1}. ${decision.action}${decision.ref ? ` [${decision.ref}]` : ''}${
          decision.action === 'fill' ? ` "${String(decision.value ?? '').slice(0, 40)}"` : decision.action === 'wait' ? ` ${waitSecs(decision)}s` : ''
        } — ${decision.thought}`,
      );
    } catch (e) {
      history.push(`${turn + 1}. ${decision.action} FAILED: ${e.message.split('\n')[0].slice(0, 120)}`);
      session.note(`AI: action failed — ${e.message.split('\n')[0].slice(0, 80)}`);
      if (++failures >= MAX_CONSECUTIVE_FAILURES) {
        finished = 'actions kept failing';
        break;
      }
    }

    // An intercepted click is only replayed to the app after its capture finishes, so drain
    // the capture queue first — observing before that would show the agent a stale page.
    await Promise.resolve(session.queue).catch(() => {});
    session.setIntent(null); // never let this action's copy leak onto a later step
    // Same settle the recorder uses, so the agent reads a finished page — and so its next
    // click lands on a screen that is done drawing.
    await waitForSettled(page).catch(() => {});
  }

  const recorded = session.stepCount - startSteps;
  session.note(`AI autopilot finished: ${finished} (${recorded} step${recorded === 1 ? '' : 's'} recorded).`);

  // Read what this run shot before the session is torn down; the polish below is confined to
  // it so a top-up run cannot prune or reword the take already in the demo.
  const shot = session.recordedNodeIds();

  // Give the capture queue a beat to flush the last step, then close the browser.
  await page.waitForTimeout(1500).catch(() => {});
  await stopCapture().catch(() => {});

  // The tutorial exists; now write its story. Same drafting pass the studio offers after a
  // manual recording, seeded with the scenario so the copy matches the intent.
  // Write the story, then read the take back and clean it up. Shared with hand-driven
  // recordings, and reported through the same watchable job so the studio can show progress.
  if (shot.length && !complete) {
    try {
      session.note('AI autopilot: writing the story and reviewing the take…');
      const r = await polishDemo({ slug: session.slug, scenario, draft: true, scope: shot });
      const bits = [];
      if (r.dropped.length) bits.push(`removed ${r.dropped.length} bad step${r.dropped.length === 1 ? '' : 's'}`);
      if (r.edited) bits.push(`polished ${r.edited}`);
      session.note(`AI autopilot: polish done — ${bits.join(', ') || 'nothing needed changing'} (${r.kept} steps).`);
      for (const d of r.dropped) session.note(`  removed ${d.nodeId}: ${d.reason}`);
      if (r.refused) session.note(`  kept ${r.refused} step${r.refused === 1 ? '' : 's'} it wanted to cut — too much of the demo.`);
    } catch (e) {
      session.note(`AI autopilot: polish failed (${e.message}) — use "Review & polish" in the AI pane.`);
    }
  }
}
