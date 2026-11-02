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

/**
 * The key limits are counted by: an IPv4 address as is, an IPv6 address by its /64 network, since one
 * phone or home rotates through many addresses in it (red team #6 S-A). IPv4-mapped IPv6 is IPv4.
 */
export function placeKey(ip) {
  const s = String(ip ?? '')
    .trim()
    .toLowerCase();
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!s.includes(':')) return s || 'unknown';
  const [head, tail = ''] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
