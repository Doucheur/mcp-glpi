/**
 * Dispatch harness: the real McpServer driven through an in-memory
 * transport by an MCP Client, with a fake GLPI behind `fetch`.
 *
 * Covers the listed catalogue, hidden aliases and their argument mapping,
 * GLPI_LEGACY_TOOLS / GLPI_READ_ONLY / GLPI_TOOLSETS filtering, protocol vs
 * isError failures, and a few end-to-end outputs.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { ALL_ALIASES, ALL_TOOLS, INSTRUCTIONS, SERVER_VERSION, createMcpServer } from '../src/server.js';
import { annotationsOf, parseRegistryOptions, type RegistryOptions, type ToolDef } from '../src/tools/registry.js';
import { text } from '../src/output.js';

// ---------------------------------------------------------------------------
// Expected catalogue
// ---------------------------------------------------------------------------

const EXPECTED_TOOLS = [
  // tickets
  'glpi_search_tickets', 'glpi_get_ticket', 'glpi_get_ticket_timeline', 'glpi_list_overdue_tickets',
  'glpi_get_ticket_satisfaction', 'glpi_create_ticket', 'glpi_update_ticket', 'glpi_set_ticket_status',
  'glpi_delete_ticket', 'glpi_add_followup', 'glpi_add_task', 'glpi_add_solution', 'glpi_assign_ticket',
  'glpi_link_tickets', 'glpi_add_ticket_validation', 'glpi_set_validation_status', 'glpi_upload_document',
  'glpi_attach_document_to_ticket',
  // itil
  'glpi_list_problems', 'glpi_get_problem', 'glpi_create_problem', 'glpi_update_problem',
  'glpi_list_changes', 'glpi_get_change', 'glpi_create_change', 'glpi_update_change',
  // items
  'glpi_list_items', 'glpi_get_item', 'glpi_create_item', 'glpi_update_item', 'glpi_delete_item',
  // users / session / admin
  'glpi_list_users', 'glpi_get_user', 'glpi_find_user', 'glpi_create_user', 'glpi_add_user_to_group',
  'glpi_get_session_info', 'glpi_set_active_entity', 'glpi_set_active_profile',
  // search / kb
  'glpi_search_v2', 'glpi_count', 'glpi_list_search_options', 'glpi_search_knowbase', 'glpi_create_knowbase_item',
  // stats
  'glpi_tickets_stats_by', 'glpi_get_asset_stats',
].sort();

/** Every tool name v3.5 exposed. */
const V3_TOOLS = [
  'glpi_add_followup', 'glpi_add_solution', 'glpi_add_task', 'glpi_add_ticket_validation', 'glpi_add_user_to_group',
  'glpi_assign_ticket', 'glpi_attach_document_to_ticket', 'glpi_count', 'glpi_create_change', 'glpi_create_computer',
  'glpi_create_contract', 'glpi_create_group', 'glpi_create_knowbase_item', 'glpi_create_location', 'glpi_create_problem',
  'glpi_create_project', 'glpi_create_software', 'glpi_create_supplier', 'glpi_create_ticket', 'glpi_create_user',
  'glpi_delete_computer', 'glpi_delete_ticket', 'glpi_get_asset_stats', 'glpi_get_change', 'glpi_get_change_tasks',
  'glpi_get_contract', 'glpi_get_document', 'glpi_get_entity', 'glpi_get_group', 'glpi_get_knowbase_item',
  'glpi_get_location', 'glpi_get_problem', 'glpi_get_problem_tasks', 'glpi_get_project', 'glpi_get_session_info',
  'glpi_get_supplier', 'glpi_get_ticket', 'glpi_get_ticket_documents', 'glpi_get_ticket_followups',
  'glpi_get_ticket_satisfaction', 'glpi_get_ticket_solutions', 'glpi_get_ticket_stats', 'glpi_get_ticket_tasks',
  'glpi_get_ticket_timeline', 'glpi_get_ticket_validations', 'glpi_get_user', 'glpi_link_tickets',
  'glpi_list_categories', 'glpi_list_changes', 'glpi_list_contracts', 'glpi_list_documents', 'glpi_list_entities',
  'glpi_list_groups', 'glpi_list_knowbase', 'glpi_list_locations', 'glpi_list_overdue_tickets', 'glpi_list_problems',
  'glpi_list_projects', 'glpi_list_search_options', 'glpi_list_suppliers', 'glpi_list_tickets', 'glpi_list_users',
  'glpi_search', 'glpi_search_knowbase', 'glpi_search_tickets', 'glpi_search_user', 'glpi_search_v2',
  'glpi_set_validation_status', 'glpi_tickets_stats_by', 'glpi_update_change', 'glpi_update_computer',
  'glpi_update_problem', 'glpi_update_project', 'glpi_update_ticket', 'glpi_upload_document',
  'glpi_list_computers', 'glpi_get_computer', 'glpi_list_softwares', 'glpi_get_software',
  'glpi_list_network_equipments', 'glpi_get_network_equipment', 'glpi_list_printers', 'glpi_get_printer',
  'glpi_list_monitors', 'glpi_get_monitor', 'glpi_list_phones', 'glpi_get_phone',
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FetchCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

type GlpiRoute = (call: FetchCall) => Response | undefined;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

function installFetch(route: GlpiRoute): FetchCall[] {
  const calls: FetchCall[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/apirest\.php\//, '');
    if (path === 'initSession') return json({ session_token: 's' });
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      path,
      query: u.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call) ?? json([]);
  });
  return calls;
}

async function connect(options: RegistryOptions = {}, tools?: readonly ToolDef[]) {
  const glpi = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  const server = createMcpServer({ client: glpi, options, tools });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, close: () => client.close() };
}

async function listNames(options: RegistryOptions = {}) {
  const { client, close } = await connect(options);
  const { tools } = await client.listTools();
  await close();
  return tools;
}

const resultText = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const resultJson = (r: unknown) => JSON.parse(resultText(r));

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

test('tools/list is exactly the v4 catalogue, without aliases', async () => {
  const tools = await listNames();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  const aliasNames = new Set(ALL_ALIASES.map((a) => a.name));
  assert.ok(tools.every((t) => !aliasNames.has(t.name)));
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has a title`);
    assert.ok(t.annotations, `${t.name} has annotations`);
    assert.equal((t.inputSchema as Record<string, unknown>).$schema, undefined);
    for (const [key, prop] of Object.entries(t.inputSchema.properties ?? {})) {
      assert.ok((prop as { description?: string }).description, `${t.name}.${key} is described`);
    }
  }
});

test('every v3 tool name is either kept or a hidden alias', () => {
  const kept = new Set(ALL_TOOLS.map((t) => t.name));
  const aliases = new Set(ALL_ALIASES.map((a) => a.name));
  for (const name of V3_TOOLS) assert.ok(kept.has(name) || aliases.has(name), name);
  for (const alias of ALL_ALIASES) {
    assert.ok(kept.has(alias.target), `${alias.name} -> ${alias.target}`);
    assert.ok(!kept.has(alias.name), `${alias.name} is not also a tool`);
  }
  assert.equal(ALL_ALIASES.length, V3_TOOLS.filter((n) => !kept.has(n)).length);
});

test('GLPI_LEGACY_TOOLS=1 also lists the aliases', async () => {
  const tools = await listNames(parseRegistryOptions({ GLPI_LEGACY_TOOLS: '1' }));
  assert.equal(tools.length, EXPECTED_TOOLS.length + ALL_ALIASES.length);
  const followups = tools.find((t) => t.name === 'glpi_get_ticket_followups');
  assert.match(followups?.description ?? '', /glpi_get_ticket_timeline/);
});

test('GLPI_READ_ONLY=1 lists only read-only tools; writes are refused at protocol level', async () => {
  const options = parseRegistryOptions({ GLPI_READ_ONLY: 'true' });
  const tools = await listNames(options);
  const expected = ALL_TOOLS.filter((d) => annotationsOf(d).readOnlyHint === true).map((d) => d.name).sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.ok(expected.includes('glpi_search_tickets') && !expected.includes('glpi_create_ticket'));

  const { client, close } = await connect(options);
  await assert.rejects(client.callTool({ name: 'glpi_create_ticket', arguments: { name: 'x', content: 'y' } }), (e) => {
    assert.ok(e instanceof McpError);
    assert.match(e.message, /read-only/);
    return true;
  });
  // An alias of a write tool is refused too.
  await assert.rejects(client.callTool({ name: 'glpi_create_group', arguments: { name: 'g' } }), McpError);
  await close();
});

test('GLPI_TOOLSETS=tickets lists only the tickets toolset', async () => {
  const tools = await listNames(parseRegistryOptions({ GLPI_TOOLSETS: 'tickets' }));
  const expected = ALL_TOOLS.filter((d) => d.toolset === 'tickets').map((d) => d.name).sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected);
  assert.equal(expected.length, 18);
  const warnings: string[] = [];
  const opts = parseRegistryOptions({ GLPI_TOOLSETS: 'tickets, bogus,STATS' }, (m) => warnings.push(m));
  assert.deepEqual([...(opts.toolsets ?? [])].sort(), ['stats', 'tickets']);
  assert.equal(warnings.length, 1);
});

test('server instructions stay short and the version matches package.json', () => {
  assert.ok(INSTRUCTIONS.length < 1500, `${INSTRUCTIONS.length} chars`);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(SERVER_VERSION, pkg.version);
});

// ---------------------------------------------------------------------------
// Aliases route to their target with mapped arguments
// ---------------------------------------------------------------------------

/** [alias, v3 arguments, target, arguments the target handler must receive]. */
const ALIAS_CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  ['glpi_list_tickets', { status: 2, range: '10-19', sort: 'date_mod', order: 'ASC', expand_dropdowns: true }, 'glpi_search_tickets', { status: 2, start: 10, limit: 10, sort: 'date_mod', order: 'ASC' }],
  ['glpi_get_ticket_followups', { ticket_id: 5 }, 'glpi_get_ticket_timeline', { id: 5, kinds: ['followup'] }],
  ['glpi_get_ticket_tasks', { ticket_id: 5 }, 'glpi_get_ticket_timeline', { id: 5, kinds: ['task'] }],
  ['glpi_get_ticket_solutions', { ticket_id: 5 }, 'glpi_get_ticket_timeline', { id: 5, kinds: ['solution'] }],
  ['glpi_get_ticket_validations', { ticket_id: 5 }, 'glpi_get_ticket_timeline', { id: 5, kinds: ['validation'] }],
  ['glpi_get_ticket_documents', { ticket_id: 5 }, 'glpi_get_ticket_timeline', { id: 5, kinds: ['document'] }],
  ['glpi_get_change_tasks', { change_id: 7 }, 'glpi_get_ticket_timeline', { id: 7, itemtype: 'Change', kinds: ['task'] }],
  ['glpi_get_problem_tasks', { problem_id: 8 }, 'glpi_get_ticket_timeline', { id: 8, itemtype: 'Problem', kinds: ['task'] }],
  ['glpi_get_computer', { id: 3, with_softwares: true, with_networkports: true, with_documents: false }, 'glpi_get_item', { itemtype: 'Computer', id: 3, with: ['softwares', 'networkports'] }],
  ['glpi_create_computer', { name: 'PC', serial: 'S' }, 'glpi_create_item', { itemtype: 'Computer', input: { name: 'PC', serial: 'S' } }],
  ['glpi_update_computer', { id: 3, states_id: 2 }, 'glpi_update_item', { itemtype: 'Computer', id: 3, input: { states_id: 2 } }],
  ['glpi_delete_computer', { id: 3 }, 'glpi_delete_item', { itemtype: 'Computer', id: 3, purge: false }],
  ['glpi_delete_computer', { id: 3, force: true }, 'glpi_delete_item', { itemtype: 'Computer', id: 3, purge: true, confirm_id: 3 }],
  ['glpi_create_software', { name: 'Vim' }, 'glpi_create_item', { itemtype: 'Software', input: { name: 'Vim' } }],
  ['glpi_create_contract', { name: 'C', duration: 12 }, 'glpi_create_item', { itemtype: 'Contract', input: { name: 'C', duration: 12 } }],
  ['glpi_create_supplier', { name: 'S' }, 'glpi_create_item', { itemtype: 'Supplier', input: { name: 'S' } }],
  ['glpi_create_location', { name: 'L', locations_id: 1 }, 'glpi_create_item', { itemtype: 'Location', input: { name: 'L', locations_id: 1 } }],
  ['glpi_create_project', { name: 'P' }, 'glpi_create_item', { itemtype: 'Project', input: { name: 'P' } }],
  ['glpi_update_project', { id: 4, percent_done: 50 }, 'glpi_update_item', { itemtype: 'Project', id: 4, input: { percent_done: 50 } }],
  ['glpi_create_group', { name: 'G', is_requester: true, is_assign: false }, 'glpi_create_item', { itemtype: 'Group', input: { name: 'G', is_requester: 1, is_assign: 0 } }],
  ['glpi_search_user', { name: 'jdoe' }, 'glpi_find_user', { query: 'jdoe', exact: true }],
  ['glpi_get_ticket_stats', { entity_id: 0, date_from: '2026-01-01' }, 'glpi_tickets_stats_by', { dimension: 'status', entity_id: 0, date_from: '2026-01-01' }],
  ['glpi_search', { itemtype: 'Computer', field: 1, searchtype: 'contains', value: 'PC' }, 'glpi_search_v2', { itemtype: 'Computer', criteria: [{ field: 1, searchtype: 'contains', value: 'PC' }] }],
];

const LIST_ALIASES: Array<[string, string]> = [
  ['glpi_list_computers', 'Computer'], ['glpi_list_softwares', 'Software'],
  ['glpi_list_network_equipments', 'NetworkEquipment'], ['glpi_list_printers', 'Printer'],
  ['glpi_list_monitors', 'Monitor'], ['glpi_list_phones', 'Phone'], ['glpi_list_knowbase', 'KnowbaseItem'],
  ['glpi_list_contracts', 'Contract'], ['glpi_list_suppliers', 'Supplier'], ['glpi_list_locations', 'Location'],
  ['glpi_list_projects', 'Project'], ['glpi_list_groups', 'Group'], ['glpi_list_categories', 'ITILCategory'],
  ['glpi_list_entities', 'Entity'], ['glpi_list_documents', 'Document'],
];
const GET_ALIASES: Array<[string, string]> = [
  ['glpi_get_software', 'Software'], ['glpi_get_network_equipment', 'NetworkEquipment'],
  ['glpi_get_printer', 'Printer'], ['glpi_get_monitor', 'Monitor'], ['glpi_get_phone', 'Phone'],
  ['glpi_get_knowbase_item', 'KnowbaseItem'], ['glpi_get_contract', 'Contract'], ['glpi_get_supplier', 'Supplier'],
  ['glpi_get_location', 'Location'], ['glpi_get_project', 'Project'], ['glpi_get_group', 'Group'],
  ['glpi_get_entity', 'Entity'], ['glpi_get_document', 'Document'],
];
for (const [name, itemtype] of LIST_ALIASES) {
  ALIAS_CASES.push([name, { limit: 5, sort: 'name', is_deleted: false }, 'glpi_list_items', { itemtype, limit: 5, sort: 'name', is_deleted: false }]);
}
for (const [name, itemtype] of GET_ALIASES) {
  ALIAS_CASES.push([name, { id: '12' }, 'glpi_get_item', { itemtype, id: 12 }]);
}

test('every alias is callable and reaches its target with mapped arguments', async () => {
  const received: Array<{ name: string; args: unknown }> = [];
  const spies = ALL_TOOLS.map(
    (def): ToolDef => ({
      ...def,
      handler: async (_ctx, args) => {
        received.push({ name: def.name, args });
        return text({ ok: true });
      },
    })
  );
  installFetch(() => undefined);
  const { client, close } = await connect({}, spies);

  const covered = new Set(ALIAS_CASES.map(([alias]) => alias));
  assert.deepEqual([...covered].sort(), ALL_ALIASES.map((a) => a.name).sort(), 'every alias has a case');

  for (const [alias, args, target, expected] of ALIAS_CASES) {
    received.length = 0;
    const res = await client.callTool({ name: alias, arguments: args });
    assert.ok(!res.isError, `${alias}: ${resultText(res)}`);
    assert.deepEqual(received, [{ name: target, args: expected }], alias);
  }
  await close();
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('unknown tool and invalid arguments are protocol errors', async () => {
  installFetch(() => undefined);
  const { client, close } = await connect();
  await assert.rejects(client.callTool({ name: 'glpi_nope', arguments: {} }), (e) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, -32601);
    return true;
  });
  await assert.rejects(client.callTool({ name: 'glpi_get_ticket', arguments: {} }), (e) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, -32602);
    assert.match(e.message, /id/);
    return true;
  });
  await assert.rejects(client.callTool({ name: 'glpi_get_ticket', arguments: { id: 1, bogus: true } }), /bogus/);
  await assert.rejects(
    client.callTool({ name: 'glpi_delete_item', arguments: { itemtype: 'Computer', id: 3, purge: true } }),
    /confirm_id/
  );
  await close();
});

test('a GLPI 403 ERROR_RIGHT_MISSING comes back as isError with a hint', async () => {
  installFetch((c) =>
    c.path === 'Computer/9'
      ? json(['ERROR_RIGHT_MISSING', "You don't have permission to perform this action."], { status: 403 })
      : undefined
  );
  const { client, close } = await connect();
  const res = await client.callTool({ name: 'glpi_get_item', arguments: { itemtype: 'Computer', id: 9 } });
  assert.equal(res.isError, true);
  assert.match(resultText(res), /^GLPI GET Computer\/9 -> 403 ERROR_RIGHT_MISSING/);
  assert.match(resultText(res), /glpi_get_session_info/);
  await close();
});

// ---------------------------------------------------------------------------
// End to end with the fake GLPI
// ---------------------------------------------------------------------------

const TICKET_OPTIONS = {
  1: { name: 'Title', field: 'name', uid: 'Ticket.name' },
  2: { name: 'ID', field: 'id', uid: 'Ticket.id' },
  4: { name: 'Requester', field: 'name', uid: 'Ticket.Ticket_User.User.name' },
  5: { name: 'Technician', field: 'name', uid: 'Ticket.Ticket_User.User.name' },
  12: { name: 'Status', field: 'status', uid: 'Ticket.status' },
  21: { name: 'Description', field: 'content', uid: 'Ticket.content' },
};

test('glpi_search_tickets returns an envelope with friendly keys and labels', async () => {
  const calls = installFetch((c) => {
    if (c.path === 'listSearchOptions/Ticket') return json(TICKET_OPTIONS);
    if (c.path === 'search/Ticket') {
      return json({
        totalcount: 40,
        count: 2,
        data: [
          { 2: 1, 1: 'A', 12: 2, 4: 'alice', 5: 'bob', 21: '&lt;p&gt;Hello&lt;/p&gt;' },
          { 2: 2, 1: 'B', 12: 5, 4: 'carol', 5: null, 21: '' },
        ],
      });
    }
    return undefined;
  });
  const { client, close } = await connect();
  const res = await client.callTool({ name: 'glpi_search_tickets', arguments: { status: 2, limit: 2 } });
  const body = resultJson(res);
  assert.equal(body.totalcount, 40);
  assert.equal(body.next_start, 2);
  assert.deepEqual(body.items[0], {
    id: 1, name: 'A', status: 2, requester_name: 'alice', technician_name: 'bob', content: 'Hello',
    status_label: 'Processing (assigned)',
  });
  const search = calls.find((c) => c.path === 'search/Ticket')!;
  assert.equal(search.query.get('range'), '0-1');
  assert.equal(search.query.get('criteria[0][field]'), '12');
  assert.ok(!resultText(res).includes('\n'), 'compact JSON');
  await close();
});

test('glpi_list_items: envelope from Content-Range, compact rows, no HATEOAS', async () => {
  const calls = installFetch((c) =>
    c.path === 'Computer'
      ? json([{ id: 1, name: 'PC-1', serial: 'X', ram: '8', links: [{ rel: 'Entity' }] }], {
          status: 206,
          headers: { 'Content-Range': '0-0/12' },
        })
      : undefined
  );
  const { client, close } = await connect();
  const body = resultJson(await client.callTool({ name: 'glpi_list_items', arguments: { itemtype: 'Computer', limit: 1 } }));
  assert.deepEqual(body, { totalcount: 12, start: 0, count: 1, next_start: 1, items: [{ id: 1, name: 'PC-1', serial: 'X' }] });
  assert.equal(calls[0].query.get('get_hateoas'), 'false');
  assert.equal(calls[0].query.get('range'), '0-0');
  await close();
});

test('glpi_get_ticket_timeline fetches only the requested kinds, sorted, as plain text', async () => {
  const calls = installFetch((c) => {
    if (c.path === 'Change/7/ITILFollowup') {
      return json([{ id: 2, date_creation: '2026-01-02 10:00:00', users_id: 'bob', content: '<p>second</p>', links: [] }]);
    }
    if (c.path === 'Change/7/ChangeTask') {
      return json([{ id: 9, date_creation: '2026-01-01 09:00:00', users_id: 'alice', state: 2, content: 'first', actiontime: 600 }]);
    }
    return undefined;
  });
  const { client, close } = await connect();
  const body = resultJson(
    await client.callTool({
      name: 'glpi_get_ticket_timeline',
      arguments: { id: 7, itemtype: 'Change', kinds: ['followup', 'task'] },
    })
  );
  assert.deepEqual(calls.map((c) => c.path).sort(), ['Change/7/ChangeTask', 'Change/7/ITILFollowup']);
  assert.deepEqual(body, {
    itemtype: 'Change',
    id: 7,
    count: 2,
    timeline: [
      { kind: 'task', date: '2026-01-01 09:00:00', id: 9, users_id: 'alice', state: 2, actiontime: 600, content: 'first' },
      { kind: 'followup', date: '2026-01-02 10:00:00', id: 2, users_id: 'bob', content: 'second' },
    ],
  });
  await close();
});

test('glpi_add_followup with itemtype Problem posts an ITILFollowup on the problem', async () => {
  const calls = installFetch((c) => (c.path === 'ITILFollowup' ? json({ id: 77 }, { status: 201 }) : undefined));
  const { client, close } = await connect();
  const res = await client.callTool({
    name: 'glpi_add_followup',
    arguments: { ticket_id: 4, itemtype: 'Problem', content: 'x' },
  });
  assert.deepEqual(resultJson(res), { success: true, followup_id: 77 });
  assert.deepEqual(calls[0].body, { input: { itemtype: 'Problem', items_id: 4, content: 'x', is_private: 0 } });
  await close();
});

test('glpi_update_item enforces the Computer whitelist; delete_ticket purge needs confirm_id', async () => {
  const calls = installFetch(() => json([{ 'Ticket/5': true }]));
  const { client, close } = await connect();
  await assert.rejects(
    client.callTool({ name: 'glpi_update_item', arguments: { itemtype: 'Computer', id: 1, input: { ram: 1 } } }),
    /Allowed: name/
  );
  await assert.rejects(client.callTool({ name: 'glpi_delete_ticket', arguments: { id: 5, force: true } }), /confirm_id/);
  const res = await client.callTool({ name: 'glpi_delete_ticket', arguments: { id: 5, purge: true, confirm_id: 5 } });
  assert.deepEqual(resultJson(res), { success: true, id: 5, purged: true });
  assert.equal(calls.at(-1)?.query.get('force_purge'), '1');
  await close();
});
