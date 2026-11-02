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
  const push = (text) => {
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
    callStarted({ spentUsd = 0, stopUsd = null, footage = false } = {}) {
      calls += 1;
      return push(
        `Judge link: call ${calls} started${footage ? ' (recorded footage)' : ' (live camera)'}. Spent this run ${usd(spentUsd)}${stopUsd ? ` of ${usd(stopUsd)}` : ''}.`,
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
