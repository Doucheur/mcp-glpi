/**
 * Read-only MCP resources (same URIs as v3), compact JSON.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GlpiClient } from './glpi-client.js';
import { stripLinks } from './output.js';
import {
  OPEN_PROBLEM_STATUSES,
  PENDING_CHANGE_STATUSES,
  TICKET_FIELDS,
  searchByStatuses,
} from './tool-helpers.js';

interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  read: (client: GlpiClient) => Promise<unknown>;
}

export const RESOURCES: ResourceDef[] = [
  {
    uri: 'glpi://tickets/open',
    name: 'Open Tickets',
    description: 'Tickets with status < 5 (100 most recently updated)',
    read: async (client) =>
      (
        await client.search.search('Ticket', {
          criteria: [{ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 }],
          limit: 100,
          order: 'DESC',
          sort: TICKET_FIELDS.date_mod,
          expandDropdowns: true,
        })
      ).data,
  },
  {
    uri: 'glpi://tickets/recent',
    name: 'Recent Tickets',
    description: 'The 20 most recent tickets',
    read: (client) => client.getTickets({ range: '0-19', order: 'DESC', expand_dropdowns: true }),
  },
  {
    uri: 'glpi://problems/open',
    name: 'Open Problems',
    description: 'Problems not solved/closed (50 most recently updated)',
    read: async (client) => (await searchByStatuses(client, 'Problem', OPEN_PROBLEM_STATUSES)).data,
  },
  {
    uri: 'glpi://changes/pending',
    name: 'Pending Changes',
    description: 'Changes not applied/closed/in review/refused/cancelled (50 most recently updated)',
    read: async (client) => (await searchByStatuses(client, 'Change', PENDING_CHANGE_STATUSES)).data,
  },
  {
    uri: 'glpi://computers',
    name: 'Computers',
    description: 'First 100 computers',
    read: (client) => client.getComputers({ range: '0-99', is_deleted: false }),
  },
  { uri: 'glpi://groups', name: 'Groups', description: 'First 100 groups', read: (client) => client.getGroups({ range: '0-99' }) },
  {
    uri: 'glpi://categories',
    name: 'Categories',
    description: 'First 100 ITIL categories',
    read: (client) => client.getCategories({ range: '0-99' }),
  },
  { uri: 'glpi://stats/tickets', name: 'Ticket Statistics', description: 'Ticket counts by status', read: (client) => client.getTicketStats() },
  { uri: 'glpi://stats/assets', name: 'Asset Statistics', description: 'Asset counts', read: (client) => client.getAssetStats() },
];

export function registerResources(server: McpServer, client: GlpiClient): void {
  for (const r of RESOURCES) {
    server.registerResource(r.name, r.uri, { description: r.description, mimeType: 'application/json' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(stripLinks(await r.read(client))) }],
    }));
  }
}
