// The camera loops that run beside the conversation: part tracking while the caller moves the phone,
// the hazard scan (Spark lists, SAM must agree), and the guided tour's steps. Split out of calls.js
// (red team #7 M12); `deps` are the call core's own helpers.
import { isStop } from '../budget.js';
import { scanFrame, severityOf } from '../hazards.js';
import { maskGeometry } from '../mask.js';
import { PLATE_READS, PLATE_RETRY_MS, runTool } from '../tools.js';
import { tourStep, tourMemo } from '../tour.js';
import { LIMITS, article } from './shared.js';

/** deps: { now, say(c, text, status), note(c, text), autoTurn(c, note), exclusive(c, fn) } */
export function createCameraLoops({ now, say, note, autoTurn, exclusive }) {
  // While the agent waits for the caller to move the camera, SAM re-checks the
  // part on new frames; as soon as it is in view the agent continues by itself.
  async function track(c) {
    const t = c.tracking;
    if (!t?.part || c.busy || c.turnAbort || t.checks >= LIMITS.trackChecks || now() - t.lastAt < LIMITS.trackEveryMs)
      return;
    t.checks++;
    t.lastAt = now();
    await exclusive(c, async () => {
      const r = await runTool('find_part', { part: t.part, recheck: true }, c.ctx).catch((err) => ({
        output: { error: String(err.message) },
      }));
      const good = (r.output?.boxes ?? []).filter((b) => (b.score ?? 1) >= 0.5).length;
      const g = c.session.guidance();
      c.session.log({ kind: 'track', part: t.part, check: t.checks, boxes: good, guidance: g?.state ?? null });
      // Continue once the outline is centred and steady (hold/locked); on the last check, any confident outline will do.
      const ready = good && (g?.state === 'locked' || g?.state === 'hold' || t.checks >= LIMITS.trackChecks);
      if (!ready) {
        if (!good && t.checks >= LIMITS.trackChecks) {
          c.tracking = null;
          say(c, 'I still cannot see it. Could you tap it on your screen, or describe what you see?', 'waiting_caller');
        }
        return;
      }
      c.tracking = null;
      await autoTurn(
        c,
        `[camera] The caller moved the camera. SAM now outlines "${t.part}" (${good} confident object(s), guidance: ${g?.state ?? 'n/a'}). Continue.`,
      );
    });
  }

  // One confirmed camera finding (Spark + SAM agree), from the hazard scan or the tour: checklist,
  // owner page, spoken line. Escalating ones end quoting; the rest are a warning and the call goes on.
  async function raise(c, f, n, source) {
    const sev = severityOf(f);
    const cl = c.session.checklist;
    cl.addCheck?.(f.category);
    const detail = `${f.object}${f.near ? ` near ${f.near}` : ''}: ${f.why} (${source}; SAM outlined it at ${f.score.toFixed(2)})`;
    cl.set(f.category, sev === 'attention' ? 'attention' : 'found', n, detail, {
      geo: f.geo ?? null,
      object: f.object,
    });
    if (c.warned.has(f.category)) return;
    c.warned.add(f.category);
    if (sev === 'escalate') {
      await c.ctx.notifyOwner({
        urgent: true,
        reason: `Camera hazard (${f.category}): ${f.object} in frame ${n}, confirmed by Spark and SAM.`,
      });
      c.session.log({
        kind: 'code_gate',
        name: 'camera hazard',
        text: `${f.category}: ${f.object} seen by Spark and outlined by SAM (${f.score.toFixed(2)}). Escalated in code.`,
      });
      say(
        c,
        `Stop for a moment: I can see ${article(f.object)} that looks unsafe (${f.why || f.category}). I am getting the owner on this now. Please do not touch it.`,
        'escalated',
      );
      if (c.tour) c.tour.done = true;
    } else if (sev === 'attention') {
      await c.ctx.notifyOwner({
        urgent: false,
        reason: `Camera note (${f.category}): ${f.object}, frame ${n}. Not connected to power, so not escalated.`,
      });
      c.session.log({
        kind: 'code_gate',
        name: 'camera attention',
        text: `${f.object}: bare wire on a cord that is not connected to power. Needs attention, not escalated (knowledge-base threshold).`,
      });
      say(
        c,
        `I can see bare wire on ${article(f.object)} that does not look plugged in. Please keep it unplugged and don't use it; the technician should replace it.`,
        c.status,
      );
      // The agent hears the code's judgement, so it does not escalate the same sign again without new evidence.
      note(
        c,
        `[camera check, code] ${f.object}: bare wire on a loose cord or strip that is NOT connected to power (frame ${n}). Knowledge-base threshold: needs attention, not an emergency. Do not escalate this sign again unless you see it plugged in, in a wall box or panel, or the caller reports sparks, heat or smoke. Advise not to use it; the technician replaces it.`,
      );
    } else {
      await c.ctx.notifyOwner({
        urgent: false,
        reason: `Camera warning (${f.category}): ${f.object}${f.near ? ` near ${f.near}` : ''}, frame ${n}.`,
      });
      c.session.log({
        kind: 'code_gate',
        name: 'camera warning',
        text: `${f.object}${f.near ? ` near ${f.near}` : ''}: spoken warning, owner noted. Call continues.`,
      });
      say(
        c,
        `Before anything else: I can see ${article(f.object)}${f.near ? ` close to the ${f.near}` : ''}. Please move it away from the heat.`,
        c.status,
      );
    }
  }

  async function scan(c) {
    const frame = c.session.latestFrame();
    if (!frame) return;
    c.scanning = true;
    c.scans++;
    c.lastScanAt = now();
    try {
      const r = await scanFrame(c.client, frame);
      const n = c.session.keepFrame(frame.n, frame.dataUrl);
      const cl = c.session.checklist;
      for (const id of r.clear) cl.set(id, 'clear', n, 'Nothing seen by Muse Spark in this frame');
      for (const f of r.findings.filter((x) => x.status !== 'found'))
        cl.set(
          f.category,
          'unconfirmed',
          n,
          `Spark saw "${f.object}", SAM could not outline it (${f.score.toFixed(2)}): not escalated`,
        );
      c.session.log({
        kind: 'hazard_scan',
        frame: n,
        staged: Boolean(c.staged),
        clear: r.clear,
        findings: r.findings.map(({ category, object, near, score, status, where, powered }) => ({
          category,
          object,
          near,
          where,
          powered,
          score: Number(score.toFixed(2)),
          status,
        })),
      });
      for (const f of r.findings.filter((x) => x.status === 'found'))
        await raise(c, { ...f, geo: f.record ? maskGeometry(f.record) : null }, n, 'Spark saw it');
    } catch (err) {
      c.session.log({ kind: 'error', text: `hazard scan: ${String(err.message).slice(0, 120)}` });
    } finally {
      c.scanning = false;
    }
  }

  // Guided tour: one step every few seconds while frames arrive. Runs beside the conversation.
  async function tourTick(c) {
    const frame = c.session.latestFrame();
    if (!frame || !c.tour || c.tour.done) return;
    c.touring = true;
    c.lastTourAt = now();
    try {
      const r = await tourStep(c.client, c.tour, frame);
      const n = c.session.keepFrame(frame.n, frame.dataUrl);
      c.session.log({
        kind: 'tour',
        frame: n,
        step: c.tour.step,
        room: c.tour.room,
        items: r.items.map(({ id, label, status, evidence, score, note, confirmScore }) => ({
          id,
          label,
          status,
          evidence,
          score: score != null ? Number(score.toFixed(2)) : null,
          confirmScore: confirmScore != null ? Number(confirmScore.toFixed(2)) : null,
          note,
        })),
      });
      for (const it of r.items.filter((x) => x.status === 'attention' || x.status === 'safety')) {
        if (!c.session.evidence.list().some((e) => e.kind === 'tour' && e.part === it.id && e.status === it.status))
          c.session.evidence.add({
            kind: 'tour',
            part: it.id,
            status: it.status,
            claim: `${it.label}: ${it.status === 'safety' ? 'safety issue' : 'needs attention'}, ${it.evidence}`,
            frame: n,
            confidence: it.score ?? 0.5,
            geo: it.geo ?? null,
            support: 'Muse Spark on this frame; SAM outline',
          });
      }
      for (const it of [...r.escalate, ...r.warn])
        await raise(
          c,
          {
            category: it.hazard.category,
            object: it.label.toLowerCase(),
            near: '',
            why: it.evidence,
            score: it.confirmScore ?? it.score ?? 0,
            geo: it.geo ?? null,
          },
          n,
          `tour: ${it.hazard.label}`,
        );
      if (c.status === 'escalated') return;
      // The owner decided while this step ran: the tour stays over and says nothing more (red team #9 L1).
      if (c.status === 'booked' || c.status === 'declined') {
        c.tour.done = true;
        return;
      }
      // A step that finished while the caller was being answered keeps its labels but not its line.
      const held = !r.done && (c.busy || now() < (c.holdTourUntil ?? 0));
      if (r.say && !held) {
        say(c, `${c.tourResume && !r.done ? 'Back to the tour. ' : ''}${r.say}`, r.done ? 'waiting_caller' : 'touring');
        c.tourResume = false;
      }
      if (r.done) {
        note(c, tourMemo(c.tour));
        say(c, 'Would you like a price for a visit to look at any of this?', 'waiting_caller');
        c.session.log({
          kind: 'tour_done',
          text: `Tour of the ${c.tour.room.replace('_', ' ')} finished after ${c.tour.step} steps.`,
        });
      }
    } catch (err) {
      c.session.log({ kind: 'error', text: `tour: ${String(err.message).slice(0, 120)}` });
      if (isStop(err)) {
        c.tour.done = true;
        say(
          c,
          'I have to stop the tour here. Thank you for showing me around. The owner will call you back to go over what we saw.',
          'handoff',
        );
      }
    } finally {
      c.touring = false;
    }
  }

  // The caller asked how old the unit is and the label was not legible: re-read it on new frames while they
  // bring it closer or zoom, and say the age as soon as it reads. Bounded by PLATE_READS per call.
  async function plateWatch(c) {
    const want = c.session.plateWanted?.();
    if (!want || c.busy || c.session.plateReads() >= PLATE_READS) return;
    if (c.lastPlateTry && now() - c.lastPlateTry < PLATE_RETRY_MS) return;
    c.lastPlateTry = now();
    await exclusive(c, async () => {
      const r = await runTool('read_plate', { equipment: want }, c.ctx).catch(() => null);
      if (r?.output?.read && r.say) say(c, r.say, c.status);
      else if (c.session.plateReads() >= PLATE_READS) {
        c.session.wantPlate(null);
        say(c, 'I still cannot read that label. The technician will check it on site.', c.status);
      }
    });
  }

  return { track, scan, tourTick, plateWatch };
}
