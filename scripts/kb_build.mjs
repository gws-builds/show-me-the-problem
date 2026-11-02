// Builds the open-licence trade corpus: kb/corpus/raw/* (downloaded by hand, gitignored, listed in
// kb/corpus/sources.json) -> text per page -> cleaned chunks -> kb/corpus/chunks.jsonl.gz, plus
// kb/corpus/MANIFEST.json with the SHA-256 of every raw file and of the chunk file. src/corpus.js
// refuses to load a chunk file whose hash does not match the manifest (no silent edits).
//   node scripts/kb_build.mjs            (needs pdftotext from poppler)
// The raw files are data: they are only read and passed to pdftotext as a path, never executed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suspicious } from '../src/corpus.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'kb', 'corpus');
const RAW = path.join(DIR, 'raw');
const sources = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const ENT = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: '-',
  mdash: '-',
  hellip: '...',
};
function htmlPages(html) {
  let h = html.replace(/<(script|style|noscript|svg|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<main\b[\s\S]*?<\/main>/i);
  if (main) h = main[0];
  h = h
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : (ENT[e.toLowerCase()] ?? ' '),
    );
  return [h];
}
function pdfPages(file) {
  const out = execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString(
    'utf8',
  );
  return out.split('\f');
}

// Lines that are mostly not words (OCR noise, figure labels, dot leaders) are dropped.
const goodLine = (l) => {
  const t = l.trim();
  if (t.length < 3) return false;
  const letters = (t.match(/[a-z]/gi) ?? []).length;
  return letters / t.length > 0.55 && !/\.{5,}/.test(t) && !/everyspec\.com/i.test(t);
};
// NAVEDTRA courses end each chapter with multiple-choice assignment pages: not reference text.
const QUESTION_PAGE = /\b(ASSIGNMENT \d+|Textbook Assignment|IN ANSWERING QUESTIONS)\b/;
function clean(page) {
  const lines = page
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/­/g, '')
    .split('\n')
    .filter(goodLine);
  return lines
    .join('\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function chunksOf(text, size = 1100) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > size) {
      out.push(cur.trim());
      cur = '';
    }
    cur += `${s} `;
    while (cur.length > size * 1.6) {
      out.push(cur.slice(0, size).trim());
      cur = cur.slice(size);
    }
  }
  if (cur.trim().length) out.push(cur.trim());
  return out;
}

const manifest = { builtAt: new Date().toISOString(), sources: {}, chunks: null, flagged: [] };
const rows = [];
for (const s of sources) {
  const file = path.join(RAW, s.file);
  if (!fs.existsSync(file)) {
    console.log(`MISSING ${s.id}: ${s.file} (download it from ${s.url})`);
    continue;
  }
  const buf = fs.readFileSync(file);
  const pages = s.file.endsWith('.pdf') ? pdfPages(file) : htmlPages(buf.toString('utf8'));
  let n = 0;
  let dropped = 0;
  pages.forEach((p, i) => {
    if (QUESTION_PAGE.test(p)) {
      dropped++;
      return;
    }
    const text = clean(p);
    if (text.length < 200) return;
    for (const c of chunksOf(text)) {
      if (c.length < 160) continue;
      if ((c.match(/(^|\s)[1-4]\.\s/g) ?? []).length >= 4 && /\?/.test(c)) continue; // a multiple-choice question block

      const row = { id: `${s.id}#${i + 1}.${n}`, src: s.id, page: s.file.endsWith('.pdf') ? i + 1 : null, text: c };
      // Corpus poisoning check at build time: instruction-like text is kept out and listed for a human.
      if (suspicious(c)) {
        manifest.flagged.push({ id: row.id, text: c.slice(0, 160) });
        continue;
      }
      rows.push(row);
      n++;
    }
  });
  manifest.sources[s.id] = {
    file: s.file,
    sha256: sha(buf),
    bytes: buf.length,
    pages: pages.length,
    chunks: n,
    questionPagesDropped: dropped,
  };
  console.log(`${s.id}: ${pages.length} pages -> ${n} chunks (${dropped} question pages dropped)`);
}
const gz = zlib.gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')), { level: 9 });
fs.writeFileSync(path.join(DIR, 'chunks.jsonl.gz'), gz);
manifest.chunks = { file: 'chunks.jsonl.gz', count: rows.length, sha256: sha(gz), bytes: gz.length };
fs.writeFileSync(path.join(DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(
  `${rows.length} chunks, ${(gz.length / 1e6).toFixed(2)} MB gzipped; ${manifest.flagged.length} flagged and left out`,
);
