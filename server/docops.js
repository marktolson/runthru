// Every mutation to a demo document lives here, as a named operation with a JSON-Schema
// signature. The editor UI, the REST API and the OpenAI tool-calls all go through this same
// table — so the AI can do exactly what the UI can, no more and no less, and every change is
// a single undoable write.
//
// An op's `run(doc, args)` mutates `doc` in place (callers pass a clone) and returns a short
// human-readable summary used for the activity log and the AI's own feedback.

const ANNOTATION_KINDS = ['tooltip', 'modal', 'hotspot', 'caption', 'none'];
const PLACEMENTS = ['auto', 'top', 'bottom', 'left', 'right', 'center'];
const OVERLAY_TYPES = ['blur', 'hide', 'text', 'image', 'highlight'];
const ADVANCE_MODES = ['click-target', 'any-click', 'next', 'timer'];

export const clone = (o) => JSON.parse(JSON.stringify(o));

function findNode(doc, nodeId) {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`No step with id "${nodeId}". Valid ids: ${doc.nodes.map((n) => n.id).join(', ') || '(none)'}`);
  return node;
}

function nodeIndex(doc, nodeId) {
  const i = doc.nodes.findIndex((n) => n.id === nodeId);
  if (i < 0) throw new Error(`No step with id "${nodeId}".`);
  return i;
}

export function nextNodeId(doc) {
  let max = 0;
  for (const n of doc.nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

// Flow resolution: `next` is implicit (the following node in the array) unless explicitly set.
// That keeps reordering trivial while still allowing non-linear jumps and branches.
export function resolveNext(doc, nodeId) {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if (node.next) return node.next;
  const i = doc.nodes.findIndex((n) => n.id === nodeId);
  return doc.nodes[i + 1]?.id ?? null;
}

export function newNode(doc, partial = {}) {
  return {
    id: nextNodeId(doc),
    snapshot: null,
    shot: null,
    url: '',
    pageTitle: '',
    scroll: { x: 0, y: 0 },
    viewport: { w: 1440, h: 900 },
    annotation: {
      kind: 'tooltip',
      title: '',
      body: '',
      target: null,
      placement: 'auto',
      beacon: true,
      ctaLabel: '',
    },
    overlays: [],
    advance: { on: 'click-target', ms: 0 },
    next: null,
    branches: [],
    ...partial,
  };
}

function outline(doc) {
  return {
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    stepCount: doc.nodes.length,
    variables: doc.variables,
    theme: doc.theme,
    settings: doc.settings,
    cover: doc.cover,
    leadForm: { enabled: doc.leadForm?.enabled, position: doc.leadForm?.position },
    endCta: doc.endCta,
    steps: doc.nodes.map((n, i) => ({
      index: i,
      id: n.id,
      url: n.url,
      pageTitle: n.pageTitle,
      kind: n.annotation?.kind,
      title: n.annotation?.title,
      body: n.annotation?.body,
      target: n.annotation?.target,
      targetHint: n.targetHint || null,
      placement: n.annotation?.placement,
      advance: n.advance,
      next: resolveNext(doc, n.id),
      branches: n.branches,
      overlays: n.overlays?.length ? n.overlays : undefined,
    })),
  };
}

const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const bool = (d) => ({ type: 'boolean', description: d });
const enumOf = (vals, d) => ({ type: 'string', enum: vals, description: d });

export const OPS = {
  // ---------------------------------------------------------------- read

  get_demo: {
    readonly: true,
    description:
      'Read the whole demo: metadata, theme, settings, variables and every step with its copy, target, flow and overlays. Call this first to see what you are editing.',
    params: { type: 'object', properties: {}, required: [] },
    run: (doc) => outline(doc),
  },

  get_step: {
    readonly: true,
    description: 'Read one step in full detail, including captured page context to help you write accurate copy.',
    params: {
      type: 'object',
      properties: { nodeId: str('The step id, e.g. "n3".') },
      required: ['nodeId'],
    },
    run: (doc, { nodeId }) => findNode(doc, nodeId),
  },

  // ---------------------------------------------------------------- copy

  set_step_copy: {
    description: 'Set the headline and/or body text of a single step. Omit a field to leave it unchanged.',
    params: {
      type: 'object',
      properties: {
        nodeId: str('The step id, e.g. "n3".'),
        title: str('Short headline. Aim for under 60 characters.'),
        body: str('Supporting sentence. One or two short sentences reads best.'),
      },
      required: ['nodeId'],
    },
    run: (doc, { nodeId, title, body }) => {
      const n = findNode(doc, nodeId);
      n.annotation ||= {};
      if (title !== undefined) n.annotation.title = title;
      if (body !== undefined) n.annotation.body = body;
      return `Updated copy on ${nodeId}`;
    },
  },

  bulk_set_step_copy: {
    description:
      'Rewrite copy across many steps in one call. Strongly preferred over many set_step_copy calls when retoning or tightening a whole demo.',
    params: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'One entry per step you want to change.',
          items: {
            type: 'object',
            properties: {
              nodeId: str('The step id.'),
              title: str('New headline.'),
              body: str('New body text.'),
            },
            required: ['nodeId'],
          },
        },
      },
      required: ['steps'],
    },
    run: (doc, { steps }) => {
      let count = 0;
      for (const s of steps || []) {
        const n = findNode(doc, s.nodeId);
        n.annotation ||= {};
        if (s.title !== undefined) n.annotation.title = s.title;
        if (s.body !== undefined) n.annotation.body = s.body;
        count++;
      }
      return `Rewrote copy on ${count} step${count === 1 ? '' : 's'}`;
    },
  },

  set_meta: {
    description: 'Set the demo title and description shown in the studio and on the share/embed page.',
    params: {
      type: 'object',
      properties: { name: str('Demo title.'), description: str('One-line description.') },
      required: [],
    },
    run: (doc, { name, description }) => {
      if (name !== undefined) doc.name = name;
      if (description !== undefined) doc.description = description;
      return 'Updated demo details';
    },
  },

  // ---------------------------------------------------------- annotation

  set_annotation: {
    description:
      'Configure how a step is presented: tooltip anchored to an element, centred modal, bare hotspot, a corner caption, or nothing at all.',
    params: {
      type: 'object',
      properties: {
        nodeId: str('The step id.'),
        kind: enumOf(ANNOTATION_KINDS, 'tooltip anchors to an element; modal floats centre-screen; hotspot is a bare pulsing dot; caption sits in a corner; none hides all guidance.'),
        title: str('Headline.'),
        body: str('Body text.'),
        target: str('CSS selector for the element to anchor to, normally the captured "[data-demo-target=\'tN\']".'),
        placement: enumOf(PLACEMENTS, 'Where the tooltip sits relative to its target.'),
        beacon: bool('Show a pulsing dot on the target to draw the eye.'),
        ctaLabel: str('Label for the advance button, e.g. "Next" or "Show me".'),
      },
      required: ['nodeId'],
    },
    run: (doc, { nodeId, ...rest }) => {
      const n = findNode(doc, nodeId);
      n.annotation ||= {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) n.annotation[k] = v;
      return `Updated annotation on ${nodeId}`;
    },
  },

  set_advance: {
    description: 'Control what moves the viewer to the next step.',
    params: {
      type: 'object',
      properties: {
        nodeId: str('The step id.'),
        on: enumOf(ADVANCE_MODES, 'click-target requires clicking the highlighted element; any-click accepts a click anywhere; next requires the Next button; timer auto-advances.'),
        ms: num('Delay in milliseconds, used only when on="timer".'),
      },
      required: ['nodeId', 'on'],
    },
    run: (doc, { nodeId, on, ms }) => {
      const n = findNode(doc, nodeId);
      n.advance = { on, ms: ms ?? n.advance?.ms ?? 0 };
      return `${nodeId} now advances on "${on}"`;
    },
  },

  // ---------------------------------------------------------------- flow

  reorder_steps: {
    description: 'Reorder the demo by supplying step ids in the new order. Any ids you omit keep their relative order at the end.',
    params: {
      type: 'object',
      properties: {
        order: { type: 'array', items: { type: 'string' }, description: 'Step ids in the desired order.' },
      },
      required: ['order'],
    },
    run: (doc, { order }) => {
      const byId = new Map(doc.nodes.map((n) => [n.id, n]));
      const seen = new Set();
      const next = [];
      for (const id of order || []) {
        const n = byId.get(id);
        if (n && !seen.has(id)) {
          next.push(n);
          seen.add(id);
        }
      }
      for (const n of doc.nodes) if (!seen.has(n.id)) next.push(n);
      doc.nodes = next;
      return `Reordered to ${doc.nodes.map((n) => n.id).join(' → ')}`;
    },
  },

  move_step: {
    description: 'Move one step to a new zero-based position.',
    params: {
      type: 'object',
      properties: { nodeId: str('The step id.'), toIndex: num('Zero-based destination index.') },
      required: ['nodeId', 'toIndex'],
    },
    run: (doc, { nodeId, toIndex }) => {
      const from = nodeIndex(doc, nodeId);
      const [n] = doc.nodes.splice(from, 1);
      const to = Math.max(0, Math.min(doc.nodes.length, Math.trunc(toIndex)));
      doc.nodes.splice(to, 0, n);
      return `Moved ${nodeId} to position ${to + 1}`;
    },
  },

  delete_step: {
    description: 'Delete a step. Any branches or explicit next-pointers aimed at it are repaired automatically.',
    params: {
      type: 'object',
      properties: { nodeId: str('The step id.') },
      required: ['nodeId'],
    },
    run: (doc, { nodeId }) => {
      const i = nodeIndex(doc, nodeId);
      const fallback = resolveNext(doc, nodeId);
      doc.nodes.splice(i, 1);
      for (const n of doc.nodes) {
        if (n.next === nodeId) n.next = fallback && fallback !== nodeId ? fallback : null;
        if (Array.isArray(n.branches)) {
          n.branches = n.branches.filter((b) => b.next !== nodeId);
        }
      }
      if (doc.settings?.startNodeId === nodeId) doc.settings.startNodeId = doc.nodes[0]?.id ?? null;
      return `Deleted ${nodeId}`;
    },
  },

  duplicate_step: {
    description: 'Duplicate a step, inserting the copy directly after the original. Useful as the base for a branch.',
    params: {
      type: 'object',
      properties: { nodeId: str('The step id to copy.') },
      required: ['nodeId'],
    },
    run: (doc, { nodeId }) => {
      const i = nodeIndex(doc, nodeId);
      const copy = clone(doc.nodes[i]);
      copy.id = nextNodeId(doc);
      copy.next = null;
      doc.nodes.splice(i + 1, 0, copy);
      return `Duplicated ${nodeId} as ${copy.id}`;
    },
  },

  set_next: {
    description:
      'Override which step follows this one. Pass null to fall back to normal linear order. Use this to skip or loop sections.',
    params: {
      type: 'object',
      properties: {
        nodeId: str('The step id.'),
        next: { type: ['string', 'null'], description: 'Destination step id, or null for linear order.' },
      },
      required: ['nodeId', 'next'],
    },
    run: (doc, { nodeId, next }) => {
      const n = findNode(doc, nodeId);
      if (next) findNode(doc, next);
      n.next = next || null;
      return next ? `${nodeId} now jumps to ${next}` : `${nodeId} follows linear order`;
    },
  },

  set_branches: {
    description:
      'Turn a step into a fork in the story. Each branch is a button the viewer picks, sending them to a different step. Pass an empty array to remove the fork.',
    params: {
      type: 'object',
      properties: {
        nodeId: str('The step id that presents the choice.'),
        branches: {
          type: 'array',
          description: 'The choices offered, in display order.',
          items: {
            type: 'object',
            properties: {
              label: str('Button text the viewer sees, e.g. "I run marketing".'),
              next: str('Step id this choice jumps to.'),
            },
            required: ['label', 'next'],
          },
        },
      },
      required: ['nodeId', 'branches'],
    },
    run: (doc, { nodeId, branches }) => {
      const n = findNode(doc, nodeId);
      for (const b of branches || []) findNode(doc, b.next);
      n.branches = (branches || []).map((b) => ({ label: b.label, next: b.next }));
      return n.branches.length
        ? `${nodeId} now branches ${n.branches.length} ways`
        : `Removed branching from ${nodeId}`;
    },
  },

  // ------------------------------------------------------------ overlays

  add_overlay: {
    description:
      'Layer an edit onto the captured page: blur sensitive figures, hide an element, swap text, replace an image, or highlight a region. Applied at playback, so the original capture stays intact.',
    params: {
      type: 'object',
      properties: {
        nodeId: str('The step id.'),
        type: enumOf(OVERLAY_TYPES, 'blur obscures; hide removes; text replaces text content; image swaps an img src; highlight outlines.'),
        target: str('CSS selector inside the captured page.'),
        value: str('Replacement text for type="text", or image URL for type="image". Ignored otherwise.'),
      },
      required: ['nodeId', 'type', 'target'],
    },
    run: (doc, { nodeId, type, target, value }) => {
      const n = findNode(doc, nodeId);
      n.overlays ||= [];
      n.overlays.push({ type, target, value: value ?? '' });
      return `Added ${type} overlay to ${nodeId}`;
    },
  },

  clear_overlays: {
    description: 'Remove all overlays from a step, restoring the captured page exactly as recorded.',
    params: {
      type: 'object',
      properties: { nodeId: str('The step id.') },
      required: ['nodeId'],
    },
    run: (doc, { nodeId }) => {
      const n = findNode(doc, nodeId);
      const had = n.overlays?.length || 0;
      n.overlays = [];
      return `Cleared ${had} overlay${had === 1 ? '' : 's'} from ${nodeId}`;
    },
  },

  // ------------------------------------------------------- look and feel

  set_theme: {
    description: 'Set demo branding. Only the fields you pass are changed.',
    params: {
      type: 'object',
      properties: {
        accent: str('Accent colour as hex, e.g. "#5b5bd6". Drives buttons, beacons and progress.'),
        accentText: str('Text colour used on top of the accent, hex.'),
        font: enumOf(['system', 'inter', 'serif', 'mono'], 'Typeface for demo chrome.'),
        radius: num('Corner radius in pixels for demo chrome.'),
        overlay: num('Dimming of the page outside the spotlight, 0 to 1.'),
        spotlight: bool('Whether to cut a spotlight hole around the target.'),
        logo: str('URL or data URI of a logo shown in the demo chrome.'),
      },
      required: [],
    },
    run: (doc, args) => {
      doc.theme ||= {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) doc.theme[k] = v;
      return 'Updated theme';
    },
  },

  set_settings: {
    description: 'Set playback behaviour. Only the fields you pass are changed.',
    params: {
      type: 'object',
      properties: {
        showProgress: bool('Show the progress bar.'),
        showControls: bool('Show back/next controls.'),
        cursor: bool('Animate a guide cursor that glides to each step’s target.'),
        typing: bool('Replay recorded form entries keystroke by keystroke.'),
        freeRoam: bool('Let viewers click anywhere rather than only the highlighted target.'),
        autoplay: bool('Advance automatically without interaction.'),
        autoplayMs: num('Milliseconds per step when autoplay is on.'),
        startNodeId: { type: ['string', 'null'], description: 'Step to open on. Null means the first step.' },
        loop: bool('Return to the start after the last step.'),
      },
      required: [],
    },
    run: (doc, args) => {
      doc.settings ||= {};
      if (args.startNodeId) findNode(doc, args.startNodeId);
      for (const [k, v] of Object.entries(args)) if (v !== undefined) doc.settings[k] = v;
      return 'Updated playback settings';
    },
  },

  set_variables: {
    description:
      'Define personalisation tokens. A variable named "company" can be written as {{company}} in any step copy and overridden per viewer with ?company=Acme on the share URL.',
    params: {
      type: 'object',
      properties: {
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: str('Token name, letters and numbers only.'),
              label: str('Human label shown in the studio.'),
              default: str('Value used when the URL does not supply one.'),
            },
            required: ['key'],
          },
        },
      },
      required: ['variables'],
    },
    run: (doc, { variables }) => {
      doc.variables = (variables || []).map((v) => ({
        key: String(v.key).replace(/[^A-Za-z0-9_]/g, ''),
        label: v.label || v.key,
        default: v.default ?? '',
      }));
      return `Set ${doc.variables.length} variable${doc.variables.length === 1 ? '' : 's'}`;
    },
  },

  set_cover: {
    description:
      'Configure the optional entry page: the poster screen a viewer sees before the tour starts, laid over the first captured screen with a headline, a supporting line and one start button. Only the fields you pass are changed.',
    params: {
      type: 'object',
      properties: {
        enabled: bool('Show the entry page before the first step.'),
        eyebrow: str('Small uppercase label above the headline, e.g. "Product tour".'),
        headline: str('The large headline. Leave empty to fall back to the demo name.'),
        body: str('One or two supporting sentences. Leave empty to fall back to the demo description.'),
        buttonLabel: str('Start button label, e.g. "Take a tour".'),
        align: enumOf(['left', 'center'], 'Where the text block sits over the screen.'),
        theme: enumOf(['dark', 'light'], 'Light text on a darkened screen, or dark text on a lightened one.'),
        backdrop: enumOf(
          ['blur', 'dim', 'clear', 'solid'],
          'How the first captured screen shows through: blur frosts it, dim darkens it, clear barely touches it, solid replaces it with a gradient built from the accent colour.',
        ),
        glow: bool('Animate the aura and travelling highlight around the start button.'),
        showSteps: bool('Show the step count and rough duration under the button.'),
        logo: str('URL or data URI of a logo shown above the headline. Falls back to the theme logo.'),
      },
      required: [],
    },
    run: (doc, args) => {
      doc.cover ||= {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) doc.cover[k] = v;
      return args.enabled === false ? 'Turned the entry page off' : 'Updated the entry page';
    },
  },

  set_lead_form: {
    description: 'Configure the lead capture form shown during the demo.',
    params: {
      type: 'object',
      properties: {
        enabled: bool('Whether to show the form at all.'),
        position: enumOf(['start', 'end'], 'Gate the demo up front, or ask at the end.'),
        headline: str('Form headline.'),
        body: str('Supporting text.'),
        submitLabel: str('Submit button label.'),
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: str('Field name.'),
              label: str('Field label.'),
              type: enumOf(['text', 'email', 'tel', 'select'], 'Input type.'),
              required: bool('Whether the viewer must fill it in.'),
            },
            required: ['key', 'label'],
          },
        },
      },
      required: [],
    },
    run: (doc, args) => {
      doc.leadForm ||= {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) doc.leadForm[k] = v;
      return 'Updated lead form';
    },
  },

  set_end_cta: {
    description: 'Configure the call to action shown when the demo finishes.',
    params: {
      type: 'object',
      properties: {
        enabled: bool('Whether to show it.'),
        label: str('Button label.'),
        href: str('Destination URL.'),
        body: str('Closing message above the button.'),
      },
      required: [],
    },
    run: (doc, args) => {
      doc.endCta ||= {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) doc.endCta[k] = v;
      return 'Updated end call to action';
    },
  },
};

// Apply an op to a *clone* of the doc. Returns the new doc plus a summary; read-only ops
// return their payload under `result` and leave the doc untouched.
export function applyOp(doc, name, args = {}) {
  const op = OPS[name];
  if (!op) throw new Error(`Unknown operation "${name}". Available: ${Object.keys(OPS).join(', ')}`);
  if (op.readonly) {
    return { doc, result: op.run(doc, args), summary: null, readonly: true };
  }
  const next = clone(doc);
  const summary = op.run(next, args);
  return { doc: next, result: null, summary, readonly: false };
}

// OpenAI tool-call schema for every op.
export function toolSchemas() {
  return Object.entries(OPS).map(([name, op]) => ({
    type: 'function',
    function: {
      name,
      description: op.description,
      parameters: {
        type: 'object',
        properties: op.params.properties || {},
        required: op.params.required || [],
        additionalProperties: false,
      },
    },
  }));
}

export const CONSTANTS = { ANNOTATION_KINDS, PLACEMENTS, OVERLAY_TYPES, ADVANCE_MODES };
