/**
 * Read-only MCP resources, compact JSON (output.ts conventions).
 *
 *   - Fixed URIs (same as v3): lists return the list envelope
 *     `{ totalcount, start, count, next_start, items }`; search-based lists
 *     have readable keys and `status_label`, GET-based lists use the compact
 *     per-itemtype projection.
 *   - Templates: `glpi://ticket/{id}` (ticket + last timeline entries),
 *     `glpi://kb/{id}` (article as plain text), `glpi://user/{id}`.
 *
 * The resource lists never change at runtime: `listChanged: false`.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GlpiClient } from './glpi-client.js';
import { VALIDATION_STATUS } from './itil.js';
import { cleanTextFields, compactItem, listEnvelope, stripLinks } from './output.js';
import {
  OPEN_PROBLEM_STATUSES,
  OPEN_STATUS_VALUE,
  PENDING_CHANGE_STATUSES,
  searchByStatuses,
  ticketField,
} from './tool-helpers.js';
import { searchEnvelope } from './tools/search-rows.js';

const MIME = 'application/json';

/** Timeline entries returned by glpi://ticket/{id} (most recent ones). */
export const TICKET_RESOURCE_TIMELINE = 10;
/** Text cap for each timeline entry of glpi://ticket/{id}. */
export const TICKET_RESOURCE_ENTRY_CHARS = 800;
/** Text cap for the ticket description and KB answers. */
export const TICKET_RESOURCE_CONTENT_CHARS = 2000;
export const KB_RESOURCE_CHARS = 10000;

interface ResourceDef {
  uri: string;
  name: string;
  title: string;
  description: string;
  read: (client: GlpiClient) => Promise<unknown>;
}

/** `GET /{itemtype}` page as a list envelope of compact items. */
async function compactList(client: GlpiClient, itemtype: string, limit: number, extra: { is_deleted?: boolean } = {}) {
  const page = await client.getItemsPage<Record<string, unknown>>(itemtype, { range: `0-${limit - 1}`, expand_dropdowns: true, ...extra });
  return listEnvelope(
    page.items.map((i) => compactItem(itemtype, i)),
    0,
    page.totalcount
  );
}

export const RESOURCES: readonly ResourceDef[] = [
  {
    uri: 'glpi://tickets/open',
    name: 'open-tickets',
    title: 'Open tickets',
    description: 'Tickets not solved/closed (status notold), 100 most recently updated, readable keys',
    read: async (client) => {
      const [status, dateMod] = await Promise.all([ticketField(client, 'status'), ticketField(client, 'date_mod')]);
      const result = await client.search.search<Record<string, unknown>>('Ticket', {
        criteria: [{ field: status, searchtype: 'equals', value: OPEN_STATUS_VALUE }],
        limit: 100,
        order: 'DESC',
        sort: dateMod,
        expandDropdowns: true,
      });
      return searchEnvelope('Ticket', result);
    },
  },
  {
    uri: 'glpi://tickets/recent',
    name: 'recent-tickets',
    title: 'Recent tickets',
    description: 'The 20 most recently opened tickets (any status), readable keys',
    read: async (client) => {
      const result = await client.search.search<Record<string, unknown>>('Ticket', {
        limit: 20,
        order: 'DESC',
        sort: await ticketField(client, 'date'),
        expandDropdowns: true,
      });
      return searchEnvelope('Ticket', result);
    },
  },
  {
    uri: 'glpi://problems/open',
    name: 'open-problems',
    title: 'Open problems',
    description: 'Problems not solved/closed (status 1,2,3,4,7,8), 50 most recently updated',
    read: async (client) => searchEnvelope('Problem', await searchByStatuses(client, 'Problem', OPEN_PROBLEM_STATUSES)),
  },
  {
    uri: 'glpi://changes/pending',
    name: 'pending-changes',
    title: 'Pending changes',
    description:
      'Changes not applied/closed/in review/refused/cancelled (status 1,2,3,4,7,9,10,11,12), 50 most recently updated',
    read: async (client) => searchEnvelope('Change', await searchByStatuses(client, 'Change', PENDING_CHANGE_STATUSES)),
  },
  {
    uri: 'glpi://computers',
    name: 'computers',
    title: 'Computers',
    description: 'First 100 computers (not in the trash), compact fields',
    read: (client) => compactList(client, 'Computer', 100, { is_deleted: false }),
  },
  {
    uri: 'glpi://groups',
    name: 'groups',
    title: 'Groups',
    description: 'First 100 groups, compact fields',
    read: (client) => compactList(client, 'Group', 100),
  },
  {
    uri: 'glpi://categories',
    name: 'categories',
    title: 'ITIL categories',
    description: 'First 100 ITIL categories, compact fields',
    read: (client) => compactList(client, 'ITILCategory', 100),
  },
  {
    uri: 'glpi://stats/tickets',
    name: 'ticket-stats',
    title: 'Ticket statistics',
    description: 'Ticket counts by status (total, new, processing, pending, solved, closed)',
    read: (client) => client.getTicketStats(),
  },
  {
    uri: 'glpi://stats/assets',
    name: 'asset-stats',
    title: 'Asset statistics',
    description: 'Number of computers, monitors, printers, network equipments, phones and software',
    read: (client) => client.getAssetStats(),
  },
];

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type EntryKind = 'followup' | 'task' | 'solution' | 'validation';

const ENTRY_FIELDS: Record<EntryKind, readonly string[]> = {
  followup: ['id', 'users_id', 'is_private', 'content'],
  task: ['id', 'users_id', 'users_id_tech', 'state', 'actiontime', 'is_private', 'content'],
  solution: ['id', 'users_id', 'status', 'content'],
  validation: ['id', 'users_id', 'users_id_validate', 'status', 'status_label', 'comment_submission', 'comment_validation'],
};

function entry(kind: EntryKind, raw: unknown): Record<string, unknown> {
  const row = stripLinks((raw ?? {}) as Record<string, unknown>);
  const src = kind === 'validation' ? { ...row, status_label: VALIDATION_STATUS[Number(row.status)] ?? null } : row;
  const out: Record<string, unknown> = {};
  for (const k of ENTRY_FIELDS[kind]) if (src[k] !== undefined) out[k] = src[k];
  const d = kind === 'validation' ? row.submission_date ?? row.date_creation : row.date_creation ?? row.date ?? row.date_mod;
  return { kind, date: typeof d === 'string' ? d : '', ...cleanTextFields(out, { max_content_chars: TICKET_RESOURCE_ENTRY_CHARS }) };
}

/** Compact ticket plus its last `TICKET_RESOURCE_TIMELINE` timeline entries (oldest first). */
export async function readTicketResource(client: GlpiClient, id: number): Promise<Record<string, unknown>> {
  const [ticket, followups, tasks, solutions, validations] = await Promise.all([
    client.getTicket(id),
    client.getItilFollowups('Ticket', id),
    client.getItilTasks('Ticket', id),
    client.getItilSolutions('Ticket', id),
    client.getItilValidations('Ticket', id),
  ]);
  const all = [
    ...followups.map((r) => entry('followup', r)),
    ...tasks.map((r) => entry('task', r)),
    ...solutions.map((r) => entry('solution', r)),
    ...validations.map((r) => entry('validation', r)),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    ...compactItem('Ticket', ticket, { max_content_chars: TICKET_RESOURCE_CONTENT_CHARS }),
    timeline_total: all.length,
    timeline: all.slice(-TICKET_RESOURCE_TIMELINE),
  };
}

interface TemplateDef {
  name: string;
  title: string;
  uriTemplate: string;
  description: string;
  read: (client: GlpiClient, id: number) => Promise<unknown>;
}

export const RESOURCE_TEMPLATES: readonly TemplateDef[] = [
  {
    name: 'ticket',
    title: 'Ticket',
    uriTemplate: 'glpi://ticket/{id}',
    description: `One ticket: compact fields with status_label, plain-text content, and its last ${TICKET_RESOURCE_TIMELINE} timeline entries (followups, tasks, solutions, validations; text truncated)`,
    read: readTicketResource,
  },
  {
    name: 'kb-article',
    title: 'Knowledge base article',
    uriTemplate: 'glpi://kb/{id}',
    description: 'One knowledge base article (KnowbaseItem), answer converted from HTML to plain text',
    read: async (client, id) => compactItem('KnowbaseItem', await client.getKnowbaseItem(id), { max_content_chars: KB_RESOURCE_CHARS }),
  },
  {
    name: 'user',
    title: 'User',
    uriTemplate: 'glpi://user/{id}',
    description: 'One user: login, names, phones, entity, profile, location, last login',
    read: async (client, id) => compactItem('User', await client.getUser(id)),
  },
];

function parseId(value: string | string[] | undefined, uri: string): number {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !/^\d+$/.test(v) || Number(v) < 1) {
    throw new McpError(ErrorCode.InvalidParams, `${uri}: id must be a positive integer`);
  }
  return Number(v);
}

const json = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: MIME, text: JSON.stringify(stripLinks(value)) }] });

export function registerResources(server: McpServer, client: GlpiClient): void {
  for (const r of RESOURCES) {
    server.registerResource(r.name, r.uri, { title: r.title, description: r.description, mimeType: MIME }, async (uri) =>
      json(uri, await r.read(client))
    );
  }
  for (const t of RESOURCE_TEMPLATES) {
    server.registerResource(
      t.name,
      new ResourceTemplate(t.uriTemplate, { list: undefined }),
      { title: t.title, description: t.description, mimeType: MIME },
      async (uri, variables) => json(uri, await t.read(client, parseId(variables.id, uri.href)))
    );
  }
  // McpServer advertises listChanged: true; the set is fixed for the server's lifetime.
  server.server.registerCapabilities({ resources: { listChanged: false } });
}
