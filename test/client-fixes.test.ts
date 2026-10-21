/**
 * GlpiClient fixes (v3.5.0): users, ticket links, assignment, sub-item counts.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiClient, parseContentRangeTotal } from '../src/glpi-client.js';

type Call = { url: string; method: string; body?: unknown };
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler): Call[] {
  const calls: Call[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return handler(url, init);
  });
  return calls;
}

const client = () => new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

test('getUsers({is_active}) uses GET /User with an anchored searchText and honours sort/order', async () => {
  const users = [{ id: 3, name: 'jdoe', realname: 'Doe', firstname: 'John', is_active: 1 }];
  const calls = installFetch(async () => json(users));
  const res = await client().getUsers({ range: '0-9', is_active: true, sort: 'realname', order: 'ASC' });
  assert.deepEqual(res, users);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/apirest.php/User');
  assert.equal(url.searchParams.get('searchText[is_active]'), '^1$');
  assert.equal(url.searchParams.get('sort'), 'realname');
  assert.equal(url.searchParams.get('order'), 'ASC');
  assert.equal(url.searchParams.get('range'), '0-9');

  await client().getUsers({ is_active: false });
  assert.equal(new URL(calls[1].url).searchParams.get('searchText[is_active]'), '^0$');
});

test('getUserByName matches exactly', async () => {
  const calls = installFetch(async () => json([
    { id: 1, name: 'jdoe2' },
    { id: 2, name: 'jdoe' },
  ]));
  const user = await client().getUserByName('jdoe');
  assert.equal(user?.id, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('searchText[name]'), '^jdoe$');
});

test('getUserByName falls back to a contains search for logins stored with trailing spaces', async () => {
  const calls = installFetch(async (url) => {
    const q = new URL(url).searchParams.get('searchText[name]');
    return json(q === '^jdoe$' ? [] : [{ id: 8, name: 'jdoe ' }, { id: 9, name: 'jdoe2' }]);
  });
  const user = await client().getUserByName('jdoe');
  assert.equal(user?.id, 8);
  assert.equal(new URL(calls[1].url).searchParams.get('searchText[name]'), 'jdoe');
});

test('getUserByName returns null when nobody matches and throws when ambiguous', async () => {
  installFetch(async () => json([{ id: 1, name: 'other' }]));
  assert.equal(await client().getUserByName('jdoe'), null);
  installFetch(async () => json([{ id: 4, name: 'jdoe' }, { id: 9, name: 'jdoe' }]));
  await assert.rejects(() => client().getUserByName('jdoe'), /Several users match the login "jdoe" \(ids 4, 9\)/);
});

test('linkTickets sends GLPI Ticket_Ticket constants with ticket_id as subject', async () => {
  const calls = installFetch(async () => json({ id: 77 }, { status: 201 }));
  const c = client();
  await c.linkTickets(10, 20, 'child_of');
  await c.linkTickets(10, 20, 'parent_of');
  await c.linkTickets(10, 20, 'duplicate');
  await c.linkTickets(10, 20);
  assert.deepEqual(calls.map((x) => (x.body as any).input), [
    { tickets_id_1: 10, tickets_id_2: 20, link: 3 },
    { tickets_id_1: 10, tickets_id_2: 20, link: 4 },
    { tickets_id_1: 10, tickets_id_2: 20, link: 2 },
    { tickets_id_1: 10, tickets_id_2: 20, link: 1 },
  ]);
});

test('assignTicket with user and group creates both links', async () => {
  const calls = installFetch(async (url) => json({ id: url.endsWith('Ticket_User') ? 5 : 6 }, { status: 201 }));
  const res = await client().assignTicket(42, { users_id: 3, groups_id: 8 });
  assert.deepEqual(res, { id: 5, user_link_id: 5, group_link_id: 6 });
  assert.deepEqual(calls.map((x) => [new URL(x.url).pathname, (x.body as any).input]), [
    ['/apirest.php/Ticket_User', { tickets_id: 42, users_id: 3, type: 2 }],
    ['/apirest.php/Group_Ticket', { tickets_id: 42, groups_id: 8, type: 2 }],
  ]);
});

test('assignTicket with only a group still works', async () => {
  installFetch(async () => json({ id: 6 }, { status: 201 }));
  assert.deepEqual(await client().assignTicket(42, { groups_id: 8 }), { id: 6, group_link_id: 6 });
});

test('countSubItems reads Content-Range with range=0-0', async () => {
  const calls = installFetch(async () =>
    json([{ id: 1 }], { status: 206, headers: { 'Content-Range': '0-0/17' } })
  );
  assert.equal(await client().countSubItems('Ticket/5/ITILFollowup'), 17);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('range'), '0-0');
});

test('countSubItems: empty list without Content-Range is 0; rows without it fall back to the full list', async () => {
  installFetch(async () => json([]));
  assert.equal(await client().countSubItems('Ticket/5/TicketTask'), 0);

  const calls = installFetch(async (url) =>
    new URL(url).searchParams.has('range') ? json([{ id: 1 }]) : json([{ id: 1 }, { id: 2 }, { id: 3 }])
  );
  assert.equal(await client().countSubItems('Ticket/5/TicketTask'), 3);
  assert.equal(calls.length, 2);
});

test('countItilChildren counts validations for changes only when asked', async () => {
  const calls = installFetch(async () => json([{ id: 1 }], { status: 206, headers: { 'Content-Range': '0-0/2' } }));
  const counts = await client().countItilChildren('Change', 9, true);
  assert.deepEqual(counts, { followups: 2, tasks: 2, solutions: 2, validations: 2 });
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname).sort(),
    [
      '/apirest.php/Change/9/ChangeTask',
      '/apirest.php/Change/9/ChangeValidation',
      '/apirest.php/Change/9/ITILFollowup',
      '/apirest.php/Change/9/ITILSolution',
    ]
  );
  const problem = await client().countItilChildren('Problem', 9, true);
  assert.equal(problem.validations, undefined);
});

test('parseContentRangeTotal', () => {
  assert.equal(parseContentRangeTotal('0-0/2172'), 2172);
  assert.equal(parseContentRangeTotal(null), undefined);
  assert.equal(parseContentRangeTotal('bogus'), undefined);
});

test('createUser sends the e-mail as _useremails (GLPI ignores a plain email field)', async () => {
  const calls = installFetch(async () => json({ id: 42, message: '' }, { status: 201 }));
  await client().createUser({ name: 'jdoe', realname: 'Doe', email: 'jdoe@example.org' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/apirest.php/User');
  assert.deepEqual(calls[0].body, { input: { name: 'jdoe', realname: 'Doe', _useremails: ['jdoe@example.org'] } });

  await client().createUser({ name: 'nomail' });
  assert.deepEqual(calls[1].body, { input: { name: 'nomail' } });
});
