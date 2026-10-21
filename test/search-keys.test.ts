/**
 * Search rows with readable keys (mapRowKeys) and SearchOptionsCache
 * single-flight (v3.5.0).
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiHttp } from '../src/http.js';
import { GlpiClient } from '../src/glpi-client.js';
import { buildKeyMap, mapRowKeys, shortKeyForUid } from '../src/search.js';
import { SearchOptionsCache } from '../src/search-options.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler): string[] {
  const calls: string[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    return handler(url, init);
  });
  return calls;
}

// uids as returned by a live GLPI 11 instance.
const TICKET_OPTIONS = {
  common: 'Characteristics',
  1: { name: 'Title', table: 'glpi_tickets', field: 'name', uid: 'Ticket.name' },
  2: { name: 'ID', table: 'glpi_tickets', field: 'id', uid: 'Ticket.id' },
  4: { name: 'Requester', table: 'glpi_users', field: 'name', uid: 'Ticket.Ticket_User.User.name' },
  5: { name: 'Technician', table: 'glpi_users', field: 'name', uid: 'Ticket.Ticket_User.User.name' },
  7: { name: 'Category', table: 'glpi_itilcategories', field: 'completename', uid: 'Ticket.ITILCategory.completename' },
  12: { name: 'Status', table: 'glpi_tickets', field: 'status', uid: 'Ticket.status' },
  80: { name: 'Entity', table: 'glpi_entities', field: 'completename', uid: 'Ticket.Entity.completename' },
};

async function catalogue() {
  installFetch(async () => new Response(JSON.stringify(TICKET_OPTIONS), { status: 200 }));
  return new SearchOptionsCache(new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' })).get('Ticket');
}

test('shortKeyForUid: own column -> field, joined -> last two segments', () => {
  assert.equal(shortKeyForUid('Ticket', 'Ticket.status'), 'status');
  assert.equal(shortKeyForUid('Ticket', 'Ticket.ITILCategory.completename'), 'itilcategory_completename');
  assert.equal(shortKeyForUid('Ticket', 'Ticket.User.name'), 'user_name');
  assert.equal(shortKeyForUid('Ticket', 'Ticket.Ticket_User.User.name'), 'user_name');
});

test('mapRowKeys gives well-known Ticket options friendly keys', async () => {
  const cat = await catalogue();
  const rows = mapRowKeys('Ticket', [
    { 2: 42, 1: 'Printer down', 12: 2, 4: 'alice', 5: 'bob', 7: 'Hardware > Printer', 80: 'Root', 999: 'x' },
  ], cat);
  assert.deepEqual(rows[0], {
    id: 42,
    name: 'Printer down',
    status: 2,
    requester_name: 'alice',
    technician_name: 'bob',
    category: 'Hardware > Printer',
    entity: 'Root',
    999: 'x',
  });
});

test('mapRowKeys suffixes colliding generic keys with the option id', async () => {
  // Same catalogue under another itemtype: no friendly overrides apply.
  const cat = await catalogue();
  const rows = mapRowKeys('Computer', [{ 4: 'alice', 5: 'bob' }], cat);
  assert.deepEqual(rows[0], { user_name_4: 'alice', user_name_5: 'bob' });
});

test('friendly keys are skipped when the option id points at another column', async () => {
  installFetch(async () =>
    new Response(JSON.stringify({ 12: { name: 'Other', field: 'foo', uid: 'Ticket.foo' } }), { status: 200 })
  );
  const cat = await new SearchOptionsCache(new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' })).get('Ticket');
  assert.deepEqual(mapRowKeys('Ticket', [{ 12: 1 }], cat)[0], { foo: 1 });
});

test('mapRowKeys also handles uid keys (uid_cols) and keeps id as id', async () => {
  const cat = await catalogue();
  const rows = mapRowKeys('Ticket', [{ id: 1, 'Ticket.status': 5, 'Ticket.Entity.completename': 'Root' }], cat);
  assert.deepEqual(rows[0], { id: 1, status: 5, entity: 'Root' });
  const map = buildKeyMap('Ticket', ['Ticket.id', '2'], cat);
  assert.equal(map.get('Ticket.id'), 'id');
  assert.equal(map.get('2'), 'id_2', 'a second "id" column does not overwrite the first');
});

test('GlpiClient.search returns readable rows; count() does not fetch the catalogue', async () => {
  let searchParams: URLSearchParams | undefined;
  const calls = installFetch(async (url) => {
    if (url.includes('listSearchOptions/Ticket')) return new Response(JSON.stringify(TICKET_OPTIONS), { status: 200 });
    searchParams = new URL(url).searchParams;
    return new Response(JSON.stringify({ totalcount: 1, count: 1, data: [{ 2: 7, 1: 'T', 12: 1 }] }), { status: 200 });
  });
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  const res = await client.search.search('Ticket', { limit: 1 });
  assert.deepEqual(res.data, [{ id: 7, name: 'T', status: 1 }]);
  assert.equal(searchParams?.get('uid_cols'), null, 'uid_cols would merge requester/technician');

  const before = calls.filter((u) => u.includes('listSearchOptions')).length;
  const fresh = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  await fresh.search.count('Ticket');
  assert.equal(calls.filter((u) => u.includes('listSearchOptions')).length, before);
});

test('search rows stay raw when listSearchOptions fails', async () => {
  installFetch(async (url) => {
    if (url.includes('listSearchOptions')) return new Response('["ERROR_RIGHT_MISSING","no"]', { status: 403 });
    return new Response(JSON.stringify({ totalcount: 1, data: [{ 2: 7 }] }), { status: 200 });
  });
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  const res = await client.search.search('Ticket', { limit: 1 });
  assert.deepEqual(res.data, [{ 2: 7 }]);
});

test('fetchAll pages are mapped too', async () => {
  installFetch(async (url) => {
    if (url.includes('listSearchOptions/Ticket')) return new Response(JSON.stringify(TICKET_OPTIONS), { status: 200 });
    const range = new URL(url).searchParams.get('range');
    const start = Number(range?.split('-')[0]);
    return new Response(JSON.stringify({ totalcount: 3, data: start < 2 ? [{ 2: start + 1 }, { 2: start + 2 }] : [{ 2: 3 }] }), { status: 200 });
  });
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  const res = await client.search.search('Ticket', { fetchAll: true, limit: 2 });
  assert.deepEqual(res.data, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('SearchOptionsCache.get is single-flight and does not cache failures', async () => {
  let fetches = 0;
  let fail = true;
  installFetch(async () => {
    fetches++;
    await new Promise((r) => setTimeout(r, 5));
    if (fail) return new Response('["ERROR","x"]', { status: 400 });
    return new Response(JSON.stringify(TICKET_OPTIONS), { status: 200 });
  });
  const cache = new SearchOptionsCache(new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' }));
  const results = await Promise.allSettled([cache.get('Ticket'), cache.get('Ticket'), cache.get('Ticket')]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(fetches, 1, 'concurrent callers share one fetch');

  fail = false;
  const [a, b] = await Promise.all([cache.get('Ticket'), cache.get('Ticket')]);
  assert.equal(fetches, 2, 'failure was not cached; success shared');
  assert.equal(a, b);
  assert.equal(a.byId.get(12)?.raw, undefined, 'raw dropped without GLPI_DEBUG');
});
