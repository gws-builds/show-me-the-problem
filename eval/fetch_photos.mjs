// Downloads the eval photos listed in eval/cases.json from Wikimedia Commons
// (freely licensed, attribution kept in eval/photos/ATTRIBUTION.md).
// Anonymous User-Agent: no personal or business identifier in any request.
import fs from 'node:fs';
const UA = 'snap-to-booked-eval/1.0 (anonymous)';
const get = async (url) => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.status !== 429 && r.ok) return r;
    await new Promise((s) => setTimeout(s, 15000 * (i + 1)));
  }
  throw new Error('gave up on ' + url);
};
const cases = JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url)));
const dir = new URL('./photos/', import.meta.url);
const credits = ['# Photo credits', '', 'All eval photos are from Wikimedia Commons under the licenses shown.', ''];
const seen = new Set();
for (const c of cases) {
  await new Promise((s) => setTimeout(s, 2500));
  const out = new URL(c.id + '.jpg', dir);
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=${encodeURIComponent('File:' + c.file)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1024`;
  const p = Object.values((await (await get(api)).json()).query.pages)[0];
  const ii = p.imageinfo?.[0];
  if (!ii) { console.log('missing', c.id, c.file); continue; }
  const meta = ii.extmetadata ?? {};
  const artist = String(meta.Artist?.value ?? 'unknown').replace(/<[^>]+>/g, '').trim();
  credits.push(`- ${c.id}.jpg: "${c.file}" by ${artist}, ${meta.LicenseShortName?.value ?? '?'}, ${ii.descriptionurl}`);
  if (!fs.existsSync(out)) {
    const r = await get(ii.thumburl ?? ii.url);
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    
  }
  console.log('ok', c.id);
}
fs.writeFileSync(new URL('ATTRIBUTION.md', dir), credits.join('\n') + '\n');
