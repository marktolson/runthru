// A minimal ZIP writer.
//
// Exports need to be handed to someone — emailed, dropped in a ticket, uploaded to a host — and
// a folder of hundreds of snapshot files is not something you can hand over. This produces a
// standard deflate-compressed archive using only node:zlib, so the project keeps its three
// dependencies. Snapshots are HTML and compress extremely well, so bundles typically shrink to
// a fraction of their size on disk.
//
// Deliberately not implementing ZIP64: an export is megabytes of markup and images, orders of
// magnitude below the 4 GB point where it would be required.

import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(deflateRaw);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP stores timestamps in the MS-DOS format: two-second resolution, years from 1980.
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    // Always forward slashes inside the archive, whatever the host platform uses.
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (entry.isFile()) out.push({ abs, rel });
  }
  return out;
}

/**
 * Zip a directory's contents.
 *
 * @param {string} dir      directory to archive
 * @param {string} zipPath  file to write
 * @param {object} opts
 *   root {string} folder name to nest everything under inside the archive, so unzipping
 *                 produces one tidy folder rather than scattering files into the cwd
 * @returns {Promise<{bytes: number, files: number}>}
 */
export async function zipDirectory(dir, zipPath, { root = '' } = {}) {
  const files = (await walk(dir)).sort((a, b) => a.rel.localeCompare(b.rel));
  const stamp = dosStamp(new Date());

  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  const fh = await fs.open(zipPath, 'w');
  let offset = 0;
  const central = [];

  const put = async (buf) => {
    await fh.write(buf);
    offset += buf.length;
  };

  try {
    for (const f of files) {
      const raw = await fs.readFile(f.abs);
      const packed = await deflate(raw, { level: 9 });
      // Tiny or already-compressed files can deflate larger than they started; store those raw.
      const deflated = packed.length < raw.length;
      const body = deflated ? packed : raw;
      const name = Buffer.from(root ? `${root}/${f.rel}` : f.rel, 'utf8');
      const crc = crc32(raw);
      const localOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // local file header signature
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags
      local.writeUInt16LE(deflated ? 8 : 0, 8); // method: deflate or store
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // extra field length
      await put(local);
      await put(name);
      await put(body);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0); // central directory header signature
      entry.writeUInt16LE(20, 4); // version made by
      entry.writeUInt16LE(20, 6); // version needed
      entry.writeUInt16LE(0, 8); // flags
      entry.writeUInt16LE(deflated ? 8 : 0, 10);
      entry.writeUInt16LE(stamp.time, 12);
      entry.writeUInt16LE(stamp.date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt16LE(0, 30); // extra
      entry.writeUInt16LE(0, 32); // comment
      entry.writeUInt16LE(0, 34); // disk number start
      entry.writeUInt16LE(0, 36); // internal attributes
      // External attributes hold the unix mode in the high word. The shift overflows a signed
      // 32-bit int, so force it back to unsigned before writing.
      entry.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
      entry.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([entry, name]));
    }

    const cdOffset = offset;
    for (const c of central) await put(c);
    const cdSize = offset - cdOffset;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
    end.writeUInt16LE(0, 4); // this disk
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdOffset, 16);
    end.writeUInt16LE(0, 20); // comment length
    await put(end);
  } finally {
    await fh.close();
  }

  return { bytes: offset, files: files.length };
}
