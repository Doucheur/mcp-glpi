/**
 * Measure what the server advertises to a model: the tools/list payload and
 * the session instructions, built in-process through createMcpServer (the
 * same path as the real server) with a dummy GLPI config. No network.
 *
 * Usage: npm run measure            # full catalogue + GLPI_READ_ONLY=1
 *        npm run measure -- --json  # machine-readable
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { INSTRUCTIONS, createMcpServer } from '../src/server.js';
import { type RegistryOptions, parseRegistryOptions } from '../src/tools/registry.js';

type Tool = ListToolsResult['tools'][number];

const CHARS_PER_TOKEN = 3.6;
const SCAFFOLDING_KEYS = new Set(['type', 'additionalProperties', 'required', '$schema']);

const tokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
/** Size of `"key":value,` in compact JSON. */
const entry = (key: string, value: unknown) => JSON.stringify(key).length + 1 + JSON.stringify(value).length + 1;

async function listCatalogue(options: RegistryOptions): Promise<{ tools: Tool[]; instructions: string }> {
  const glpi = new GlpiClient({ url: 'https://glpi.invalid', userToken: 'dummy', maxRetries: 0 });
  const server = createMcpServer({ client: glpi, options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'measure', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  await client.close();
  return { tools, instructions };
}

interface Shares {
  descriptions: number;
  paramDescriptions: number;
  scaffolding: number;
  annotationsTitle: number;
}

/** Walk a JSON schema and attribute characters to parameter descriptions / scaffolding. */
function walkSchema(node: unknown, shares: Shares): void {
  if (Array.isArray(node)) {
    for (const v of node) walkSchema(v, shares);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'description' && typeof value === 'string') {
      shares.paramDescriptions += entry(key, value);
    } else if (SCAFFOLDING_KEYS.has(key) && (key === 'required' || value === null || typeof value !== 'object')) {
      shares.scaffolding += entry(key, value);
    } else if (key === 'properties' && value && typeof value === 'object') {
      shares.scaffolding += entry(key, {}); // the "properties":{} wrapper; its content is walked
      for (const prop of Object.values(value as Record<string, unknown>)) walkSchema(prop, shares);
    } else {
      walkSchema(value, shares);
    }
  }
}

function analyse(tools: Tool[]) {
  const total = JSON.stringify({ tools }).length;
  const shares: Shares = { descriptions: 0, paramDescriptions: 0, scaffolding: 0, annotationsTitle: 0 };
  const perTool = tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length }));
  for (const t of tools) {
    if (t.description) shares.descriptions += entry('description', t.description);
    if (t.title) shares.annotationsTitle += entry('title', t.title);
    if (t.annotations) shares.annotationsTitle += entry('annotations', t.annotations);
    walkSchema(t.inputSchema, shares);
  }
  const other = total - shares.descriptions - shares.paramDescriptions - shares.scaffolding - shares.annotationsTitle;
  perTool.sort((a, b) => b.chars - a.chars);
  return { count: tools.length, total, tokens: tokens(total), shares: { ...shares, other }, top: perTool.slice(0, 15) };
}

const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(1)}%`;
const row = (label: string, n: number, total: number) => `   ${label.padEnd(25)}${String(n).padStart(6)}  ${pct(n, total)}`;

function report(label: string, a: ReturnType<typeof analyse>) {
  console.log(`\n== ${label}: ${a.count} tools, ${a.total} chars, ~${a.tokens} tokens`);
  const s = a.shares;
  console.log(row('tool descriptions', s.descriptions, a.total));
  console.log(row('parameter descriptions', s.paramDescriptions, a.total));
  console.log(row('schema scaffolding', s.scaffolding, a.total));
  console.log(row('annotations + title', s.annotationsTitle, a.total));
  console.log(row('other (names, enums...)', s.other, a.total));
}

async function main() {
  const full = await listCatalogue({});
  const readOnly = await listCatalogue(parseRegistryOptions({ GLPI_READ_ONLY: '1' }));
  const a = analyse(full.tools);
  const r = analyse(readOnly.tools);
  const instructions = { chars: full.instructions.length, tokens: tokens(full.instructions.length) };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ full: a, readOnly: r, instructions }, null, 2));
    return;
  }
  report('full catalogue', a);
  console.log('   top 15 tools by size:');
  for (const t of a.top) console.log(`     ${String(t.chars).padStart(5)}  ${t.name}`);
  report('GLPI_READ_ONLY=1', r);
  console.log(`\n== instructions: ${instructions.chars} chars, ~${instructions.tokens} tokens (sent once per session)`);
  if (INSTRUCTIONS !== full.instructions) console.log('   (warning: client-side instructions differ from INSTRUCTIONS)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
