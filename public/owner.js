const [id, owner] = location.hash.slice(1).split('.');
const $ = (s) => document.getElementById(s);
let decided = false;
let annShown = false;
let stillKey = '';
const money = (c) => `$${(c / 100).toFixed(2)}`;
const el = (tag, text) => {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  return e;
};
async function decide(approve) {
  $('yes').disabled = $('no').disabled = true;
  const r = await fetch(`/api/calls/${id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-owner-token': owner },
    body: JSON.stringify({ approve }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    $('brief').textContent = j.error || 'Could not save that.';
    $('yes').disabled = $('no').disabled = false;
    return;
  }
  decided = true;
}
$('yes').addEventListener('click', () => decide(true));
async function confirmSend(send) {
  $('fuSend').disabled = $('fuDrop').disabled = true;
  const r = await fetch(`/api/calls/${id}/confirmation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-owner-token': owner },
    body: JSON.stringify({ send }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    $('fuState').textContent = j.error || 'Could not save that.';
    $('fuSend').disabled = $('fuDrop').disabled = false;
  }
}
$('fuSend').addEventListener('click', () => confirmSend(true));
$('fuDrop').addEventListener('click', () => confirmSend(false));
// Glimmer's draft: the truck list (each item cites evidence) and the text that waits for Send.
function renderFollowUp(f, mobile) {
  $('fu').hidden = !f;
  if (!f) return;
  // A real text when the caller gave a mobile; its delivery is reported as the carrier reports it.
  const texted = f.text
    ? f.text.state === 'delivered'
      ? `Texted to ${f.text.to}: delivered.`
      : f.text.state === 'failed'
        ? `Text to ${f.text.to} failed: ${f.text.reason}.`
        : `Text to ${f.text.to}: ${f.text.state}.`
    : '';
  const say = {
    running: 'Drafting the truck list and the confirmation text…',
    failed: 'The follow-up draft did not finish. Text the customer yourself.',
    sent: `Shown on the customer's screen. ${texted}`.trim(),
    dropped: 'Not sent.',
  };
  $('fuSend').textContent = mobile ? `Text it to ${mobile}` : "Show on the customer's screen";
  $('fuState').textContent =
    f.status === 'draft'
      ? `Draft ready in ${(f.ms / 1000).toFixed(1)} s, about $${f.costUsd.toFixed(3)} of GPU time for the draft (start-up and idle time not included)${f.dropped ? `; ${f.dropped} item(s) dropped for citing no evidence` : ''}. Nothing goes out until you tap it.`
      : (say[f.status] ?? '');
  $('fuParts').replaceChildren(...(f.parts ?? []).map((p) => el('li', `${p.item}: ${p.why} [${p.cites.join(', ')}]`)));
  $('fuText').textContent = f.confirmation ? `Text to customer: "${f.confirmation}"` : '';
  $('fuBtns').hidden = f.status !== 'draft';
}
$('no').addEventListener('click', () => decide(false));

// The evidence still: the real kept frame, with the SAM outline drawn in code (never generated).
// The outcome in the owner's terms: how fast the quote was ready, what it was worth, and what it cost
// them (one tap). Shown once there is a quote.
function renderResults(r) {
  if (!r || r.minutesToQuote == null) {
    $('results').hidden = true;
    return;
  }
  $('results').hidden = false;
  $('rQuote').textContent = r.minutesToQuote < 1 ? 'under a minute' : `${r.minutesToQuote} min`;
  $('rValue').textContent = r.quotedCents != null ? money(r.quotedCents) : 'on site';
  $('rTaps').textContent = r.booked ? 'one tap to book' : r.ownerTaps ? 'one tap' : 'no calls taken';
}

function renderWorkOrder(wo, evidence) {
  if (!wo) {
    $('woCard').hidden = true;
    return;
  }
  $('woCard').hidden = false;
  const byId = Object.fromEntries((evidence ?? []).map((e) => [e.id, e]));
  const rows = [];
  const add = (dt, dd) => {
    if (dd) rows.push(el('dt', dt), el('dd', dd));
  };
  if (wo.plate) add('Rating plate', `${wo.plate.claim} [${wo.plate.evidence}]`);
  add(
    'Equipment',
    wo.equipment
      ? `${wo.equipment.claim} [${wo.equipment.evidence}, frame ${wo.equipment.frame}]`
      : 'Not outlined on camera',
  );
  for (const o of wo.observations) add('Seen on camera', `${o.claim} [${o.evidence}, frame ${o.frame}]`);
  add(
    'Likely worn part',
    wo.hypothesis
      ? `${wo.hypothesis.claim} [${wo.hypothesis.evidence}; cites ${wo.hypothesis.cites.join(', ')}]`
      : 'No hypothesis recorded',
  );
  add('Parts to bring', wo.partsToBring);
  for (const s of wo.shutoff) add('Water shut-off', `${s.claim} [${s.evidence}]`);
  add(
    'Hazards',
    wo.hazards.length
      ? wo.hazards
          .map((h) => `${h.status.toUpperCase()}: ${h.label}${h.frame ? ` (frame ${h.frame})` : ''}. ${h.detail}`)
          .join(' · ')
      : 'None found',
  );
  add('Checks', wo.checks.map((c) => `${c.label}: ${c.status}${c.frame ? ` (frame ${c.frame})` : ''}`).join(' · '));
  add(
    'Quote',
    wo.quote ? `${wo.quote.label}, ${money(wo.quote.priceCents)} (${wo.quote.source})` : 'Technician confirms on site',
  );
  add('Visit', wo.slot?.label);
  add('Caller said', wo.callerSaid.join(' · '));
  if (wo.references?.length)
    add('Manual references', wo.references.map((r) => `${r.cite} [${r.evidence}]`).join(' · '));
  add('Note', wo.note);
  // Muse Wonder's order of checks: each step cites the evidence it rests on; code dropped any that did not.
  const rv = wo.review;
  if (rv?.status === 'running') add('Technician plan', 'Muse Wonder is reviewing the evidence…');
  if (rv?.status === 'done') {
    rv.steps.forEach((s, i) =>
      add(i ? '' : 'Technician plan (Muse Wonder)', `${i + 1}. ${s.step} [${s.cites.join(', ')}]`),
    );
    if (rv.gaps.length) add('Not established on the call', rv.gaps.join(' · '));
  }
  $('wo').replaceChildren(...rows);
  const ev = wo.equipment ? byId[wo.equipment.evidence] : null;
  if (ev?.frame && ev.geo) {
    const key = `${ev.id}`;
    $('woStill').hidden = false;
    $('woStillNote').textContent =
      `Frame ${ev.frame}: the real camera frame; the outline is drawn in code from the SAM 3.1 mask (confidence ${Number(ev.confidence).toFixed(2)}).`;
    const draw = () =>
      Overlay.draw($('woOv'), $('woImg').naturalWidth, $('woImg').naturalHeight, {
        records: [{ geo: ev.geo, score: ev.confidence }],
        part: ev.part,
      });
    if (key !== stillKey) {
      stillKey = key;
      $('woImg').onload = draw;
      $('woImg').src = `/api/calls/${id}/frames/${ev.frame}?t=${encodeURIComponent(owner)}`;
    } else draw();
  }
}

async function poll() {
  try {
    const r = await fetch(`/api/calls/${id}`, { headers: { 'x-owner-token': owner } });
    if (!r.ok) {
      $('idle').textContent = 'This call has ended.';
      return;
    }
    const v = await r.json();
    $('status').textContent = v.status.replace('_', ' ');
    $('status').className = `pill ${v.status}`;
    const pages = $('pages');
    pages.replaceChildren();
    for (const p of v.pages) {
      const d = document.createElement('div');
      d.className = 'card';
      d.style.borderColor = p.urgent === false ? 'var(--warn)' : 'var(--bad)';
      d.append(
        el('h2', p.urgent === false ? 'Note from the call' : 'Urgent: call the customer now'),
        el('p', p.reason),
      );
      pages.append(d);
    }
    $('idle').hidden = Boolean(v.pending || v.pages.length || v.booking);
    if (v.pending && !v.booking) {
      $('pendingCard').hidden = false;
      $('slot').textContent = `When: ${v.pending.slot.label}`;
      $('quote').textContent = v.pending.quote
        ? `Quoted from your list: ${v.pending.quote.label}, ${money(v.pending.quote.priceCents)}`
        : 'No price quoted: the technician confirms on site.';
      $('brief').textContent = `Tech brief: ${v.pending.brief}`;
      $('woH').textContent = 'Work order (draft until you approve)';
      renderWorkOrder(v.pending.workOrder, v.evidence);
    } else $('pendingCard').hidden = true;
    renderResults(v.results);
    if (v.booking) {
      $('doneCard').hidden = false;
      $('doneH').textContent = v.booking.approved ? `Booked: ${v.booking.slot.label}` : 'Declined';
      $('calRow').hidden = !v.booking.approved;
      if (v.booking.approved) $('cal').href = `/api/calls/${id}/booking.ics?t=${encodeURIComponent(owner)}`;
      $('woH').textContent = 'Technician work order';
      renderWorkOrder(v.booking.workOrder && { ...v.booking.workOrder, review: v.booking.review }, v.evidence);
      renderFollowUp(v.booking.followUp ?? null, v.mobile);
      if (v.annotated && !annShown) {
        const a = await fetch(`/api/calls/${id}/annotated`, { headers: { 'x-owner-token': owner } });
        if (a.ok) {
          $('ann').src = URL.createObjectURL(await a.blob());
          $('ann').hidden = false;
          $('annNote').hidden = false;
          annShown = true;
        }
      }
    }
  } catch {
    /* retry */
  }
  setTimeout(poll, decided ? 2500 : 1500);
}
if (id && owner) poll();
else $('idle').textContent = 'This owner link is incomplete.';
