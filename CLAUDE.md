# Runthru

Record a click-through of any web app, edit the story by hand or with AI, export
a static interactive demo.

Part of the Runnit workspace, but the **only MIT-licensed, publicly shared
codebase in it**. Keep it generic: it records any web app, not just Runnit. Do
not bake Runnit-specific assumptions, branding, or copy into it.

Cross-app context: [`../docs/README.md`](../docs/README.md). System overview:
[`../docs/systems/RUNTHRU.md`](../docs/systems/RUNTHRU.md). End-to-end runbook
for producing and publishing a Runnit demo:
[`../docs/operations/MAKE_A_DEMO.md`](../docs/operations/MAKE_A_DEMO.md).

**[`README.md`](./README.md) is thorough and is the reference.** Read it first.

## Run it

```bash
./run.sh                 # installs deps, fetches the browser, opens :4400
./run.sh exports         # serve exported bundles at :4500
PORT=5000 ./run.sh
npm run studio           # equivalent, direct
npm test                 # Node's built-in test runner
```

First launch offers to connect an OpenAI or Anthropic key, verifies it, and saves
it to `.env`. Recording and manual editing work without one; only the AI features
need it.

## Design principle worth preserving

The recorder snapshots the screen **as it looked before you clicked**, then
replays the click. A demo step is "here is the screen, click this". Capturing
only the result would lose the screen that invited the click. Do not change this
without a good reason.

Tests cover the parts worth pinning: the op table every mutation goes through,
the persistence layer's undo history and per-demo write lock, and the static
export. Keep them passing.

## When recording Runnit

- **Never record a tenant with real client data.** Whatever is on screen ends up
  in the bundle. Record against a seeded demo environment; see
  [`../docs/operations/MAKE_A_DEMO.md`](../docs/operations/MAKE_A_DEMO.md).
- **Set a deliberate name**, because it becomes the slug. Some published demos
  carry long auto-generated slugs taken from the recording prompt.
- Step copy follows Runnit's voice: short declaratives, concrete nouns, **no em
  dashes**.

## Publishing

Exports are zipped and imported through the runnit.io CMS admin, and served at
`runnit.io/demos/<slug>/`. Re-uploading the same slug replaces it. See
[`../docs/systems/WEB.md`](../docs/systems/WEB.md).
