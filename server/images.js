// Image downscaling for the AI passes.
//
// Step screenshots are full-viewport PNGs — around 230 KB each, and now 2x, so a 23-step
// review meant uploading several megabytes of base64 in one request. The model only needs
// enough resolution to read a screen's layout and labels, so shrink to a JPEG first: the same
// review goes from megabytes to a few hundred kilobytes, which is the difference between a
// request that looks stalled and one that answers.
//
// Playwright is already a dependency and ships a browser that can do this well, so no image
// library is added for it.

import { chromium } from 'playwright';

const RESIZE = `async (items) => {
  const out = [];
  for (const { id, data, maxWidth, quality } of items) {
    try {
      const blob = await (await fetch(data)).blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxWidth / bmp.width);
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const buf = await jpeg.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      out.push({ id, data: 'data:image/jpeg;base64,' + btoa(bin) });
    } catch {
      out.push({ id, data: null });
    }
  }
  return out;
}`;

/**
 * @param {Array<{id: string, buffer: Buffer}>} images
 * @returns {Promise<Record<string, string>>} id -> data URL (falls back to the original PNG)
 */
export async function shrinkImages(images, { maxWidth = 1000, quality = 0.72 } = {}) {
  const fallback = Object.fromEntries(images.map((i) => [i.id, `data:image/png;base64,${i.buffer.toString('base64')}`]));
  if (!images.length) return fallback;

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const items = images.map((i) => ({
      id: i.id,
      data: `data:image/png;base64,${i.buffer.toString('base64')}`,
      maxWidth,
      quality,
    }));
    const result = await page.evaluate(`(${RESIZE})(${JSON.stringify(items)})`);
    const out = { ...fallback };
    for (const r of result) if (r.data) out[r.id] = r.data;
    return out;
  } catch {
    // Downscaling is an optimisation; the originals still work.
    return fallback;
  } finally {
    await browser?.close().catch(() => {});
  }
}
