/**
 * MCP server factory: one McpServer per connection (stdio: one; HTTP: one
 * per request), all sharing the process-wide GlpiClient.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GlpiClient } from './glpi-client.js';
import { registerResources } from './resources.js';
import { ALIASES } from './tools/aliases.js';
import { ITEM_TOOLS } from './tools/items.js';
import { ITIL_TOOLS } from './tools/itil.js';
import { type AliasDef, type RegistryOptions, type ToolDef, parseRegistryOptions, registerAll } from './tools/registry.js';
import { SEARCH_TOOLS } from './tools/search.js';
import { STATS_TOOLS } from './tools/stats.js';
import { TICKET_TOOLS } from './tools/tickets.js';
import { USER_TOOLS } from './tools/users.js';

/** Keep in sync with package.json (a test checks it). */
export const SERVER_VERSION = '4.0.0';

export type ServerOptions = RegistryOptions;
export const parseServerOptions = parseRegistryOptions;

export const ALL_TOOLS: readonly ToolDef[] = [
  ...TICKET_TOOLS,
  ...ITIL_TOOLS,
  ...ITEM_TOOLS,
  ...USER_TOOLS,
  ...SEARCH_TOOLS,
  ...STATS_TOOLS,
];
export const ALL_ALIASES: readonly AliasDef[] = ALIASES;

export const INSTRUCTIONS = `GLPI IT service management (tickets, problems, changes, assets, users, knowledge base) through the GLPI REST API.
Choosing tools: glpi_search_tickets for tickets by status, actor, category, entity, dates or title; glpi_search_v2 for any itemtype with criteria (field names/ids from glpi_list_search_options) and glpi_count for totals; glpi_list_items / glpi_get_item for other itemtypes (assets, KB, contracts, groups, entities...); glpi_get_ticket_timeline for the followups, tasks, solutions and validations of a ticket, change or problem.
Ids are per itemtype: Ticket 12 and Change 12 are unrelated; always pass the itemtype.
Ticket status: 1 New, 2 Processing (assigned), 3 Processing (planned), 4 Pending, 5 Solved, 6 Closed. Problem: same plus 7 Accepted, 8 Under observation. Change: 1 New, 9 Evaluation, 10 Approval, 7 Accepted, 4 Pending, 11 Testing, 12 Qualification, 5 Applied, 8 Review, 6 Closed, 13 Refused, 14 Cancelled.
Urgency and impact 1-5 (Very low..Very high); priority 1-6 (6 Major). Validation: 1 Waiting, 2 Granted, 3 Refused.
Lists return {totalcount,start,count,next_start,items}: pass start=next_start for the next page.
Write tools (create, update, delete, add, assign, link, set) change production data: confirm with the user first.
Dates are 'YYYY-MM-DD HH:MM:SS' in the GLPI server timezone.`;

export interface CreateMcpServerOptions {
  client: GlpiClient;
  options?: ServerOptions;
  tools?: readonly ToolDef[];
  aliases?: readonly AliasDef[];
}

export function createMcpServer({ client, options = {}, tools = ALL_TOOLS, aliases = ALL_ALIASES }: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'mcp-glpi', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } }
  );
  registerAll(server, { client, options }, tools, aliases, options);
  registerResources(server, client);
  return server;
}
