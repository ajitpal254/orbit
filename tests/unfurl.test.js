// Tests for server-side link unfurling (v0.8.0): the pure helpers in
// lib/unfurl.js and fetchUnfurl with injected fetch/DNS stubs — no
// real network is touched here (the route-level cache behaviour is
// covered by tests/mediaRoutes.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUrl, isPrivateIp, isBlockedHost, parseOpenGraph, fetchUnfurl
} = require('../lib/unfurl');

const OG_PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Cool &amp; Neat Page">
<meta property="og:description" content="A page about things.">
<meta property="og:image" content="/img/cover.png">
<link rel="icon" href="/favicon.png">
<title>Fallback Title</title>
</head><body>hi</body></html>`;

const TWITTER_PAGE = `<!doctype html><html><head>
<meta name="twitter:title" content="Tweet Title">
<meta name="twitter:description" content="Tweet desc">
<meta name="twitter:image" content="https://cdn.example.com/t.png">
<title>Fallback Title</title>
</head><body>hi</body></html>`;

test('normalizeUrl: bare domains gain https, non-http(s) is rejected', () => {
  assert.equal(normalizeUrl('example.com/page'), 'https://example.com/page');
  assert.equal(normalizeUrl('  https://example.com/a?b=c  '), 'https://example.com/a?b=c');
  assert.equal(normalizeUrl('http://example.com/'), 'http://example.com/');
  assert.equal(normalizeUrl('ftp://example.com/'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl('x'.repeat(3000)), null);
});

test('isPrivateIp covers loopback, RFC1918, link-local, v6 locals', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.2', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', 'fd12::34']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
  assert.equal(isPrivateIp('not-an-ip'), false);
});

test('isBlockedHost: localhost names and literal private IPs', () => {
  assert.equal(isBlockedHost('localhost'), true);
  assert.equal(isBlockedHost('foo.localhost'), true);
  assert.equal(isBlockedHost('app.local'), true);
  assert.equal(isBlockedHost('127.0.0.1'), true);
  assert.equal(isBlockedHost('10.1.2.3'), true);
  assert.equal(isBlockedHost('example.com'), false);
  assert.equal(isBlockedHost('8.8.8.8'), false);
  assert.equal(isBlockedHost(''), true);
});

test('parseOpenGraph: og tags win, relative URLs resolve, entities decode', () => {
  const p = parseOpenGraph(OG_PAGE, 'https://example.com/blog/post');
  assert.equal(p.title, 'Cool & Neat Page');
  assert.equal(p.description, 'A page about things.');
  assert.equal(p.image, 'https://example.com/img/cover.png');
  assert.equal(p.favicon, 'https://example.com/favicon.png');
});

test('parseOpenGraph: twitter fallback, then <title>, then nulls', () => {
  const p = parseOpenGraph(TWITTER_PAGE, 'https://example.com/x');
  assert.equal(p.title, 'Tweet Title');
  assert.equal(p.description, 'Tweet desc');
  assert.equal(p.image, 'https://cdn.example.com/t.png');
  assert.equal(p.favicon, 'https://example.com/favicon.ico');
  const bare = parseOpenGraph('<html><head><title>Only Title</title></head></html>', 'https://example.com/');
  assert.equal(bare.title, 'Only Title');
  assert.equal(bare.description, null);
  assert.equal(bare.image, null);
  assert.equal(bare.favicon, 'https://example.com/favicon.ico');
  const empty = parseOpenGraph('<html><head></head><body>no head tags</body></html>', 'https://example.com/');
  assert.equal(empty.title, null);
  assert.equal(empty.description, null);
  assert.equal(empty.image, null);
});

// --- fetchUnfurl with stubs ---

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const privateDns = async () => [{ address: '127.0.0.1', family: 4 }];

const bodyFromString = (s, chunk = null) => {
  const parts = chunk || [Buffer.from(s, 'utf8')];
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= parts.length) return { done: true, value: undefined };
        return { done: false, value: parts[i++] };
      },
      cancel: async () => {}
    })
  };
};

const fakeRes = (html, contentType = 'text/html; charset=utf-8') => ({
  ok: true,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  body: bodyFromString(html)
});

const fetchOk = (html) => async () => fakeRes(html);

test('fetchUnfurl: happy path returns the preview with the page URL', async () => {
  const p = await fetchUnfurl('example.com/blog/post', { fetchImpl: fetchOk(OG_PAGE), dnsImpl: publicDns });
  assert.equal(p.url, 'https://example.com/blog/post');
  assert.equal(p.title, 'Cool & Neat Page');
  assert.equal(p.image, 'https://example.com/img/cover.png');
});

test('fetchUnfurl: blocked host and private DNS answers return null', async () => {
  assert.equal(await fetchUnfurl('http://localhost:3000/x', { fetchImpl: fetchOk(OG_PAGE), dnsImpl: publicDns }), null);
  assert.equal(await fetchUnfurl('http://127.0.0.1/x', { fetchImpl: fetchOk(OG_PAGE), dnsImpl: publicDns }), null);
  assert.equal(await fetchUnfurl('https://evil.example/x', { fetchImpl: fetchOk(OG_PAGE), dnsImpl: privateDns }), null);
  assert.equal(await fetchUnfurl('https://nowhere.example/x', { fetchImpl: fetchOk(OG_PAGE), dnsImpl: async () => { throw new Error('ENOTFOUND'); } }), null);
});

test('fetchUnfurl: network errors, non-HTML, empty pages, and oversize bodies return null', async () => {
  const throwing = async () => { throw new Error('boom'); };
  assert.equal(await fetchUnfurl('https://example.com/', { fetchImpl: throwing, dnsImpl: publicDns }), null);
  assert.equal(
    await fetchUnfurl('https://example.com/', { fetchImpl: async () => fakeRes('{}', 'application/json'), dnsImpl: publicDns }),
    null
  );
  assert.equal(await fetchUnfurl('https://example.com/', { fetchImpl: fetchOk('<html></html>'), dnsImpl: publicDns }), null);
  const big = await fetchUnfurl('https://example.com/', {
    fetchImpl: async () => fakeRes('', 'text/html'),
    dnsImpl: publicDns,
    maxBytes: 10
  });
  // fakeRes('') has an empty body — exercise the cap with a big one instead.
  assert.equal(big, null);
  const oversize = await fetchUnfurl('https://example.com/', {
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'text/html' },
      body: bodyFromString('', [Buffer.alloc(20, 'a'), Buffer.alloc(20, 'b')])
    }),
    dnsImpl: publicDns,
    maxBytes: 30
  });
  assert.equal(oversize, null);
  assert.equal(await fetchUnfurl('not a url :::', { fetchImpl: fetchOk(OG_PAGE), dnsImpl: publicDns }), null);
});
