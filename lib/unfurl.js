// Server-side link unfurling: fetch a URL's Open Graph tags and
// return a small preview card ({ title, description, image, favicon }).
//
// Why server-side: a browser fetch would hit CORS on most sites, and
// the page's tags are public metadata anyway. The client never fetches
// the target URL directly.
//
// Safety notes (this endpoint fetches a user-supplied URL):
// - http(s) only, and the hostname must not be localhost / a private
//   or loopback IP. The check runs twice: on the literal hostname,
//   and on the DNS answer (dns.lookup) so a public-looking name that
//   resolves to 127.0.0.1 cannot reach internal services (SSRF).
// - 5s timeout, 1MB body cap, HTML only, no redirects beyond fetch's
//   own default (20) — a slow or huge page fails closed, never hangs
//   the request.
// - A failure is NEVER an error to the caller: fetchUnfurl returns
//   null and the route answers 200 with an all-null preview, so the
//   message still sends with no preview card (see routes/api.js).
// - Results are cached in Mongo (models/LinkPreview.js, 7-day TTL)
//   so the same link shared twice costs one fetch.
//
// Pure helpers (normalizeUrl, parseOpenGraph, isPrivateIp) are
// unit-testable without network; fetchUnfurl takes injectable
// fetchImpl/dnsImpl so tests can stub the network entirely.

const dns = require('dns');
const net = require('net');

const UNFURL_TIMEOUT_MS = 5000;
const UNFURL_MAX_BYTES = 1024 * 1024; // 1MB of HTML is plenty for <head>
const UNFURL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Normalize a user-supplied URL string to an absolute http(s) URL, or
// null. No scheme defaults to https (a bare "example.com/page" is the
// common paste); anything else is rejected.
const normalizeUrl = (raw) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.toString();
};

// True for IPs that must never be fetched: loopback, private (RFC1918),
// link-local, and unique-local ranges, v4 and v6.
const isPrivateIp = (ip) => {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    return false;
  }
  return false;
};

// Hostname-level block: localhost names and literal private IPs.
// The DNS-answer check in fetchUnfurl covers names that resolve
// privately; this covers the obvious cases before any lookup.
const isBlockedHost = (hostname) => {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
};

// Decode the few entities that show up in <meta content="..."> and
// <title> without pulling in an HTML parser: the preview only needs
// the head tags, and a regex pass over the first 1MB is enough.
const decodeEntities = (s) =>
  String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });

// Extract one <meta ...> tag's content attribute for a given
// property/name value. Handles both attribute orders.
const metaContent = (html, attr, value) => {
  const pattern = new RegExp(
    `<meta[^>]*\\b${attr}\\s*=\\s*["']${value}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']|` +
    `<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b${attr}\\s*=\\s*["']${value}["']`,
    'i'
  );
  const m = html.match(pattern);
  return m ? decodeEntities((m[1] ?? m[2] ?? '').trim()) : null;
};

// Resolve a possibly-relative URL against the page URL; null when it
// cannot be resolved or is not http(s).
const resolveUrl = (raw, pageUrl) => {
  if (!raw) return null;
  try {
    const resolved = new URL(raw.trim(), pageUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
};

// Pure OG extraction: og:* first, twitter:* fallback, then <title> /
// meta description. Returns nulls (never throws) when nothing is found.
const parseOpenGraph = (html, pageUrl) => {
  const safeHtml = typeof html === 'string' ? html : '';
  const titleTag = safeHtml.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title =
    metaContent(safeHtml, 'property', 'og:title') ||
    metaContent(safeHtml, 'name', 'twitter:title') ||
    (titleTag ? decodeEntities(titleTag[1].trim()) : null) ||
    null;
  const description =
    metaContent(safeHtml, 'property', 'og:description') ||
    metaContent(safeHtml, 'name', 'twitter:description') ||
    metaContent(safeHtml, 'name', 'description') ||
    null;
  const image = resolveUrl(
    metaContent(safeHtml, 'property', 'og:image') ||
    metaContent(safeHtml, 'name', 'twitter:image') ||
    null,
    pageUrl
  );
  // Favicon: <link rel="icon" ...> (or shortcut icon / apple-touch-icon),
  // else the origin's /favicon.ico as a last resort.
  let favicon = null;
  const linkMatch = safeHtml.match(
    /<link[^>]*\brel\s*=\s*["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*>/i
  ) || safeHtml.match(
    /<link[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["'](?:shortcut icon|icon|apple-touch-icon)["']/i
  );
  if (linkMatch) {
    const href = linkMatch[1] || (linkMatch[0].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    favicon = resolveUrl(href, pageUrl);
  }
  if (!favicon) {
    try {
      favicon = new URL('/favicon.ico', pageUrl).toString();
    } catch {
      favicon = null;
    }
  }
  return { title: title || null, description: description || null, image: image || null, favicon: favicon || null };
};

// Read a fetch body with a hard byte cap (the content-length header
// lies often enough that the cap is enforced while streaming).
const readCappedBody = async (res, maxBytes) => {
  if (typeof res.text === 'function' && !res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

// Fetch + parse one URL. Returns the preview or null on ANY failure
// (bad URL, blocked host, DNS, network, timeout, non-HTML, too big,
// no tags at all). Callers treat null as "no preview", never an error.
const fetchUnfurl = async (rawUrl, { fetchImpl, dnsImpl, timeoutMs = UNFURL_TIMEOUT_MS, maxBytes = UNFURL_MAX_BYTES } = {}) => {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (isBlockedHost(parsed.hostname)) return null;
  // DNS-answer SSRF check: a public-looking name that resolves to a
  // private address is refused before any fetch happens.
  try {
    const lookup = dnsImpl || ((host) => dns.promises.lookup(host, { all: true }));
    const answers = await lookup(parsed.hostname);
    const list = Array.isArray(answers) ? answers : [answers];
    if (list.some((a) => a && isPrivateIp(a.address || a))) return null;
  } catch {
    return null; // unresolvable host: no preview, not an error
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  let res;
  try {
    res = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: {
        'user-agent': 'OrbitLinkPreview/1.0 (+https://orbit-3lzs.onrender.com/)',
        accept: 'text/html,application/xhtml+xml'
      }
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    return null;
  }
  let html;
  try {
    html = await readCappedBody(res, maxBytes);
  } catch {
    return null;
  }
  const preview = parseOpenGraph(html, url);
  if (!preview.title && !preview.description && !preview.image) return null;
  return { url, ...preview };
};

module.exports = {
  UNFURL_TIMEOUT_MS,
  UNFURL_MAX_BYTES,
  UNFURL_CACHE_TTL_MS,
  normalizeUrl,
  isPrivateIp,
  isBlockedHost,
  parseOpenGraph,
  fetchUnfurl
};
