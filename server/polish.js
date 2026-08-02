// Post-recording polish: draft the story, then review the take.
//
// Every recording ends here — AI-driven or hand-driven — so a finished demo is always one that
// has been read back and cleaned up rather than raw footage. Exposed as a single watchable job
// because it takes a minute or two on a long take, and a studio that shows nothing during that
// is indistinguishable from one that has hung.

import { autoDraft, reviewRecording } from './ai.js';

export const polishJob = {
  running: false,
  slug: null,
  message: '',
  done: 0,
  total: 0,
  result: null,
  error: null,
  startedAt: 0,
};

/**
 * @param {object}  opts
 *   slug     {string}
 *   scenario {string}  what the demo is meant to show; drives the review's judgement
 *   draft    {boolean} write the copy first (a hand-driven recording has none worth keeping)
 *   scope    {string[]|null} node ids this pass may rewrite or drop. Recording passes set it
 *            to just what that take shot, so appending a few steps to a demo can never prune
 *            or reword takes the author already curated. Null reviews the whole demo, which
 *            is what the studio's explicit "Review & polish" button asks for.
 */
export async function polishDemo({ slug, scenario = '', draft = false, scope = null }) {
  if (polishJob.running) throw new Error('A polish pass is already running.');
  Object.assign(polishJob, {
    running: true,
    slug,
    message: 'Starting…',
    done: 0,
    total: 0,
    result: null,
    error: null,
    startedAt: Date.now(),
  });

  try {
    if (draft) {
      polishJob.message = 'Writing the story…';
      // A scenario means the description is the author's brief and must survive drafting.
      await autoDraft({
        slug,
        guidance: scenario ? `This demo was recorded to demonstrate: ${scenario}` : '',
        keepDescription: !!scenario,
        scope,
      });
    }

    const result = await reviewRecording({
      slug,
      scenario,
      scope,
      onProgress: ({ done, total, message }) => Object.assign(polishJob, { done, total, message }),
    });

    Object.assign(polishJob, { running: false, result, message: 'Done' });
    return result;
  } catch (e) {
    Object.assign(polishJob, { running: false, error: e.message, message: 'Failed' });
    throw e;
  }
}
