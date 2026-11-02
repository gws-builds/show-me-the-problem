// Behind a proxy the caller is the entry PROXY_HOPS from the end of X-Forwarded-For (1 = the last, as Cloud
// Run appends it; 2 if a load balancer adds itself after). Entries before that are client-supplied and never
// trusted. How many entries arrive is logged once (a count, never an address), to set the hop on the hosted copy.
const PROXY_HOPS = Math.max(1, Number(process.env.PROXY_HOPS) || 1);
let xffLogged = false;
export function callerIp(req, { trust = process.env.TRUST_PROXY === '1', hops = PROXY_HOPS } = {}) {
  if (trust) {
    const list = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!xffLogged && list.length) {
      xffLogged = true;
      console.log(
        `proxy: X-Forwarded-For carries ${list.length} entr${list.length === 1 ? 'y' : 'ies'}; using entry ${hops} from the end`,
      );
    }
    const ip = list[list.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress || 'unknown';
}
