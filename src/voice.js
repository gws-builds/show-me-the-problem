// Hands-free voice: the browser streams 16 kHz PCM to our server, which relays it to
// Meta's realtime transcription (wss://api.meta.ai/v1/asr/realtime, ENDPOINTING mode).
// The API key is added here, server-side, and never reaches the browser.
//   speechStart  -> the browser stops the agent's voice (barge-in)
//   transcript   -> live partial text on screen
//   speechComplete -> one caller turn for the agent; latency = speech end -> agent line
// Echo of the agent's own voice is dropped in code before it can become a turn.
import { MODELS } from './meta.js';

export const REALTIME_URL = process.env.META_REALTIME_URL || 'wss://api.meta.ai/v1/asr/realtime';
export const BYTES_PER_SECOND = 32_000; // PCM_16KHZ: 16-bit mono
export const METER_EVERY_S = 10; // audio is priced into the ledger every 10 s streamed
export const MAX_SESSION_S = 15 * 60;

const words = (s) => String(s).toLowerCase().match(/[a-z0-9áéíóúñü']+/g) ?? [];

/** True when a heard line is mostly the agent's own last line (its voice came back through the mic). */
export function isEcho(heard, agentLines) {
  const w = words(heard);
  if (w.length < 2) return w.length === 0 || agentLines.some((l) => words(l).includes(w[0]) && words(l).length < 4);
  return agentLines.some((line) => {
    const set = new Set(words(line));
    if (!set.size) return false;
    return w.filter((x) => set.has(x)).length / w.length >= 0.7;
  });
}

export function handshake(apiKey) {
  return {
    authorization: { accessToken: `Bearer ${apiKey}` },
    audioEncoding: 'PCM_16KHZ', model: MODELS.transcribe, mode: 'ENDPOINTING', partialMode: 'CUMULATIVE',
    emitAudioProgress: false, languageBias: ['English', 'Spanish'],
  };
}

/**
 * One voice session for one call.
 * deps: { calls, callId, client (Meta client for pricing), apiKey, openUpstream(url) -> WebSocket-like,
 *         toClient(obj), now }
 * Returns { audio(buf), end() }.
 */
export function createVoiceSession({ calls, callId, client, apiKey, openUpstream, toClient, now = () => Date.now() }) {
  let ready = false; let closed = false; let unmetered = 0; let total = 0; let speechEndAt = null; const queue = [];
  const send = (o) => { try { toClient(o); } catch { /* client gone */ } };
  const meter = (force = false) => {
    if (!unmetered || (!force && unmetered < METER_EVERY_S * BYTES_PER_SECOND)) return;
    const seconds = unmetered / BYTES_PER_SECOND; unmetered = 0;
    // A spend stop ends this voice session only; it must never throw into the socket listener (red team 10/31: that took the server down).
    try { client.recordUsage(MODELS.transcribe, { seconds }); } catch { send({ type: 'error', message: 'Voice stopped: spending limit.' }); end(); }
  };
  client.assertCanSpend();
  const up = openUpstream(REALTIME_URL);
  up.binaryType = 'arraybuffer';
  up.onopen = () => up.send(JSON.stringify(handshake(apiKey)));
  up.onmessage = async (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (!m.type) { ready = true; send({ type: 'ready' }); while (queue.length) up.send(queue.shift()); return; }
    if (m.type === 'speechStart') return send({ type: 'speechStart' });
    if (m.type === 'transcript') return send({ type: 'partial', text: String(m.transcript ?? '').slice(0, 300) });
    if (m.type === 'speechEnd') { speechEndAt = now(); return send({ type: 'speechEnd' }); }
    if (m.type === 'speechComplete') {
      const text = String(m.transcript ?? '').trim().slice(0, 300);
      const endAt = speechEndAt ?? now(); speechEndAt = null;
      if (!text) return;
      const agentLines = calls.recentSays(callId, 2);
      if (isEcho(text, agentLines)) { calls.logEvent(callId, { kind: 'echo_dropped', text }); return send({ type: 'ignored', text }); }
      send({ type: 'final', text });
      send({ type: 'thinking' });
      try { await calls.voiceTurn(callId, text, { speechEndAt: endAt }); } catch (err) { send({ type: 'error', message: String(err.message).slice(0, 120) }); }
      return;
    }
    if (m.type === 'error') { send({ type: 'error', message: 'Voice service error. Use hold-to-talk.' }); calls.logEvent(callId, { kind: 'error', text: `realtime: ${String(m.message).slice(0, 120)}` }); }
  };
  up.onclose = (ev) => { if (!closed) { send({ type: 'closed', code: ev?.code ?? 1006 }); end(); } };
  up.onerror = () => {};

  function end() {
    if (closed) return; closed = true;
    try { meter(true); } catch { /* recorded what we could */ }
    try { if (up.readyState === 1) up.send(JSON.stringify({ type: 'endStream' })); up.close?.(1000); } catch { /* gone */ }
  }
  return {
    audio(buf) {
      if (closed || !Buffer.isBuffer(buf) || buf.length === 0 || buf.length % 2) return;
      total += buf.length; unmetered += buf.length;
      if (total > MAX_SESSION_S * BYTES_PER_SECOND) { send({ type: 'closed', code: 1000, reason: 'max length' }); end(); return; }
      if (ready) up.send(buf); else if (queue.length < 50) queue.push(buf);
      meter();
    },
    end,
    /** Half-close: no more audio, but keep reading until the service sends its last turn and closes. */
    finish() { if (closed) return; try { meter(true); } catch { /* recorded */ } try { if (ready) up.send(JSON.stringify({ type: 'endStream' })); } catch { /* gone */ } setTimeout(end, 8000).unref?.(); },
    get seconds() { return total / BYTES_PER_SECOND; },
    get closed() { return closed; },
  };
}
