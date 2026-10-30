// Draws what the models found on top of a video or still, in code: SAM mask outlines
// (from the coarse mask grid the server computes), the guidance arrow, the lock ring,
// and hazard outlines in red. Shared by the camera page, the console and the work order.
window.Overlay = (() => {
  const COLORS = { part: '#22c3a6', locked: '#22c55e', hazard: '#ef4444', unconfirmed: '#f5a524' };

  // Where media of size mw x mh lands inside a box of size cw x ch with object-fit: contain.
  function fit(cw, ch, mw, mh) {
    const s = Math.min(cw / mw, ch / mh);
    return { x: (cw - mw * s) / 2, y: (ch - mh * s) / 2, w: mw * s, h: mh * s };
  }

  // One SAM record: geo = { box:{x,y,w,h}, grid:{w,h,rows} } normalized to the frame.
  function drawRecord(g, r, geo, color, label, alpha = 1) {
    if (!geo) return;
    const bx = r.x + geo.box.x * r.w; const by = r.y + geo.box.y * r.h; const bw = geo.box.w * r.w; const bh = geo.box.h * r.h;
    g.globalAlpha = alpha;
    if (geo.grid) {
      const { w, h, rows } = geo.grid; const cw = bw / w; const ch = bh / h;
      const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] === '1';
      g.fillStyle = color; g.globalAlpha = alpha * 0.25;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) g.fillRect(bx + x * cw, by + y * ch, cw + 0.5, ch + 0.5);
      g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = Math.max(2, Math.min(r.w, r.h) / 160); g.beginPath();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!on(x, y)) continue;
        const X = bx + x * cw; const Y = by + y * ch;
        if (!on(x, y - 1)) { g.moveTo(X, Y); g.lineTo(X + cw, Y); }
        if (!on(x, y + 1)) { g.moveTo(X, Y + ch); g.lineTo(X + cw, Y + ch); }
        if (!on(x - 1, y)) { g.moveTo(X, Y); g.lineTo(X, Y + ch); }
        if (!on(x + 1, y)) { g.moveTo(X + cw, Y); g.lineTo(X + cw, Y + ch); }
      }
      g.stroke();
    } else {
      g.strokeStyle = color; g.lineWidth = 3; g.strokeRect(bx, by, bw, bh);
    }
    if (label) {
      const fs = Math.max(12, Math.min(r.w, r.h) / 28); g.font = `700 ${fs}px system-ui, sans-serif`;
      const tw = g.measureText(label).width + 10; const ty = Math.max(r.y, by - fs - 6);
      g.fillStyle = color; g.fillRect(bx, ty, tw, fs + 6); g.fillStyle = '#04110f'; g.fillText(label, bx + 5, ty + fs);
    }
    g.globalAlpha = 1;
  }

  function arrow(g, r, dir, words) {
    const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; const L = Math.min(r.w, r.h) * 0.16;
    const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    if (v) {
      const [dx, dy] = v; const tipX = cx + dx * L * 1.6; const tipY = cy + dy * L * 1.6;
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = L / 3 + 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(tipX, tipY); g.stroke();
      g.strokeStyle = '#fde047'; g.lineWidth = L / 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(tipX, tipY);
      g.moveTo(tipX - dx * L * 0.7 + dy * L * 0.6, tipY - dy * L * 0.7 + dx * L * 0.6); g.lineTo(tipX, tipY);
      g.lineTo(tipX - dx * L * 0.7 - dy * L * 0.6, tipY - dy * L * 0.7 - dx * L * 0.6); g.stroke();
    } else if (dir === 'closer' || dir === 'back') {
      g.strokeStyle = '#fde047'; g.lineWidth = L / 5;
      const s = dir === 'closer' ? 1 : -1;
      for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const ox = cx + ax * L; const oy = cy + ay * L;
        g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + ax * L * 0.6 * s, oy + ay * L * 0.6 * s); g.stroke();
      }
    }
    g.restore();
    if (words) banner(g, r, words, '#fde047');
  }

  function banner(g, r, text, color) {
    const fs = Math.max(14, Math.min(r.w, r.h) / 18); g.font = `700 ${fs}px system-ui, sans-serif`;
    const tw = Math.min(r.w - 16, g.measureText(text).width + 20); const x = r.x + (r.w - tw) / 2; const y = r.y + r.h - fs - 24;
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x, y, tw, fs + 14);
    g.fillStyle = color; g.fillText(text, x + 10, y + fs + 2, tw - 20);
  }

  /**
   * canvas: overlay canvas covering the media element; mw/mh: media pixel size.
   * state: { records, part, guidance, hazards: [{label, geo, status}], showGuidance, ageMs }
   */
  function draw(canvas, mw, mh, state = {}) {
    const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height);
    if (!mw || !mh) return;
    const r = fit(canvas.width, canvas.height, mw, mh);
    const gd = state.guidance; const locked = gd?.state === 'locked';
    // Outlines come from the last analyzed frame: fade them as they age so they never pretend to be live.
    const age = state.ageMs ?? 0; const alpha = locked ? 1 : Math.max(0, 1 - Math.max(0, age - 1500) / 2500);
    (state.records ?? []).slice(0, 1).forEach((rec) => drawRecord(g, r, rec.geo, locked ? COLORS.locked : COLORS.part, `${state.part || 'part'} ${rec.score != null ? rec.score.toFixed(2) : ''}${locked ? ' · LOCKED' : ''}`, alpha));
    for (const h of state.hazards ?? []) drawRecord(g, r, h.geo, h.status === 'found' ? COLORS.hazard : COLORS.unconfirmed, h.label, 1);
    if (state.showGuidance && gd) {
      if (gd.state === 'dark') banner(g, r, 'Too dark: turn on a light', '#fde047');
      else if (gd.state === 'adjust') arrow(g, r, gd.arrow, gd.words.replace(/\.$/, ''));
      else if (gd.state === 'hold') banner(g, r, 'Hold still', '#fde047');
      else if (locked) banner(g, r, 'Locked on', COLORS.locked);
    }
  }

  return { draw, fit };
})();
