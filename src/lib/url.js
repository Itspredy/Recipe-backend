import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * URL hygiene for the import endpoint.
 *
 * Two jobs:
 *   1. NORMALISE  — so the cache actually hits. The same reel shared by two
 *      users arrives as ".../reel/ABC/?igsh=xyz" and ".../reel/ABC/?igsh=pqr";
 *      without stripping that junk every share is a cache miss and a paid
 *      scrape. This is the single biggest lever on the import bill.
 *   2. GUARD      — /import fetches whatever URL it is handed, server-side.
 *      Without a check that is a server-side request forgery hole: a caller
 *      could point us at 169.254.169.254 (cloud metadata) or an internal
 *      service. We allow only public http(s) hosts.
 */

// Tracking/session params that never change which post is being referenced.
const JUNK_PARAMS = [
  'igsh', 'igshid', 'img_index', 'si', 'feature', 'pp', 'ab_channel',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'ref_url',
  'share_id', 'is_from_webapp', 'sender_device', 'web_id', '_r', '_t',
];

/**
 * Canonical form of a recipe source URL: https, no www, no tracking params,
 * no trailing slash, and platform-specific short forms expanded so every
 * spelling of the same video collapses to one cache key.
 */
export function normalizeUrl(input) {
  const url = new URL(input);

  url.protocol = 'https:';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  for (const param of JUNK_PARAMS) url.searchParams.delete(param);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }

  // youtu.be/ID and /shorts/ID and /embed/ID all mean watch?v=ID
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (id) return `https://youtube.com/watch?v=${id}`;
  }
  if (url.hostname.endsWith('youtube.com')) {
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
    if (match) return `https://youtube.com/watch?v=${match[1]}`;
  }

  // Instagram/TikTok keep no meaningful query at all once junk is stripped.
  if (url.hostname.endsWith('instagram.com') || url.hostname.endsWith('tiktok.com')) {
    url.search = '';
  }

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  url.searchParams.sort();
  return url.toString();
}

/** Private, loopback, link-local and CGNAT space — never fetchable by us. */
function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const addr = ip.toLowerCase();
    // IPv4-mapped (::ffff:127.0.0.1) — re-check as IPv4.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      addr === '::' ||
      addr === '::1' ||
      addr.startsWith('fc') ||
      addr.startsWith('fd') ||
      addr.startsWith('fe80')
    );
  }

  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||       // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

/**
 * Validate + normalise a user-supplied link. Throws a 400-shaped error when the
 * URL is malformed, non-http(s), or resolves into private address space.
 */
export async function assertSafePublicUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    const error = new Error('That is not a valid link.');
    error.status = 400;
    throw error;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const error = new Error('Only http and https links are supported.');
    error.status = 400;
    throw error;
  }

  // A literal private IP in the URL, or a hostname that resolves to one.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      const error = new Error("Couldn't reach that link.");
      error.status = 400;
      throw error;
    }
  }

  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    const error = new Error('That link points to a private address.');
    error.status = 400;
    throw error;
  }

  return normalizeUrl(url.toString());
}
