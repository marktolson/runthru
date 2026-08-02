// Asset store for captures.
//
// During capture the page references images, fonts and stylesheets by URL. Those URLs die the
// moment the demo leaves the machine (auth cookies, expiring CDN links, private hosts), so we
// pull every one down at capture time and rewrite the reference to a local file.
//
// Files are named by content hash, which means 30 steps of the same app share one copy of the
// logo instead of carrying 30 base64 blobs. Fetching happens server-side, so CORS never
// applies and the page's own cookies can be forwarded for private assets.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { demoDir } from './store.js';

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff2': '.woff2',
  'application/font-woff': '.woff',
  'text/css': '.css',
};

const MAX_BYTES = 12 * 1024 * 1024; // skip anything absurd; demos should stay portable

export class AssetStore {
  constructor(slug, { cookieHeader = '', userAgent = '' } = {}) {
    this.slug = slug;
    this.dir = path.join(demoDir(slug), 'assets');
    this.cookieHeader = cookieHeader;
    this.userAgent = userAgent;
    this.byUrl = new Map(); // absolute url -> local relative path
    this.inflight = new Map();
    this.failures = new Set();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  // Store bytes we produced ourselves rather than fetched — currently screenshots of canvases
  // the page refused to export. Content-hashed like everything else, so the same chart across
  // thirty steps is stored once.
  async saveBuffer(buf, ext = 'png') {
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const name = `${hash}.${ext.replace(/^\./, '')}`;
    const file = path.join(this.dir, name);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, buf);
    }
    return `../assets/${name}`;
  }

  // Returns a path relative to the snapshot file (steps/step-00N.html lives one level down),
  // or null if the asset could not be fetched and the original URL should be kept.
  async fetchAsset(rawUrl, referer = '') {
    if (!rawUrl) return null;
    const url = String(rawUrl).trim();

    // Already inline or non-network — leave as is.
    if (/^(data:|blob:|about:|javascript:|#)/i.test(url)) return null;
    if (this.byUrl.has(url)) return this.byUrl.get(url);
    if (this.failures.has(url)) return null;
    if (this.inflight.has(url)) return this.inflight.get(url);

    const p = this._fetch(url, referer).catch(() => {
      this.failures.add(url);
      return null;
    });
    this.inflight.set(url, p);
    const result = await p;
    this.inflight.delete(url);
    return result;
  }

  async _fetch(url, referer) {
    let abs;
    try {
      abs = new URL(url, referer || undefined).toString();
    } catch {
      return null;
    }
    if (!/^https?:/i.test(abs)) return null;

    const headers = { Accept: '*/*' };
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    if (referer) headers.Referer = referer;
    // Forward the capture session's cookies so assets behind auth resolve.
    if (this.cookieHeader) headers.Cookie = this.cookieHeader;

    const res = await fetch(abs, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) throw new Error('empty or oversized');

    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const ext = EXT_BY_MIME[mime] || path.extname(new URL(abs).pathname).split('?')[0] || '.bin';
    const name = `${hash}${ext}`;
    const file = path.join(this.dir, name);

    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, buf);
    }

    // Stylesheets can reference further assets; pull those in too and rewrite.
    if (mime === 'text/css' || ext === '.css') {
      const css = buf.toString('utf8');
      const rewritten = await this.rewriteCss(css, abs);
      if (rewritten !== css) {
        await fs.writeFile(file, rewritten, 'utf8');
      }
    }

    const rel = `../assets/${name}`;
    this.byUrl.set(url, rel);
    return rel;
  }

  // Rewrite url(...) references inside CSS text. `baseUrl` resolves relative paths.
  // `depth` prefixes the rewritten path — snapshots sit in steps/, inlined CSS in assets/.
  async rewriteCss(css, baseUrl, depth = './') {
    const refs = new Set();
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m;
    while ((m = re.exec(css))) {
      const u = m[2].trim();
      if (!/^(data:|about:|#)/i.test(u)) refs.add(u);
    }
    // Also pick up @import targets.
    const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;
    while ((m = importRe.exec(css))) {
      const u = (m[2] || m[4] || '').trim();
      if (u && !/^(data:|about:|#)/i.test(u)) refs.add(u);
    }

    const mapping = new Map();
    await Promise.all(
      [...refs].map(async (u) => {
        const local = await this.fetchAsset(u, baseUrl);
        if (local) mapping.set(u, local.replace('../assets/', depth));
      }),
    );

    let out = css;
    for (const [from, to] of mapping) {
      // Replace the literal reference wherever it appears, quoted or bare.
      out = out.split(from).join(to);
    }
    return out;
  }

  // Convenience used by the serializer: resolve a whole batch at once.
  async resolveMany(urls, referer) {
    const out = {};
    await Promise.all(
      [...new Set(urls.filter(Boolean))].map(async (u) => {
        const local = await this.fetchAsset(u, referer);
        if (local) out[u] = local;
      }),
    );
    return out;
  }
}
