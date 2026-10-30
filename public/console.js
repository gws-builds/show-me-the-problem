// Shared by the start page (creates a call) and the Agent Console (read-only view).
const page = document.currentScript.dataset.page;
const $ = (s) => document.getElementById(s);

if (page === 'index') {
  async function open(footage) {
    $('err').textContent = '';
    const r = await fetch(`/api/calls${footage ? `?footage=${encodeURIComponent(footage)}` : ''}`, { method: 'POST' }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { $('err').textContent = j.error || 'Could not start a call.'; return; }
    $('camLink').href = `/call${footage ? `?footage=${encodeURIComponent(footage)}` : ''}#${j.id}.${j.camToken}`;
    $('camLink').textContent = footage ? 'Open the footage call' : 'Open the camera';
    $('ownerLink').href = `/owner#${j.id}.${j.ownerToken}`; $('consoleLink').href = `/console#${j.id}`;
    $('links').hidden = false;
  }
  $('start').addEventListener('click', () => open(null));
  fetch('/api/footage').then((r) => r.json()).then((list) => {
    $('footageButtons').replaceChildren(...list.map((f) => { const b = document.createElement('button'); b.className = 'secondary'; b.textContent = f.title; b.onclick = () => open(f.file); return b; }));
    $('footageCredit').textContent = list.map((f) => f.credit).filter((c, i, a) => a.indexOf(c) === i).join(' ');
  }).catch(() => {});
  fetch('/api/runs').then((r) => r.json()).then((runs) => {
    $('runs').replaceChildren(...runs.map((x) => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = `/console#${x.id}`; a.textContent = `${new Date(x.at).toLocaleString()} · ${x.status} · ${x.turns} lines${x.staged ? ' · staged scene' : ''}${x.footage ? ' · footage mode' : ''}`; li.append(a); return li; }));
    if (!runs.length) $('runs').textContent = 'None yet.';
  }).catch(() => {});
}

if (page === 'console') {
  // "#latest" follows the newest call (a recording session captures this page while takes change).
  const follow = location.hash.slice(1) === 'latest';
  let id = follow ? '' : location.hash.slice(1);
  let frameKey = ''; let lastView = null;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const line = (kind, title, detail) => {
    const li = el('li', kind); li.append(el('span', 'k', title));
    if (detail) li.append(el('code', '', detail));
    return li;
  };
  const describe = (e) => {
    switch (e.kind) {
      case 'caller': return line('caller', 'Caller', e.text);
      case 'tool': return line('tool', `Tool: ${e.name}`, `${JSON.stringify(e.args)} → ${JSON.stringify(e.output).slice(0, 400)}  ($${Number(e.spentUsd).toFixed(4)} so far)`);
      case 'sam': return line('tool', `SAM 3.1 (${e.method})`, `"${e.noun}" for "${e.part}": ${e.boxes} object(s)${e.score != null ? `, best ${Number(e.score).toFixed(2)}` : ''}${e.frame ? `, frame ${e.frame}` : ''}  tries: ${(e.tries || []).map((t) => `${t.method}:${t.noun}=${t.n}${t.score != null ? `@${Number(t.score).toFixed(2)}` : ''}`).join(', ')}`);
      case 'track': return line('tool', 'Guidance', `check ${e.check} for "${e.part}": ${e.boxes} confident outline(s), ${e.guidance ?? ''}`);
      case 'tap': return line('tool', 'Caller tapped', `x ${e.x}, y ${e.y} → SAM point prompt`);
      case 'verify': return line('verify', `Verifier: ${e.result.action}`, e.result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('  '));
      case 'hazard_scan': return line(e.findings.some((f) => f.status === 'found') ? 'code_gate' : 'verify', `Hazard scan, frame ${e.frame}${e.staged ? ' (staged scene)' : ''}`, e.findings.length ? e.findings.map((f) => `${f.category}: ${f.object}${f.near ? ` near ${f.near}` : ''} SAM ${f.score} → ${f.status}`).join('; ') : `clear: ${e.clear.join(', ')}`);
      case 'hypothesis': return line(e.ok ? 'verify' : 'error', e.ok ? 'Hypothesis accepted' : 'Hypothesis refused', `${e.text}${e.cites?.length ? ` (cites ${e.cites.join(', ')})` : ''}`);
      case 'lighting': return line('verify', 'Lighting check', `${e.text} (light ${e.luma}/255, frame ${e.frame})`);
      case 'latency': return line('say', 'Turn latency', `${(e.ms / 1000).toFixed(1)} s (${e.channel})`);
      case 'echo_dropped': return line('', 'Echo dropped', e.text);
      case 'staged': return line('code_gate', 'Staged scene', e.text);
      case 'footage': return line('verify', 'Footage mode', e.text);
      case 'code_gate': return line('code_gate', `Code gate${e.name ? `: ${e.name}` : ''}`, e.text);
      case 'owner_paged': return line('owner_paged', 'Owner paged', e.reason);
      case 'booking_requested': return line('verify', 'Booking waits for the owner', `slot ${e.slot}`);
      case 'owner_decision': return line(e.approved ? 'say' : 'error', e.approved ? 'Owner approved' : 'Owner declined', e.slot);
      case 'annotated': return line('tool', 'Muse Image', e.ok ? 'illustration made (labelled, not evidence)' : 'no image returned');
      case 'say': return line('say', `Agent says (${e.status})`, e.text);
      case 'error': return line('error', 'Error', e.text);
      case 'tour_start': return line('code_gate', 'Guided tour', e.text);
      case 'tour_done': return line('say', 'Tour finished', e.text);
      case 'plate': return line(e.ok ? 'verify' : 'error', 'Rating plate', e.ok ? `${e.summary} (frame ${e.frame})` : 'no legible plate in this frame');
      case 'kb_ref': return line('tool', 'Trade manuals (local search)', e.refs.map((r) => r.cite).join('; '));
      case 'tour': return line(e.items.some((i) => i.status === 'safety') ? 'code_gate' : 'tool', `Tour step ${e.step}, frame ${e.frame} (${String(e.room).replace('_', ' ')})`, e.items.length ? e.items.map((i) => `${i.label}: ${i.status}${i.evidence ? ` (${i.evidence})` : ''}${i.score != null ? ` SAM ${i.score}` : ''}${i.note ? ` [${i.note}]` : ''}`).join('; ') : 'nothing named in this frame');
      case 'kb': return line('verify', 'Knowledge base', `cards in the agent's context: ${e.cards.join(', ') || 'none'}`);
      default: return line('', e.kind, JSON.stringify(e).slice(0, 200));
    }
  };
  const thumb = (n, live) => { if (!n || !live) return null; const i = el('img'); i.alt = `frame ${n}`; i.loading = 'lazy'; i.src = `/api/calls/${id}/frames/${n}`; return i; };
  const render = (v, live) => {
    lastView = v;
    $('status').textContent = v.status.replace('_', ' '); $('status').className = `pill ${v.status}`;
    $('mode').textContent = `${live ? 'live' : 'recorded call (replay)'}${v.footage ? ' · footage mode (recorded clip, analyzed live)' : ''}`;
    $('staged').hidden = $('stagedOnStill').hidden = !v.staged;
    const cap = v.capUsd ?? 0.25;
    $('meter').style.width = `${Math.min(100, (v.spentUsd / cap) * 100)}%`;
    $('cost').textContent = `$${Number(v.spentUsd).toFixed(4)} of the $${cap.toFixed(2)} per-call limit`;
    $('tourCard').hidden = !v.tour;
    if (v.tour) {
      $('tourH').textContent = `Found in this room: ${v.tour.roomLabel} (${v.tour.done ? 'tour finished' : `step ${v.tour.step} of ${v.tour.steps}`})`;
      $('found').replaceChildren(...v.tour.found.map((f) => {
        const li = el('li', `fnd ${f.status}`); li.append(el('span', 'st', f.statusWords), el('strong', '', ` ${f.label}`));
        const t = thumb(f.frame, live); if (t) li.append(t);
        li.append(el('div', 'small', [f.evidence, f.better ? `needs: ${f.better}` : '', f.note, `frame ${f.frame}`, f.score != null ? `SAM ${Number(f.score).toFixed(2)}` : 'not outlined'].filter(Boolean).join(' · ')));
        return li;
      }));
    }
    const lat = Array.isArray(v.latency) ? { p50: [...v.latency].sort((a, b) => a - b)[Math.floor(v.latency.length / 2)], n: v.latency.length } : v.latency;
    $('lat').textContent = lat?.n ? `Turn latency p50 ${(lat.p50 / 1000).toFixed(1)} s over ${lat.n} turn(s), measured from the end of speech (voice) or the message (typed) to the agent's line.` : '';
    $('tl').replaceChildren(...v.events.map(describe));
    $('checks').replaceChildren(...(v.checklist ?? []).map((c) => {
      const li = el('li', `chk ${c.status}`); li.append(el('span', 'st', c.status), el('span', '', ` ${c.label}`));
      if (c.frame) { li.append(el('span', 'small', ` frame ${c.frame}`)); const t = thumb(c.frame, live); if (t) li.append(t); }
      if (c.detail) li.append(el('div', 'small', c.detail));
      return li;
    }));
    $('evidence').replaceChildren(...(v.evidence ?? []).map((e) => {
      const li = el('li', e.kind === 'not_visible' ? 'unsupported' : ''); li.append(el('strong', '', `${e.id} `), el('span', '', `${e.claim}`));
      li.append(el('div', 'small', `${e.kind} · ${e.support ?? ''}${e.frame ? ` · frame ${e.frame}` : ''}${e.confidence != null ? ` · confidence ${Number(e.confidence).toFixed(2)}` : ''}${e.cites ? ` · cites ${e.cites.join(', ')}` : ''}`));
      return li;
    }));
    if (v.booking) { $('bookingCard').hidden = false; $('booking').textContent = v.booking.approved ? `Approved by the owner: ${v.booking.slot.label}` : 'Declined by the owner'; }
    $('part').textContent = v.part ? `Looking for: ${v.part}${v.guidance ? ` · guidance: ${v.guidance.state}${v.guidance.arrow ? ` (${v.guidance.arrow})` : ''}` : ''}` : '';
  };
  const draw = () => {
    const img = $('still'); const v = lastView; if (!v) return;
    const t = v.tour;
    Overlay.draw($('ov'), img.naturalWidth, img.naturalHeight, { records: v.boxes ?? [], part: v.part, guidance: v.guidance, showGuidance: true,
      hazards: (v.checklist ?? []).filter((c) => c.geo && c.status === 'found').map((c) => ({ label: Overlay.hazardLabel(c), geo: c.geo, status: c.status })),
      tourItems: t ? t.found.filter((f) => f.geo && f.geoFrame === t.lastFrame).map((f) => ({ geo: f.geo, label: `${f.label} · ${f.statusWords}`, status: f.status })) : [] });
  };
  async function poll() {
    if (follow) {
      const l = await fetch('/api/calls/latest').then((x) => x.json()).catch(() => ({}));
      if (l.id && l.id !== id) { id = l.id; frameKey = ''; $('still').hidden = true; }
      if (!id) { $('status').textContent = 'waiting for a call'; setTimeout(poll, 2000); return; }
    }
    let r = await fetch(`/api/calls/${id}`).catch(() => null);
    if (r?.ok) {
      const v = await r.json(); render(v, true);
      const key = `${v.events.length}`;
      if (v.hasFrame && key !== frameKey) { frameKey = key; $('still').onload = () => { $('still').hidden = false; draw(); }; $('still').src = `/api/calls/${id}/still?k=${key}`; } else draw();
      setTimeout(poll, 1500); return;
    }
    r = await fetch(`/api/runs/${id}`).catch(() => null);
    if (r?.ok) { const v = await r.json(); render({ ...v, part: '' }, false); if (follow) setTimeout(poll, 2000); return; }
    $('status').textContent = 'not found';
    if (follow) setTimeout(poll, 2000);
  }
  if (follow || /^[a-f0-9]{32}$/.test(id)) poll(); else $('status').textContent = 'no call id';
}
