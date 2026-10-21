/**
 * Retry policy, timeouts, session guard and concurrency of GlpiHttp (v3.5.0).
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import {
  GlpiHttp,
  GlpiError,
  GlpiTimeoutError,
  MAX_RETRY_DELAY_MS,
  isPreSendError,
  parseRetryAfter,
  retryDelay,
} from '../src/http.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler) {
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(handler);
}

const session = () => new Response(JSON.stringify({ session_token: 's' }), { status: 200 });

function connRefused(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
  return new TypeError('fetch failed', { cause });
}

function http(extra: Record<string, unknown> = {}) {
  return new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', retryBaseDelayMs: 1, maxRetries: 2, ...extra });
}

test('POST is not retried after a 5xx', async () => {
  let posts = 0;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return session();
    posts++;
    return new Response('boom', { status: 503 });
  });
  await assert.rejects(() => http().request('Ticket', { method: 'POST', json: { input: {} } }), GlpiError);
  assert.equal(posts, 1);
});

test('PUT is not retried after a timeout', async () => {
  let puts = 0;
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) return session();
    puts++;
    return new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  await assert.rejects(
    () => http({ timeoutMs: 10 }).request('Ticket/1', { method: 'PUT', json: { input: {} } }),
    GlpiTimeoutError
  );
  assert.equal(puts, 1);
});

test('POST is retried after ECONNREFUSED (request never sent)', async () => {
  let posts = 0;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return session();
    posts++;
    if (posts === 1) throw connRefused();
    return new Response(JSON.stringify({ id: 9 }), { status: 201 });
  });
  const res = await http().request<{ id: number }>('Ticket', { method: 'POST', json: { input: {} } });
  assert.equal(res.data.id, 9);
  assert.equal(posts, 2);
});

test('POST is not retried after ECONNRESET (may have been sent)', async () => {
  let posts = 0;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return session();
    posts++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  });
  await assert.rejects(() => http().request('Ticket', { method: 'POST', json: { input: {} } }));
  assert.equal(posts, 1);
});

test('GET is still retried after a 5xx and a timeout', async () => {
  let gets = 0;
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) return session();
    gets++;
    if (gets === 1) return new Response('x', { status: 502 });
    if (gets === 2) {
      return new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' })));
      });
    }
    return new Response('[]', { status: 200 });
  });
  await http({ timeoutMs: 10 }).request('Computer');
  assert.equal(gets, 3);
});

test('429 is retried for POST too', async () => {
  let posts = 0;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return session();
    posts++;
    if (posts === 1) return new Response('slow down', { status: 429 });
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  });
  await http().request('Ticket', { method: 'POST', json: { input: {} } });
  assert.equal(posts, 2);
});

test('retry delays are capped at 30 s with ±20 % jitter', () => {
  assert.equal(retryDelay(10 * 60_000, () => 0.5), MAX_RETRY_DELAY_MS);
  assert.equal(retryDelay(1000, () => 0), 800);
  assert.equal(retryDelay(1000, () => 1), 1200);
  assert.ok(retryDelay(10 * 60_000, () => 1) <= MAX_RETRY_DELAY_MS * 1.2);
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('0'), undefined);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(parseRetryAfter('garbage'), undefined);
});

test('isPreSendError recognises wrapped DNS / refused errors only', () => {
  assert.equal(isPreSendError(connRefused()), true);
  assert.equal(isPreSendError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })), true);
  assert.equal(isPreSendError(new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } })), true);
  const agg = new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }]);
  assert.equal(isPreSendError(new TypeError('fetch failed', { cause: agg })), true);
  assert.equal(isPreSendError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), false);
  assert.equal(isPreSendError(new GlpiTimeoutError(1, 'u')), false);
});

test('a stalled response body times out instead of hanging', async () => {
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) return session();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"id":'));
        init?.signal?.addEventListener('abort', () =>
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      },
    });
    return new Response(stream, { status: 200 });
  });
  await assert.rejects(() => http({ timeoutMs: 20, maxRetries: 0 }).request('Computer'), /timeout after 20ms/);
});

test('initSession rejects a response without a session_token', async () => {
  installFetch(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
  await assert.rejects(() => http().initSession(), /no session_token/);
  installFetch(async () => new Response(JSON.stringify({ session_token: '' }), { status: 200 }));
  await assert.rejects(() => http().initSession(), /no session_token/);
});

test('concurrent 401s on the same stale token re-authenticate only once', async () => {
  let inits = 0;
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      inits++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ session_token: `s${inits}` }), { status: 200 });
    }
    const token = (init?.headers as Record<string, string>)['Session-Token'];
    if (token === 's1') return new Response('["ERROR_SESSION_TOKEN_INVALID","x"]', { status: 401 });
    return new Response('[]', { status: 200 });
  });
  const h = http();
  await h.initSession();
  await Promise.all([h.request('A'), h.request('B'), h.request('C')]);
  assert.equal(inits, 2, 'one initial session + one refresh');
  assert.equal(h.session, 's2');
});

test('a late 401 carrying an old token does not drop the refreshed session', async () => {
  let inits = 0;
  let firstCall = true;
  const h = http();
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      inits++;
      return new Response(JSON.stringify({ session_token: `s${inits}` }), { status: 200 });
    }
    const token = (init?.headers as Record<string, string>)['Session-Token'];
    if (firstCall) {
      firstCall = false;
      // Another caller refreshed the session while this request was in flight.
      await h.initSession();
      return new Response('["ERROR_SESSION_TOKEN_INVALID","x"]', { status: 401 });
    }
    assert.equal(token, 's2');
    return new Response('[]', { status: 200 });
  });
  await h.initSession();
  await h.request('A');
  assert.equal(inits, 2, 'no extra re-authentication');
  assert.equal(h.session, 's2');
});

test('killSession uses the current token and never re-authenticates', async () => {
  let inits = 0;
  let killToken: string | undefined;
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      inits++;
      return session();
    }
    killToken = (init?.headers as Record<string, string>)['Session-Token'];
    return new Response('["ERROR_SESSION_TOKEN_INVALID","x"]', { status: 401 });
  });
  const h = http();
  await h.initSession();
  await h.killSession();
  assert.equal(killToken, 's');
  assert.equal(inits, 1);
  assert.equal(h.session, null);
});

test('killSession without a session does nothing', async () => {
  let calls = 0;
  installFetch(async () => {
    calls++;
    return session();
  });
  await http().killSession();
  assert.equal(calls, 0);
});

test('in-flight requests are capped by maxConcurrency', async () => {
  let active = 0;
  let peak = 0;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return session();
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return new Response('[]', { status: 200 });
  });
  const h = http({ maxConcurrency: 2 });
  await h.initSession();
  await Promise.all(Array.from({ length: 7 }, (_, i) => h.request(`Computer/${i}`)));
  assert.equal(peak, 2);
});

test('maxConcurrency defaults to GLPI_MAX_CONCURRENCY', async () => {
  process.env.GLPI_MAX_CONCURRENCY = '3';
  let active = 0;
  let peak = 0;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return session();
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return new Response('[]', { status: 200 });
  });
  try {
    const h = http();
    await h.initSession();
    await Promise.all(Array.from({ length: 8 }, () => h.request('Computer')));
    assert.equal(peak, 3);
  } finally {
    delete process.env.GLPI_MAX_CONCURRENCY;
  }
});
