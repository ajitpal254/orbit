// Tests for the music audio proxy (v0.10.0): lib/musicStream.js.
// validateStreamUrl is pure + stubbed-DNS; fetchUpstream runs
// against a stubbed fetch, so no test ever touches the network.
// One assertion matters most: the upstream URL (a signed googlevideo
// URL) never appears in any log call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateStreamUrl,
  fetchUpstream,
  StreamUnavailableError
} = require('../lib/musicStream');

const GOOD_URL = 'https://rr2---sn-p5qlsnd6.googlevideo.com/videoplayback?expire=1&sig=abc';
const PUBLIC_URL = 'https://example.com/stream.mp3';

// A capturing logger: every call is recorded so the "never log the
// audio URL" assertion can inspect exactly what was logged.
const captureLog = () => {
  const calls = [];
  return {
    calls,
    log: {
      info: (fields, msg) => calls.push({ level: 'info', fields, msg }),
      warn: (fields, msg) => calls.push({ level: 'warn', fields, msg })
    }
  };
};

// DNS stub: public names resolve publicly; the evil name resolves
// privately; the dead name does not resolve at all.
const stubDns = (host) => {
  if (host === 'evil.example.com') return [{ address: '127.0.0.1' }];
  if (host === 'dead.example.com') throw new Error('ENOTFOUND');
  return [{ address: '93.184.216.34' }];
};

const withPrivateHosts = async (value, fn) => {
  const prev = process.env.ALLOW_PRIVATE_STREAM_HOSTS;
  if (value === undefined) delete process.env.ALLOW_PRIVATE_STREAM_HOSTS;
  else process.env.ALLOW_PRIVATE_STREAM_HOSTS = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRIVATE_STREAM_HOSTS;
    else process.env.ALLOW_PRIVATE_STREAM_HOSTS = prev;
  }
};

// --- validateStreamUrl ------------------------------------------------------

test('validateStreamUrl accepts a public http(s) URL', async () => {
  await withPrivateHosts(undefined, async () => {
    const res = await validateStreamUrl(PUBLIC_URL, { dnsImpl: stubDns });
    assert.deepEqual(res, { ok: true, url: PUBLIC_URL });
    const good = await validateStreamUrl(GOOD_URL, { dnsImpl: stubDns });
    assert.deepEqual(good, { ok: true, url: GOOD_URL });
  });
});

test('validateStreamUrl rejects non-http(s), unparseable and empty URLs', async () => {
  await withPrivateHosts(undefined, async () => {
    for (const bad of [
      'ftp://example.com/stream.mp3',
      'data:audio/wav;base64,AAAA',
      'not a url',
      '',
      null,
      undefined,
      42
    ]) {
      const res = await validateStreamUrl(bad, { dnsImpl: stubDns });
      assert.equal(res.ok, false, String(bad));
      assert.equal(res.error, 'INVALID_URL', String(bad));
    }
  });
});

test('validateStreamUrl blocks localhost and private literal IPs', async () => {
  await withPrivateHosts(undefined, async () => {
    for (const bad of [
      'http://localhost:3000/tone.wav',
      'http://127.0.0.1:4000/tone.wav',
      'http://10.0.0.5/stream.mp3',
      'http://192.168.1.10/stream.mp3',
      'http://172.16.0.9/stream.mp3',
      'http://[::1]/stream.mp3'
    ]) {
      const res = await validateStreamUrl(bad, { dnsImpl: stubDns });
      assert.equal(res.ok, false, bad);
      assert.equal(res.error, 'BLOCKED_HOST', bad);
    }
  });
});

test('validateStreamUrl blocks a hostname whose DNS resolves privately', async () => {
  await withPrivateHosts(undefined, async () => {
    const res = await validateStreamUrl('https://evil.example.com/stream.mp3', { dnsImpl: stubDns });
    assert.deepEqual(res, { ok: false, error: 'BLOCKED_HOST' });
  });
});

test('validateStreamUrl refuses an unresolvable host', async () => {
  await withPrivateHosts(undefined, async () => {
    const res = await validateStreamUrl('https://dead.example.com/stream.mp3', { dnsImpl: stubDns });
    assert.deepEqual(res, { ok: false, error: 'BLOCKED_HOST' });
  });
});

test('ALLOW_PRIVATE_STREAM_HOSTS=1 lifts the block (tests only)', async () => {
  await withPrivateHosts('1', async () => {
    // No DNS stub needed: with the flag the lookup is skipped entirely.
    const res = await validateStreamUrl('http://127.0.0.1:4000/tone.wav', {});
    assert.deepEqual(res, { ok: true, url: 'http://127.0.0.1:4000/tone.wav' });
  });
});

test('validateStreamUrl never logs the URL — only the host', async () => {
  await withPrivateHosts(undefined, async () => {
    const { log, calls } = captureLog();
    await validateStreamUrl(GOOD_URL, { dnsImpl: stubDns, log });
    await validateStreamUrl('https://evil.example.com/stream.mp3', { dnsImpl: stubDns, log });
    assert.ok(!JSON.stringify(calls).includes(GOOD_URL), 'the audio URL must never appear in logs');
    assert.ok(!JSON.stringify(calls).includes('sig=abc'), 'the signature must never appear in logs');
    const blocked = calls.find((c) => c.msg.includes('privately'));
    assert.ok(blocked, 'the blocked host is logged');
    assert.equal(blocked.fields.host, 'evil.example.com');
  });
});

// --- fetchUpstream ----------------------------------------------------------

const okResponse = (body = 'fake-audio-bytes') =>
  new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } });

test('fetchUpstream returns the response and forwards Range + UA', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, headers: opts.headers });
    return okResponse();
  };
  const res = await fetchUpstream(PUBLIC_URL, { fetchImpl, range: 'bytes=0-1023' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'fake-audio-bytes');
  assert.equal(seen[0].headers.range, 'bytes=0-1023');
  assert.match(seen[0].headers['user-agent'], /^OrbitMusic\//);
  assert.equal(seen[0].url, PUBLIC_URL);
});

test('fetchUpstream maps upstream errors to StreamUnavailableError', async () => {
  await assert.rejects(
    fetchUpstream(PUBLIC_URL, { fetchImpl: async () => new Response('nope', { status: 404 }) }),
    (err) => err instanceof StreamUnavailableError && err.reason === 'upstream-404'
  );
  await assert.rejects(
    fetchUpstream(PUBLIC_URL, { fetchImpl: async () => { throw new Error('boom'); } }),
    (err) => err instanceof StreamUnavailableError && err.reason === 'fetch-failed'
  );
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  await assert.rejects(
    fetchUpstream(PUBLIC_URL, { fetchImpl: async () => { throw abortErr; } }),
    (err) => err instanceof StreamUnavailableError && err.reason === 'aborted'
  );
});

test('fetchUpstream follows a redirect to a public URL', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/next.mp3' } });
    }
    return okResponse();
  };
  const res = await fetchUpstream(PUBLIC_URL, { fetchImpl, dnsImpl: stubDns });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [PUBLIC_URL, 'https://cdn.example.com/next.mp3']);
});

test('fetchUpstream refuses a redirect to a private host', async () => {
  const fetchImpl = async (url) => {
    if (url === PUBLIC_URL) {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/next.mp3' } });
    }
    return okResponse();
  };
  await assert.rejects(
    fetchUpstream(PUBLIC_URL, { fetchImpl, dnsImpl: stubDns }),
    (err) => err instanceof StreamUnavailableError && err.reason === 'redirect-blocked'
  );
});

test('fetchUpstream gives up after too many redirects', async () => {
  const fetchImpl = async () =>
    new Response(null, { status: 302, headers: { location: 'https://example.com/next.mp3' } });
  await assert.rejects(
    fetchUpstream(PUBLIC_URL, { fetchImpl, dnsImpl: stubDns, maxRedirects: 1 }),
    (err) => err instanceof StreamUnavailableError && err.reason === 'too-many-redirects'
  );
});
