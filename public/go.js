// Take picker for a recording session: one tap = a new call + the camera page with that take's script.
const $ = (s) => document.getElementById(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
fetch('/api/health').then((r) => r.json()).then((h) => { $('mode').textContent = `${h.mode}${h.session?.stopUsd != null ? ` · stop $${h.session.stopUsd}` : ''}`; }).catch(() => {});
fetch('/takes.json').then((r) => r.json()).then((takes) => {
  $('takes').replaceChildren(...takes.map((t) => {
    const card = el('div', 'card');
    card.append(el('h2', '', t.title), el('p', 'small', t.setup));
    const b = el('button', '', 'Start this take');
    b.onclick = async () => {
      b.disabled = true; $('err').textContent = '';
      const r = await fetch('/api/calls', { method: 'POST' }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (!r?.ok) { $('err').textContent = j.error || 'Could not start a call.'; b.disabled = false; return; }
      // The owner link rides in the fragment (never sent to the server): in a recording take the founder plays the owner too.
      location.href = `/call?take=${encodeURIComponent(t.id)}#${j.id}.${j.camToken}.${j.ownerToken}`;
    };
    card.append(b);
    return card;
  }));
}).catch(() => { $('err').textContent = 'Could not load the takes.'; });
