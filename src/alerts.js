// Phone alerts for a hosted judge copy (founder 10/30: "send me an ntfy each time it gets called/used/accessed
// and by how much ... staying notified that nothing fishy is going on"). Off unless NTFY_TOPIC is set.
// One push per new call and one each time this run's model spend crosses another ALERT_STEP_USD (default $1).
// Nothing personal goes out: counts and dollars only, never an address, IP or what was said.
export function createAlerts({
  topic = process.env.NTFY_TOPIC,
  stepUsd = Number(process.env.ALERT_STEP_USD) || 1,
  fetchImpl = fetch,
  title = 'Build - Unmanually',
} = {}) {
  let calls = 0;
  let step = 0;
  let gpu = 0;
  let lastGpu = -Infinity;
  // Who opened the link, by network address, held in memory only and never sent: the push says "visitor 2",
  // so the founder can tell one judge returning from a new person. shortcut: resets when the container
  // scales to zero; persist it if the counts must span runs.
  const visitors = new Set();
  const push = (text) => {
    console.log(`[usage] ${text}`); // also in the host's logs (modal app logs snap-hosted), topic or not
    if (!topic) return Promise.resolve(false);
    return fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title },
      body: `Build: ${text}`,
      signal: AbortSignal.timeout(5000),
    }).then(
      (r) => r.ok,
      () => false,
    );
  };
  const usd = (n) => `$${n.toFixed(2)}`;
  return {
    on: Boolean(topic),
    linkOpened(key) {
      if (visitors.has(key) || visitors.size >= 10_000) return Promise.resolve(false);
      visitors.add(key);
      return push(`Judge link opened by visitor ${visitors.size} this run (a new network address).`);
    },
    callStarted({ spentUsd = 0, stopUsd = null, footage = false } = {}) {
      calls += 1;
      return push(
        `Judge link: call ${calls} started${footage ? ' (recorded footage)' : ' (live camera)'}. Spent this run ${usd(spentUsd)}${stopUsd ? ` of ${usd(stopUsd)}` : ''}.`,
      );
    },
    // Founder 11/04: Modal spend on the phone too. One push per GPU use, at most one per 5 minutes (a
    // booking warms the GPU, then drafts on it). Modal bills the L40S at $0.000542/s ($1.95/h).
    gpuUsed(now = Date.now()) {
      if (now - lastGpu < 5 * 60e3) return Promise.resolve(false);
      lastGpu = now;
      gpu += 1;
      return push(
        `Modal GPU (Glimmer, L40S, $1.95/h) started for a booking, use ${gpu} this run. It stops 2 min after its last request; one booking with a cold start is roughly $0.15-0.30.`,
      );
    },
    spend({ spentUsd = 0, stopUsd = null } = {}) {
      const now = Math.floor(spentUsd / stepUsd);
      if (now <= step) return Promise.resolve(false);
      step = now;
      return push(
        `Judge link: ${usd(now * stepUsd)} spent so far this run${stopUsd ? ` (stops at ${usd(stopUsd)})` : ''}, ${calls} call${calls === 1 ? '' : 's'}.`,
      );
    },
  };
}
