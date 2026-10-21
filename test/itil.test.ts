/**
 * Tests for issue #9: Change/Problem tasks, ITIL status labels, and `sort`
 * on the list endpoints (column name, not search-option id).
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiClient } from '../src/glpi-client.js';
import { CHANGE_STATUS, PROBLEM_STATUS, TICKET_STATUS, isItilItemtype } from '../src/itil.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler): string[] {
  const calls: string[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 'sess' }), { status: 200 });
    }
    return handler(url, init);
  });
  return calls;
}

const CHANGE_SEARCH_OPTIONS = {
  common: 'Characteristics',
  1: { name: 'Title', table: 'glpi_changes', field: 'name', uid: 'Change.name' },
  12: { name: 'Status', table: 'glpi_changes', field: 'status', uid: 'Change.status' },
  19: { name: 'Last update', table: 'glpi_changes', field: 'date_mod', uid: 'Change.date_mod' },
  // Joined field: the requester's name lives in glpi_users, not glpi_changes.
  4: { name: 'Requester', table: 'glpi_users', field: 'name', uid: 'Change.User.name' },
};

function client() {
  return new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
}

// --- status labels (GLPI CommonITILObject constants) ------------------------

test('Change status labels follow GLPI constants, not a 1..12 sequence', () => {
  assert.equal(CHANGE_STATUS[5], 'Applied (solved)');
  assert.equal(CHANGE_STATUS[7], 'Accepted');
  assert.equal(CHANGE_STATUS[9], 'Evaluation');
  assert.equal(CHANGE_STATUS[10], 'Approval');
  assert.equal(CHANGE_STATUS[11], 'Testing');
  assert.equal(CHANGE_STATUS[12], 'Qualification');
  assert.equal(CHANGE_STATUS[13], 'Refused');
  assert.equal(CHANGE_STATUS[14], 'Cancelled');
  assert.equal(CHANGE_STATUS[6], 'Closed');
});

test('Problem status labels: 2 is Processing, 7 Accepted, 8 Under observation', () => {
  assert.equal(PROBLEM_STATUS[2], 'Processing (assigned)');
  assert.equal(PROBLEM_STATUS[7], 'Accepted');
  assert.equal(PROBLEM_STATUS[8], 'Under observation');
  assert.equal(TICKET_STATUS[2], PROBLEM_STATUS[2]);
});

test('isItilItemtype accepts only Ticket/Change/Problem', () => {
  assert.equal(isItilItemtype('Change'), true);
  assert.equal(isItilItemtype('Computer'), false);
  assert.equal(isItilItemtype(undefined), false);
});

// --- Change / Problem sub-items ---------------------------------------------

test('getItilTasks reads {Itemtype}/{id}/{Itemtype}Task for each ITIL type', async () => {
  const calls = installFetch(async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }));
  const c = client();
  await c.getChangeTasks(7);
  await c.getProblemTasks(8);
  await c.getTicketTasks(9);
  const paths = calls.filter((u) => !u.endsWith('/initSession')).map((u) => new URL(u).pathname);
  assert.deepEqual(paths, [
    '/apirest.php/Change/7/ChangeTask',
    '/apirest.php/Problem/8/ProblemTask',
    '/apirest.php/Ticket/9/TicketTask',
  ]);
});

test('getItilValidations: Change uses ChangeValidation, Problem has none (no request)', async () => {
  const calls = installFetch(async () => new Response(JSON.stringify([{ id: 3 }]), { status: 200 }));
  const c = client();
  const changeValidations = await c.getItilValidations('Change', 5);
  assert.equal(changeValidations.length, 1);
  const problemValidations = await c.getItilValidations('Problem', 5);
  assert.deepEqual(problemValidations, []);
  const paths = calls.filter((u) => !u.endsWith('/initSession')).map((u) => new URL(u).pathname);
  assert.deepEqual(paths, ['/apirest.php/Change/5/ChangeValidation']);
});

// --- sort on list endpoints -------------------------------------------------

test('getItems translates a numeric sort (search-option id) into the column name', async () => {
  const calls = installFetch(async (url) => {
    if (url.includes('/listSearchOptions/Change')) {
      return new Response(JSON.stringify(CHANGE_SEARCH_OPTIONS), { status: 200 });
    }
    return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
  });
  const rows = await client().getChanges({ range: '0-4', sort: 19, order: 'DESC' });
  assert.equal(rows.length, 1);
  const listCall = new URL(calls.find((u) => /\/Change\?/.test(u))!);
  assert.equal(listCall.searchParams.get('sort'), 'date_mod');
  assert.equal(listCall.searchParams.get('order'), 'DESC');
});

test('getItems passes a string sort (column name) through without consulting SearchOptions', async () => {
  const calls = installFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
  await client().getProblems({ sort: 'date_mod' });
  assert.equal(calls.some((u) => u.includes('listSearchOptions')), false);
  const listCall = new URL(calls.find((u) => /\/Problem\?/.test(u))!);
  assert.equal(listCall.searchParams.get('sort'), 'date_mod');
});

test('getItems rejects a sort id that points at a joined table with a clear message', async () => {
  installFetch(async (url) => {
    if (url.includes('/listSearchOptions/Change')) {
      return new Response(JSON.stringify(CHANGE_SEARCH_OPTIONS), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  await assert.rejects(client().getChanges({ sort: 4 }), /joined field/);
  await assert.rejects(client().getChanges({ sort: 999 }), /unknown search option 999/);
});
