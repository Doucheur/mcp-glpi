/**
 * MCP prompts through the real McpServer and an in-memory transport.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GlpiClient } from '../src/glpi-client.js';
import { PROMPTS } from '../src/prompts.js';
import { ALL_TOOLS, createMcpServer } from '../src/server.js';

async function connect() {
  const calls: string[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string) => {
    calls.push(String(url));
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const glpi = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  const server = createMcpServer({ client: glpi });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls, close: () => client.close() };
}

const promptText = (r: { messages: Array<{ content: unknown }> }) =>
  r.messages.map((m) => (m.content as { text: string }).text).join('\n');

test('prompts/list returns the 5 prompts with described arguments; capability listChanged false', async () => {
  const { client, close } = await connect();
  assert.deepEqual(client.getServerCapabilities()?.prompts, { listChanged: false });
  const { prompts } = await client.listPrompts();
  await close();
  assert.deepEqual(
    prompts.map((p) => p.name).sort(),
    ['daily_report', 'draft_solution', 'kb_from_ticket', 'my_open_tickets', 'triage_ticket']
  );
  const byName = new Map(prompts.map((p) => [p.name, p]));
  for (const p of prompts) {
    assert.ok(p.title && p.description, `${p.name} has title and description`);
    for (const a of p.arguments ?? []) assert.ok(a.description, `${p.name}.${a.name} is described`);
  }
  for (const name of ['triage_ticket', 'draft_solution', 'kb_from_ticket']) {
    assert.deepEqual(byName.get(name)!.arguments?.map((a) => [a.name, a.required]), [['id', true]]);
  }
  assert.deepEqual(
    byName.get('daily_report')!.arguments?.map((a) => [a.name, a.required ?? false]).sort(),
    [['date', false], ['entity_id', false]]
  );
  assert.deepEqual(byName.get('my_open_tickets')!.arguments ?? [], []);
});

test('triage_ticket embeds the id, the read and write tools, confirmation and the status reference', async () => {
  const { client, calls, close } = await connect();
  const r = await client.getPrompt({ name: 'triage_ticket', arguments: { id: '4242' } });
  await close();
  const t = promptText(r);
  assert.match(t, /ticket 4242/);
  for (const tool of ['glpi_get_ticket', 'glpi_get_ticket_timeline', 'glpi_update_ticket', 'glpi_assign_ticket', 'glpi_add_followup']) {
    assert.ok(t.includes(tool), `mentions ${tool}`);
  }
  assert.match(t, /"ticket_id": 4242/);
  assert.match(t, /confirm/i);
  assert.match(t, /1 New, 2 Processing \(assigned\)/);
  assert.match(t, /language the user writes in/);
  assert.equal(calls.length, 0, 'building a prompt does not call GLPI');
});

test('prompt ids must be numeric and required', async () => {
  const { client, close } = await connect();
  try {
    await assert.rejects(client.getPrompt({ name: 'triage_ticket', arguments: { id: 'abc' } }));
    await assert.rejects(client.getPrompt({ name: 'draft_solution', arguments: {} }));
    await assert.rejects(client.getPrompt({ name: 'daily_report', arguments: { date: '20/10/2026' } }));
  } finally {
    await close();
  }
});

test('daily_report: day bounds, entity filter, stats_by, overdue, solved/closed counts', async () => {
  const { client, close } = await connect();
  const t = promptText(await client.getPrompt({ name: 'daily_report', arguments: { date: '2026-10-20', entity_id: '3' } }));
  const d = promptText(await client.getPrompt({ name: 'daily_report', arguments: {} }));
  await close();
  assert.ok(t.includes('"date_from": "2026-10-20 00:00:00", "date_to": "2026-10-20 23:59:59", "entity_id": 3'));
  for (const tool of ['glpi_tickets_stats_by', 'glpi_list_overdue_tickets', 'glpi_count']) assert.ok(t.includes(tool));
  assert.ok(t.includes('"field": "solvedate"') && t.includes('"field": "closedate"'));
  assert.ok(t.includes('"value": "notold"'));
  assert.match(t, /10 lines/);
  // Defaults: today, no entity.
  assert.match(d, /"date_from": "\d{4}-\d{2}-\d{2} 00:00:00"/);
  assert.ok(!d.includes('entity_id'));
});

test('draft_solution, kb_from_ticket and my_open_tickets name their tools', async () => {
  const { client, close } = await connect();
  const draft = promptText(await client.getPrompt({ name: 'draft_solution', arguments: { id: '7' } }));
  const kb = promptText(await client.getPrompt({ name: 'kb_from_ticket', arguments: { id: '8' } }));
  const mine = promptText(await client.getPrompt({ name: 'my_open_tickets', arguments: {} }));
  await close();
  assert.ok(draft.includes('glpi_search_knowbase') && draft.includes('glpi_add_solution {"ticket_id": 7'));
  assert.ok(kb.includes('glpi_create_knowbase_item') && kb.includes('Source: ticket 8'));
  assert.match(kb, /Symptoms[\s\S]*Cause[\s\S]*Resolution[\s\S]*Keywords/);
  assert.ok(mine.includes('glpi_get_session_info') && mine.includes('"assigned_user_id": <me.id>'));
  assert.match(mine, /"me" is not accepted/);
});

test('every tool named in a prompt exists in the catalogue', () => {
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  for (const p of PROMPTS) {
    const t = promptText(p.build({ id: '1' }));
    for (const m of t.matchAll(/\bglpi_[a-z_]+/g)) assert.ok(names.has(m[0]), `${p.name} references unknown tool ${m[0]}`);
  }
});
