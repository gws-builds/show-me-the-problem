// Shared by the start page (creates a call) and the Agent Console (read-only view).
const page = document.currentScript.dataset.page;
const $ = (s) => document.getElementById(s);

if (page === 'index') {
  $('start').addEventListener('click', async () => {
    $('start').disabled = true; $('err').textContent = '';
    const r = await fetch('/api/calls', { method: 'POST' }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { $('err').textContent = j.error || 'Could not start a call.'; $('start').disabled = false; return; }
    $('camLink').href = `/call#${j.id}.${j.camToken}`; $('ownerLink').href = `/owner#${j.id}.${j.ownerToken}`; $('consoleLink').href = `/console#${j.id}`;
    $('links').hidden = false;
  });
}

if (page === 'console') {
  const id = location.hash.slice(1);
  const CAP = 0.25; let frameKey = '';
  const line = (kind, title, detail) => {
    const li = document.createElement('li'); li.className = kind;
    const k = document.createElement('span'); k.className = 'k'; k.textContent = title; li.append(k);
    if (detail) { const c = document.createElement('code'); c.textContent = detail; li.append(c); }
    return li;
  };
  const describe = (e) => {
    switch (e.kind) {
      case 'caller': return line('caller', 'Caller', e.text);
      case 'tool': return line('tool', `Tool: ${e.name}`, `${JSON.stringify(e.args)} → ${JSON.stringify(e.output).slice(0, 400)}  ($${Number(e.spentUsd).toFixed(4)} so far)`);
      case 'sam': return line('tool', 'SAM 3.1', `"${e.part}": ${e.boxes} box(es)`);
      case 'track': return line('tool', 'SAM tracking', `check ${e.check} for "${e.part}": ${e.boxes} box(es)`);
      case 'verify': return line('verify', `Verifier: ${e.result.action}`, e.result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('  '));
      case 'code_gate': return line('code_gate', 'Code gate', e.text);
      case 'owner_paged': return line('owner_paged', 'Owner paged', e.reason);
      case 'booking_requested': return line('verify', 'Booking waits for the owner', `slot ${e.slot}`);
      case 'owner_decision': return line(e.approved ? 'say' : 'error', e.approved ? 'Owner approved' : 'Owner declined', e.slot);
      case 'annotated': return line('tool', 'Muse Image', e.ok ? 'part marked on the visit photo' : 'no image returned');
      case 'say': return line('say', `Agent says (${e.status})`, e.text);
      case 'error': return line('error', 'Error', e.text);
      default: return line('', e.kind, JSON.stringify(e).slice(0, 200));
    }
  };
  const draw = (boxes) => {
    const img = $('still'); const ov = $('ov'); const r = ov.getBoundingClientRect();
    ov.width = r.width; ov.height = r.height; const g = ov.getContext('2d'); g.clearRect(0, 0, r.width, r.height);
    if (!img.naturalWidth || !boxes?.length) return;
    const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const ox = (r.width - img.naturalWidth * s) / 2; const oy = (r.height - img.naturalHeight * s) / 2;
    g.lineWidth = 3; g.strokeStyle = '#22c3a6'; g.font = '12px system-ui'; g.fillStyle = '#22c3a6';
    for (const b of boxes) { const k = img.naturalWidth / b.width; g.strokeRect(ox + b.x1 * k * s, oy + b.y1 * k * s, (b.x2 - b.x1) * k * s, (b.y2 - b.y1) * k * s); if (b.score != null) g.fillText(`${b.ordinal} · ${b.score.toFixed(2)}`, ox + b.x1 * k * s + 4, oy + b.y1 * k * s + 14); }
  };
  const render = (v, live) => {
    $('status').textContent = v.status.replace('_', ' '); $('status').className = `pill ${v.status}`;
    $('mode').textContent = live ? 'live' : 'recorded call';
    $('meter').style.width = `${Math.min(100, (v.spentUsd / CAP) * 100)}%`;
    $('cost').textContent = `$${Number(v.spentUsd).toFixed(4)} of the $${CAP.toFixed(2)} per-call limit`;
    const tl = $('tl'); tl.replaceChildren(...v.events.map(describe));
    if (v.booking) { $('bookingCard').hidden = false; $('booking').textContent = v.booking.approved ? `Approved by the owner: ${v.booking.slot.label}` : 'Declined by the owner'; }
    $('part').textContent = v.part ? `Looking for: ${v.part}` : '';
  };
  async function poll() {
    let r = await fetch(`/api/calls/${id}`).catch(() => null);
    if (r?.ok) {
      const v = await r.json(); render(v, true);
      const key = `${v.events.length}`;
      if (v.hasFrame && key !== frameKey) { frameKey = key; $('still').onload = () => draw(v.boxes); $('still').src = `/api/calls/${id}/still?k=${key}`; } else draw(v.boxes);
      setTimeout(poll, 1500); return;
    }
    r = await fetch(`/api/runs/${id}`).catch(() => null);
    if (r?.ok) { const v = await r.json(); render({ ...v, part: '' }, false); return; }
    $('status').textContent = 'not found';
  }
  if (/^[a-f0-9]{32}$/.test(id)) poll(); else $('status').textContent = 'no call id';
}
