// png-squeeze-01: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Approach (all written from scratch in this session, no copied compressor code):
//  1. Decode the stored PNG to RGBA.
//  2. Analyse each image: opaque? grey (R=G=B)? how many distinct colours?
//     - <=256 colours: palette forms (colour type 3) in three orderings
//       (by count, by luminance, by first appearance), with tRNS when needed.
//     - grey: colour type 0 (or 4 with alpha), tRNS key when all transparent
//       pixels share one value.
//     - otherwise RGB (type 2) or RGBA (type 6), tRNS key when possible.
//  3. Per-row filter selection: try fixed filter 0, min-sum-of-abs, adjacent-pair
//     count, and a brute-force per-row zlib level-4 cost; screen every
//     form/filter candidate at zlib level 6 and keep the smallest.
//  4. Compress the winner with a custom optimal-parsing DEFLATE encoder
//     (hash-chain LZ77 + package-merge Huffman + two refinement passes),
//     and also with banded zlib level 9 (fresh Huffman table every 90 rows);
//     keep whichever stream is smaller, after verifying the custom stream by
//     inflating it and comparing every byte.
//  5. If anything fails for an image, fall back to copying its stored PNG so
//     the instance is still answered (0 points, but never a crash).
//
// Deterministic: fixed effort parameters, no clock, no randomness, no env
// (except MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR, the documented paths).
// Runs on Node 22: plain JavaScript in a .ts file, only node:fs/node:path/node:zlib.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { inflateSync, deflateSync, createDeflateRaw, constants } from 'node:zlib';
import { join } from 'node:path';

// ---------- CRC32 / Adler-32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG decode to RGBA ----------
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, header = null, palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    const dataAt = at + 8;
    at += 12 + len;
    if (type === 'IHDR') {
      header = { width: view.getUint32(dataAt), height: view.getUint32(dataAt + 4), depth: data[8], colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0); }
    else if (ft === 2) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0); }
    else if (ft === 3) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1); }
    else { for (let i = 0; i < stride; i++) { const a = i >= bpp ? samples[o + i - bpp] : 0, b = y > 0 ? samples[p + i] : 0, c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0; samples[o + i] = raw[src + i] + paeth(a, b, c); } }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) { const g = samples[i]; rgba[d] = rgba[d + 1] = rgba[d + 2] = g; rgba[d + 3] = g === key ? 0 : 255; }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1]; }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3]; rgba[d + 1] = palette[e * 3 + 1]; rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------- PNG encode ----------
function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0); out[at + 5] = type.charCodeAt(1); out[at + 6] = type.charCodeAt(2); out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8; d[9] = colourType;
  return d;
}

// ---------- filters ----------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) { for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0); }
  else if (type === 2) { for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]); }
  else if (type === 3) { for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1); }
  else { for (let i = 0; i < n; i++) { const a = i >= bpp ? cur[i - bpp] : 0, b = prev === null ? 0 : prev[i], c = prev !== null && i >= bpp ? prev[i - bpp] : 0; out[i] = cur[i] - paeth(a, b, c); } }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// Filter samples per choice; choice: number 0-4 | 'minsum' | 'pairs' | 'brute'.
function filtered(samples, width, height, bpp, choice, rawOut) {
  const stride = width * bpp;
  const raw = rawOut ?? new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ---------- analysis ----------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true, grey = true;
  const counts = new Map(); // word -> {count, first}
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const w = r | (g << 8) | (b << 16) | (a << 24);
      const e = counts.get(w);
      if (e === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, { count: 1, first: i });
      } else e.count++;
    }
  }
  const colours = many ? null : [...counts.entries()].map(([w, e]) => ({
    word: w, r: w & 255, g: (w >> 8) & 255, b: (w >> 16) & 255, a: (w >>> 24) & 255, count: e.count, first: e.first,
  }));
  return { opaque, grey, colours };
}
// The single RGB/grey value shared by every fully-transparent pixel, or null
// when there is none (also null when a semi-transparent pixel exists, or when
// an opaque pixel already uses that value -- then it cannot be a tRNS key).
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0, tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) indices[i] = index.get(rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24));
  return { plte, trns, indices };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'first']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters: [0, 'minsum', 'brute'], order });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 'minsum', 'pairs', 'brute'], order: null });
  return forms;
}
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------- screening ----------
// Screen all forms/filter choices at zlib level 6; return the best {form, choice, data, bytes}.
function screenBest(rgba, width, height) {
  const forms = formsOf(rgba);
  let best = null;
  let spare = null;
  const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
  for (const form of forms) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else spare = data;
    }
  }
  return best;
}

// ---------- banded zlib ----------
// Split filtered data into row-bands, each compressed with a fresh Huffman table
// (zlib sync-flush between bands). Returns a zlib stream (Uint8Array).
async function bandedZlib(data, bandBytes, level = 9) {
  const raw = await new Promise((resolve, reject) => {
    const d = createDeflateRaw({ level, memLevel: 9 });
    const chunks = [];
    d.on('data', (c) => chunks.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(chunks)));
    let off = 0;
    const step = () => {
      if (off >= data.length) { d.end(); return; }
      const end = Math.min(data.length, off + bandBytes);
      const last = end === data.length;
      d.write(data.subarray(off, end), () => {
        off = end;
        if (last) d.end();
        else d.flush(constants.Z_SYNC_FLUSH, step);
      });
    };
    step();
  });
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78; out[1] = 0xda;
  out.set(raw, 2);
  new DataView(out.buffer).setUint32(2 + raw.length, adler32(data));
  return out;
}
function zlibWrap(rawDeflate, data) {
  const out = new Uint8Array(2 + rawDeflate.length + 4);
  out[0] = 0x78; out[1] = 0xda;
  out.set(rawDeflate, 2);
  new DataView(out.buffer).setUint32(2 + rawDeflate.length, adler32(data));
  return out;
}

// ---------- custom optimal-parse DEFLATE encoder ----------
// Hash-chain LZ77 + optimal parsing + package-merge Huffman, one refinement pass.
// Deterministic: fixed effort parameters, no clock, no randomness.

// DEFLATE tables (RFC 1951).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// length -> symbol, extra bits, extra value (lengths 3..258)
const LEN_SYM = new Uint16Array(259); // symbols go to 285, so 16-bit storage
const LEN_EBITS = new Uint8Array(259);
const LEN_EVAL = new Uint8Array(259);
for (let s = 0; s < 29; s++) {
  const span = s === 28 ? 1 : LEN_BASE[s + 1] - LEN_BASE[s];
  for (let k = 0; k < span; k++) {
    const len = LEN_BASE[s] + k;
    if (len > 258) break;
    LEN_SYM[len] = 257 + s;
    LEN_EBITS[len] = LEN_EXTRA[s];
    LEN_EVAL[len] = k;
  }
}
// distance -> symbol, extra bits, extra value (distances 1..32768)
const DIST_SYM = new Uint8Array(32769);
const DIST_EBITS = new Uint8Array(32769);
const DIST_EVAL = new Uint16Array(32769);
for (let s = 0; s < 30; s++) {
  const span = s === 29 ? 32768 - DIST_BASE[s] + 1 : DIST_BASE[s + 1] - DIST_BASE[s];
  for (let k = 0; k < span; k++) {
    const d = DIST_BASE[s] + k;
    DIST_SYM[d] = s;
    DIST_EBITS[d] = DIST_EXTRA[s];
    DIST_EVAL[d] = k;
  }
}

// Fixed Huffman bit lengths (RFC 1951 3.2.6).
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

// ---- bit writer (LSB-first) ----
class BitWriter {
  constructor() { this.out = []; this.buf = 0; this.cnt = 0; }
  bits(value, count) {
    this.buf |= (value & ((1 << count) - 1)) << this.cnt;
    this.cnt += count;
    while (this.cnt >= 8) { this.out.push(this.buf & 0xff); this.buf >>>= 8; this.cnt -= 8; }
  }
  // Write a Huffman code: codes are stored MSB-first, so reverse the bits first.
  code(code, len) {
    let r = 0;
    for (let i = 0; i < len; i++) r = (r << 1) | ((code >> i) & 1);
    this.bits(r, len);
  }
  alignByte() {
    if (this.cnt > 0) { this.out.push(this.buf & 0xff); this.buf = 0; this.cnt = 0; }
  }
  bytes() { return Uint8Array.from(this.out); }
}

// ---- length-limited Huffman via package-merge ----
function huffmanLengths(freqs, maxLen) {
  const nSym = freqs.length;
  const lengths = new Uint8Array(nSym);
  const items = [];
  for (let s = 0; s < nSym; s++) if (freqs[s] > 0) items.push({ w: freqs[s], syms: [s] });
  const n = items.length;
  if (n === 0) return lengths;
  if (n === 1) { lengths[items[0].syms[0]] = 1; return lengths; }
  items.sort((a, b) => a.w - b.w || a.syms[0] - b.syms[0]);
  const limit = 2 * n - 2;
  let lists = [items];
  for (let level = 1; level < maxLen; level++) {
    const prev = lists[level - 1];
    const packaged = [];
    for (let i = 0; i + 1 < prev.length; i += 2) {
      packaged.push({ w: prev[i].w + prev[i + 1].w, syms: prev[i].syms.concat(prev[i + 1].syms) });
    }
    if (prev.length % 2 === 1) packaged.push(prev[prev.length - 1]);
    // merge packaged with items, keep smallest `limit`
    const merged = [];
    let a = 0, b = 0;
    while (merged.length < limit && (a < packaged.length || b < items.length)) {
      const pa = a < packaged.length ? packaged[a] : null;
      const ib = b < items.length ? items[b] : null;
      if (ib === null || (pa !== null && pa.w <= ib.w)) { merged.push(pa); a++; }
      else { merged.push(ib); b++; }
    }
    lists.push(merged);
  }
  const finalList = lists[maxLen - 1];
  const take = Math.min(limit, finalList.length);
  for (let i = 0; i < take; i++) {
    for (const s of finalList[i].syms) lengths[s]++;
  }
  return lengths;
}

// Canonical Huffman codes from lengths: returns Uint16Array codes.
function canonicalCodes(lengths) {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Uint16Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Uint16Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return codes;
}

// ---- LZ77 matcher (hash chains over 3-byte sequences) ----
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_DIST = 32768;
const MAX_MATCH = 258;
const MIN_MATCH = 3;

class Matcher {
  constructor(data, maxChain = 64) {
    this.maxChain = maxChain;
    this.d = data;
    this.n = data.length;
    // 32-bit view for 4-bytes-at-a-time match extension (lengths are the hot loop).
    // Only when the buffer starts on a 4-byte boundary; otherwise d32 stays null
    // and matchLen falls back to byte-by-byte.
    this.d32 = data.byteOffset % 4 === 0
      ? new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4))
      : null;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(data.length).fill(-1);
    this.inserted = 0;
  }
  hashAt(i) {
    const d = this.d;
    return ((((d[i] << 8) ^ d[i + 1]) << 8) ^ d[i + 2]) * 2654435761 >>> (32 - HASH_BITS);
  }
  insert(i) {
    // A position can only start a match if 3 bytes remain; later positions are
    // never inserted (their hash would read past the end).
    if (i + MIN_MATCH > this.n) return;
    const h = this.hashAt(i);
    this.prev[i] = this.head[h];
    this.head[h] = i;
  }
  insertUpTo(i) { // insert all positions < i
    while (this.inserted < i) this.insert(this.inserted++);
  }
  // Length of the match between `cand` and `pos`, capped at maxLen.
  // Compares 4 bytes at a time once both sides are 4-aligned (distances that
  // are a multiple of 4, the common case for pixel-aligned repeats).
  matchLen(cand, pos, maxLen) {
    const d = this.d, d32 = this.d32;
    let len = 0;
    while (len < maxLen && ((pos + len) & 3) !== 0) {
      if (d[cand + len] !== d[pos + len]) return len;
      len++;
    }
    if (len >= maxLen) return len;
    if (d[cand + len] !== d[pos + len]) return len;
    if (d32 !== null && ((pos - cand) & 3) === 0) {
      while (len + 4 <= maxLen && d32[(pos + len) >> 2] === d32[(cand + len) >> 2]) len += 4;
    }
    while (len < maxLen && d[cand + len] === d[pos + len]) len++;
    return len;
  }
  // Longest match at pos, capped at maxLen and not crossing `end`.
  longest(pos, end) {
    const d = this.d;
    const maxLen = Math.min(MAX_MATCH, end - pos);
    if (maxLen < MIN_MATCH || pos + 2 >= this.n) return { len: 0, dist: 0 };
    const h = this.hashAt(pos);
    let bestLen = 0, bestDist = 0;
    let cand = this.head[h];
    let steps = 0;
    const limit = pos - MAX_DIST;
    // Two-tier chain search: walk a shallow 64 candidates first. In noisy data
    // most positions never find a good match, and a full-depth walk there is
    // pure overhead, so stop at 64 unless a promising match (>= 24) shows up,
    // in which case deepen to look for a longer/closer one. The tightening
    // caps still apply after deepening: once a good match is in hand, only a
    // few more candidates are worth checking.
    let maxSteps = Math.min(this.maxChain, 64);
    let deepened = false;
    while (cand >= 0 && cand >= limit && steps < maxSteps) {
      steps++;
      // quick reject: the byte just past the current best length must match
      // (a candidate whose first difference is at or before bestLen cannot beat it)
      if (bestLen > 0 && d[cand + bestLen] !== d[pos + bestLen]) { cand = this.prev[cand]; continue; }
      const len = this.matchLen(cand, pos, maxLen);
      if (len > bestLen) {
        bestLen = len; bestDist = pos - cand;
        if (len >= maxLen) break;
        if (len >= 128) maxSteps = Math.min(maxSteps, steps + 4);
        else if (len >= 32) maxSteps = Math.min(maxSteps, steps + 32);
        else if (len >= 24 && !deepened) { deepened = true; maxSteps = this.maxChain; }
      }
      cand = this.prev[cand];
    }
    return { len: bestLen, dist: bestDist };
  }
}

// ---- optimal parse of one block ----
// `cache` (optional): {len: Int32Array, dist: Int32Array} sized to the block; on the
// first pass it is filled with each position's longest match, later passes reuse it
// (match finding does not depend on the Huffman costs, so it is computed once).
function parseBlock(data, start, end, matcher, litLen, lenLen, distLen, cache) {
  const n = end - start;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);   // start position of the decision reaching j
  const mlen = new Int32Array(n + 1);   // 0 = literal, else match length
  const mdist = new Int32Array(n + 1);  // match distance
  cost[0] = 0;
  const litCost = new Float64Array(256);
  for (let b = 0; b < 256; b++) litCost[b] = litLen[b];
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = lenLen[LEN_SYM[l]] + LEN_EBITS[l];
  const distCost = new Float64Array(MAX_DIST + 1);
  for (let dd = 1; dd <= MAX_DIST; dd++) distCost[dd] = distLen[DIST_SYM[dd]] + DIST_EBITS[dd];

  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    const pos = start + i;
    // literal
    const lc = ci + litCost[data[pos]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; from[i + 1] = i; mlen[i + 1] = 0; }
    // match (cached after the first pass)
    let m;
    if (cache !== null && cache.len[i] !== -1) m = { len: cache.len[i], dist: cache.dist[i] };
    else {
      matcher.insertUpTo(pos);
      m = matcher.longest(pos, end);
      if (cache !== null) { cache.len[i] = m.len; cache.dist[i] = m.dist; }
    }
    if (m.len >= MIN_MATCH) {
      const base = ci + distCost[m.dist];
      // candidate lengths: the longest length of each length-symbol range <= m.len
      const cands = [m.len];
      for (let s = 27; s >= 0; s--) {
        const top = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
        if (top < m.len && top >= MIN_MATCH && LEN_BASE[s] <= m.len) cands.push(top);
      }
      for (const l of cands) {
        const nc = base + lenCost[l];
        if (nc < cost[i + l]) { cost[i + l] = nc; from[i + l] = i; mlen[i + l] = l; mdist[i + l] = m.dist; }
      }
    }
  }
  // reconstruct symbols (reverse order)
  const syms = [];
  let j = n;
  while (j > 0) {
    const i = from[j];
    const l = mlen[j];
    if (l === 0) syms.push({ lit: data[start + i] });
    else syms.push({ len: l, dist: mdist[j] });
    j = i;
  }
  syms.reverse();
  return syms;
}

// ---- encode one block's symbols with a dynamic Huffman header ----
function encodeDynamicBlock(w, syms, last) {
  // frequencies
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (const s of syms) {
    if (s.lit !== undefined) litFreq[s.lit]++;
    else { litFreq[LEN_SYM[s.len]]++; distFreq[DIST_SYM[s.dist]]++; }
  }
  litFreq[256]++; // end of block
  if (distFreq.every((v) => v === 0)) distFreq[0] = 1;
  const litLengths = huffmanLengths(litFreq, 15);
  const distLengths = huffmanLengths(distFreq, 15);
  return encodeBlockWithLengths(w, syms, litLengths, distLengths, last);
}

function encodeBlockWithLengths(w, syms, litLengths, distLengths, last) {
  // trim trailing zero lengths
  let hlit = 288;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  // RLE the combined lengths
  const all = [];
  for (let i = 0; i < hlit; i++) all.push(litLengths[i]);
  for (let i = 0; i < hdist; i++) all.push(distLengths[i]);
  const rle = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    if (v === 0) {
      let run = 0;
      while (i + run < all.length && all[i + run] === 0) run++;
      i += run;
      while (run >= 11) { const take = Math.min(run, 138); rle.push([18, take]); run -= take; }
      if (run >= 3) { rle.push([17, run]); run = 0; }
      while (run > 0) { rle.push([0, 0]); run--; }
    } else {
      let run = 1;
      while (i + run < all.length && all[i + run] === v) run++;
      rle.push([v, 0]); i++; run--;
      while (run >= 3) { const take = Math.min(run, 6); rle.push([16, take]); run -= take; i += take; }
      while (run > 0) { rle.push([v, 0]); run--; i++; }
    }
  }
  // code-length code frequencies
  const clFreq = new Uint32Array(19);
  for (const [s] of rle) clFreq[s]++;
  const clLengths = huffmanLengths(clFreq, 7);
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLengths);
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);

  w.bits(last ? 1 : 0, 1);
  w.bits(2, 2); // dynamic
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.bits(clLengths[CL_ORDER[k]], 3);
  for (const [s, extra] of rle) {
    w.code(clCodes[s], clLengths[s]);
    if (s === 16) w.bits(extra - 3, 2);
    else if (s === 17) w.bits(extra - 3, 3);
    else if (s === 18) w.bits(extra - 11, 7);
  }
  for (const s of syms) {
    if (s.lit !== undefined) w.code(litCodes[s.lit], litLengths[s.lit]);
    else {
      const ls = LEN_SYM[s.len];
      w.code(litCodes[ls], litLengths[ls]);
      if (LEN_EBITS[s.len] > 0) w.bits(LEN_EVAL[s.len], LEN_EBITS[s.len]);
      const ds = DIST_SYM[s.dist];
      w.code(distCodes[ds], distLengths[ds]);
      if (DIST_EBITS[s.dist] > 0) w.bits(DIST_EVAL[s.dist], DIST_EBITS[s.dist]);
    }
  }
  w.code(litCodes[256], litLengths[256]);
}

// Fixed-Huffman block (for comparison / fallback).
function encodeFixedBlock(w, syms, last) {
  const litCodes = canonicalCodes(FIXED_LIT_LEN);
  const distCodes = canonicalCodes(FIXED_DIST_LEN);
  w.bits(last ? 1 : 0, 1);
  w.bits(1, 2);
  for (const s of syms) {
    if (s.lit !== undefined) w.code(litCodes[s.lit], FIXED_LIT_LEN[s.lit]);
    else {
      const ls = LEN_SYM[s.len];
      w.code(litCodes[ls], FIXED_LIT_LEN[ls]);
      if (LEN_EBITS[s.len] > 0) w.bits(LEN_EVAL[s.len], LEN_EBITS[s.len]);
      const ds = DIST_SYM[s.dist];
      w.code(distCodes[ds], FIXED_DIST_LEN[ds]);
      if (DIST_EBITS[s.dist] > 0) w.bits(DIST_EVAL[s.dist], DIST_EBITS[s.dist]);
    }
  }
  w.code(litCodes[256], FIXED_LIT_LEN[256]);
}

// Encode the whole input as raw DEFLATE. blockSize: input bytes per dynamic block.
// iterations: Huffman refinement rounds (2 = parse, refine, parse, refine, parse, emit).
function deflateOptimal(data, { blockSize = 200000, iterations = 2, maxChain = 64 } = {}) {
  const n = data.length;
  if (n === 0) {
    const w = new BitWriter();
    w.bits(1, 1); w.bits(1, 2);
    w.code(canonicalCodes(FIXED_LIT_LEN)[256], 7);
    w.alignByte();
    return w.bytes();
  }
  const matcher = new Matcher(data, maxChain);
  const w = new BitWriter();
  let start = 0;
  while (start < n) {
    const end = Math.min(n, start + blockSize);
    const last = end === n;
    // Match finding is cost-independent, so compute each position's longest match
    // once (first pass) and reuse it across the Huffman-refinement passes.
    const cache = { len: new Int32Array(end - start).fill(-1), dist: new Int32Array(end - start) };
    // iterative refinement of Huffman costs for this block
    let litLen = FIXED_LIT_LEN, distLen = FIXED_DIST_LEN;
    let syms = null;
    for (let it = 0; it <= iterations; it++) {
      syms = parseBlock(data, start, end, matcher, litLen, /*lenLen*/ litLen, distLen, cache);
      // rebuild lengths from this parse's frequencies
      const litFreq = new Uint32Array(288);
      const distFreq = new Uint32Array(30);
      for (const s of syms) {
        if (s.lit !== undefined) litFreq[s.lit]++;
        else { litFreq[LEN_SYM[s.len]]++; distFreq[DIST_SYM[s.dist]]++; }
      }
      litFreq[256]++;
      if (distFreq.every((v) => v === 0)) distFreq[0] = 1;
      litLen = huffmanLengths(litFreq, 15);
      distLen = huffmanLengths(distFreq, 15);
    }
    // The first pass inserted every position < end-1; insert the last one so the
    // next block's matches can reference it.
    matcher.insertUpTo(end);
    // emit: dynamic vs fixed, keep the smaller encoding (re-emitted into the main
    // writer, since blocks share one bitstream).
    const wDyn = new BitWriter();
    encodeBlockWithLengths(wDyn, syms, litLen, distLen, last);
    const wFix = new BitWriter();
    encodeFixedBlock(wFix, syms, last);
    if (wDyn.bytes().length <= wFix.bytes().length) encodeBlockWithLengths(w, syms, litLen, distLen, last);
    else encodeFixedBlock(w, syms, last);
    start = end;
  }
  w.alignByte();
  return w.bytes();
}

// ---------- compress one image ----------
// Custom optimal-parse deflate (single block, 2 refinement passes, chain 1024)
// vs banded zlib level 9 (90-row bands); keep the smaller, after verifying the
// custom stream by inflating it and comparing every byte.
async function compressImage(rgba, width, height) {
  const best = screenBest(rgba, width, height);
  const f = best.form;
  const rowLen = width * f.bpp + 1;
  let zlibStream = null;
  try {
    const raw = deflateOptimal(best.data, { blockSize: 10000000, iterations: 2, maxChain: 1024 });
    const wrapped = zlibWrap(raw, best.data);
    const back = inflateSync(wrapped);
    if (back.length === best.data.length && Buffer.from(back).equals(Buffer.from(best.data))) zlibStream = wrapped;
  } catch { /* fall through to banded */ }
  const banded = await bandedZlib(best.data, 90 * rowLen, 9);
  if (zlibStream === null || banded.length < zlibStream.length) zlibStream = banded;
  const chunks = [['IHDR', ihdrOf(width, height, f.colourType)]];
  if (f.plte !== null) chunks.push(['PLTE', f.plte]);
  if (f.trns !== null) chunks.push(['tRNS', f.trns]);
  chunks.push(['IDAT', new Uint8Array(zlibStream)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- driver ----------
// Reads MAKEFUN_INPUT_DIR (default /input), writes MAKEFUN_OUTPUT_DIR (default
// /output). One output per input directory, sorted. A per-instance failure
// falls back to copying the stored PNG so the instance is still answered.
(async () => {
  const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const entries = readdirSync(I, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const id of entries) {
    const inPath = join(I, id, 'image.png');
    const outDir = join(O, id);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'image.png');
    try {
      const img = decodePng(new Uint8Array(readFileSync(inPath)));
      const png = await compressImage(img.rgba, img.width, img.height);
      writeFileSync(outPath, png);
    } catch {
      copyFileSync(inPath, outPath);
    }
  }
})();
