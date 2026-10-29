const [id, owner] = location.hash.slice(1).split('.');
const $ = (s) => document.getElementById(s);
let decided = false; let annShown = false;
const money = (c) => `$${(c / 100).toFixed(2)}`;
async function decide(approve) {
  $('yes').disabled = $('no').disabled = true;
  const r = await fetch(`/api/calls/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner-token': owner }, body: JSON.stringify({ approve }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || 'Could not save that.'); $('yes').disabled = $('no').disabled = false; return; }
  decided = true;
}
$('yes').addEventListener('click', () => decide(true));
$('no').addEventListener('click', () => decide(false));
async function poll() {
  try {
    const r = await fetch(`/api/calls/${id}`); if (!r.ok) { $('idle').textContent = 'This call has ended.'; return; }
    const v = await r.json();
    $('status').textContent = v.status.replace('_', ' '); $('status').className = `pill ${v.status}`;
    const pages = $('pages'); pages.replaceChildren();
    for (const p of v.pages) { const d = document.createElement('div'); d.className = 'card'; d.style.borderColor = 'var(--bad)'; const h = document.createElement('h2'); h.textContent = 'Urgent: call the customer now'; const t = document.createElement('p'); t.textContent = p.reason; d.append(h, t); pages.append(d); }
    $('idle').hidden = Boolean(v.pending || v.pages.length || v.booking);
    if (v.pending && !v.booking) {
      $('pendingCard').hidden = false;
      $('slot').textContent = `When: ${v.pending.slot.label}`;
      $('quote').textContent = v.pending.quote ? `Quoted from your list: ${v.pending.quote.label}, ${money(v.pending.quote.priceCents)}` : 'No price quoted: the technician confirms on site.';
      $('brief').textContent = `Tech brief: ${v.pending.brief}`;
    } else $('pendingCard').hidden = true;
    if (v.booking) {
      $('doneCard').hidden = false; $('doneH').textContent = v.booking.approved ? `Booked: ${v.booking.slot.label}` : 'Declined';
      if (v.annotated && !annShown) {
        const a = await fetch(`/api/calls/${id}/annotated`, { headers: { 'x-owner-token': owner } });
        if (a.ok) { $('ann').src = URL.createObjectURL(await a.blob()); $('ann').hidden = false; annShown = true; }
      }
    }
  } catch { /* retry */ }
  setTimeout(poll, decided ? 2500 : 1500);
}
if (id && owner) poll(); else $('idle').textContent = 'This owner link is incomplete.';
