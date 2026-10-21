/**
 * Generic CRUD over GLPI itemtypes: assets, KB, contracts, suppliers,
 * locations, entities, projects, documents, groups, categories...
 */

import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GetOptions } from '../glpi-client.js';
import { compactItem, listEnvelope, text } from '../output.js';
import { defineTool, type ToolDef } from './registry.js';
import { checkPurge } from './tickets.js';
import { id, listShape, optBool, optInt, textShape, toListOptions } from './common.js';

const invalid = (message: string) => new McpError(ErrorCode.InvalidParams, message);

export const ITEMTYPES = [
  'Computer', 'Software', 'NetworkEquipment', 'Printer', 'Monitor', 'Phone', 'Peripheral',
  'Rack', 'Enclosure', 'PDU', 'KnowbaseItem', 'Contract', 'Supplier', 'Location', 'Entity',
  'Project', 'Document', 'Group', 'ITILCategory', 'Ticket', 'Problem', 'Change', 'User', 'Profile',
] as const;
export type Itemtype = (typeof ITEMTYPES)[number];

const itemtypeSchema = z
  .enum(ITEMTYPES)
  .describe('GLPI itemtype (case-sensitive). Ids are per itemtype.');

/** Sub-resources glpi_get_item can embed (GLPI `with_*` query flags). */
export const WITH_FLAGS = [
  'softwares', 'networkports', 'connections', 'disks', 'documents', 'infocoms', 'contracts',
  'tickets', 'problems', 'changes', 'logs',
] as const;

/** Fields glpi_update_item may change, where v3 restricted them. */
export const UPDATE_FIELDS: Partial<Record<Itemtype, readonly string[]>> = {
  Computer: [
    'name', 'serial', 'otherserial', 'uuid', 'contact', 'contact_num', 'comment',
    'locations_id', 'states_id', 'computertypes_id', 'computermodels_id', 'manufacturers_id',
    'users_id', 'groups_id', 'users_id_tech', 'groups_id_tech',
  ],
  Project: ['name', 'content', 'percent_done', 'real_start_date', 'real_end_date'],
  Ticket: ['name', 'content', 'status', 'urgency', 'priority', 'impact', 'itilcategories_id'],
  Problem: ['name', 'content', 'status', 'urgency', 'priority', 'impact', 'itilcategories_id'],
  Change: ['name', 'content', 'status', 'urgency', 'priority', 'impact', 'itilcategories_id'],
};

const PASSWORD_FIELDS = ['password', 'password2'];

function checkInput(itemtype: Itemtype, input: Record<string, unknown>, allowed?: readonly string[]) {
  if (Object.keys(input).length === 0) throw invalid('input is empty');
  if (itemtype === 'User') {
    const pw = Object.keys(input).filter((k) => PASSWORD_FIELDS.includes(k));
    if (pw.length) throw invalid('passwords cannot be set through this server; GLPI sends the invitation or an admin sets it');
  }
  if (allowed) {
    const unknown = Object.keys(input).filter((k) => !allowed.includes(k) && k !== 'id');
    if (unknown.length) {
      throw invalid(`${itemtype}: field(s) ${unknown.join(', ')} cannot be updated here. Allowed: ${allowed.join(', ')}`);
    }
  }
}

const inputSchema = z
  .record(z.unknown())
  .describe('Fields as GLPI expects them (column names: name, comment, locations_id, states_id...). Booleans as 0/1.');

const listItems = defineTool({
  name: 'glpi_list_items',
  title: 'List items',
  toolset: 'assets',
  description:
    'List items of an itemtype (computers, printers, KB articles, contracts, groups, entities...). ' +
    'Returns {totalcount,start,count,next_start,items} with a compact projection. ' +
    'For filters beyond search_text use glpi_search_v2.',
  inputSchema: {
    itemtype: itemtypeSchema,
    ...listShape,
    search_text: z
      .record(z.string())
      .optional()
      .describe('Column filters {column: "text"} (substring match; "^x$" for exact), e.g. {"name": "PC-"}'),
    fields: z.array(z.string()).min(1).optional().describe('Keys to return instead of the default projection'),
    verbose: optBool('All fields, as GLPI sends them'),
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const { opts, start } = toListOptions(a);
    if (a.search_text) opts.searchText = a.search_text;
    const page = await client.getItemsPage<Record<string, unknown>>(a.itemtype, opts);
    const items = page.items.map((row) => compactItem(a.itemtype, row, a));
    return text(listEnvelope(items, start, page.totalcount));
  },
});

const getItem = defineTool({
  name: 'glpi_get_item',
  title: 'Get item',
  toolset: 'assets',
  description:
    'One item of any itemtype, compact by default (verbose for every field). ' +
    'with embeds related data, e.g. ["networkports","softwares","documents","infocoms","contracts","tickets"].',
  inputSchema: {
    itemtype: itemtypeSchema,
    id: id('Item id'),
    with: z.array(z.enum(WITH_FLAGS)).optional().describe('Related data to embed (GLPI with_* flags)'),
    verbose: optBool('All fields, as GLPI sends them'),
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const opts: GetOptions = {};
    for (const flag of a.with ?? []) (opts as Record<string, boolean>)[`with_${flag}`] = true;
    const item = await client.getItem<Record<string, unknown>>(a.itemtype, a.id, opts);
    return text(compactItem(a.itemtype, item, a));
  },
});

const createItem = defineTool({
  name: 'glpi_create_item',
  title: 'Create item',
  toolset: 'assets',
  description: 'Create an item of any itemtype from GLPI fields, e.g. {itemtype:"Computer", input:{name:"PC-42", locations_id:3}}. Returns its id.',
  inputSchema: {
    itemtype: itemtypeSchema,
    input: inputSchema,
  },
  handler: async ({ client }, a) => {
    checkInput(a.itemtype, a.input);
    const result = await client.createItem(a.itemtype, a.input);
    return text({ success: true, itemtype: a.itemtype, ...result });
  },
});

const updateItem = defineTool({
  name: 'glpi_update_item',
  title: 'Update item',
  toolset: 'assets',
  description:
    'Change fields of an item. Computer, Project, Ticket, Problem and Change accept only their usual editable fields (listed in the error otherwise).',
  inputSchema: {
    itemtype: itemtypeSchema,
    id: id('Item id'),
    input: inputSchema,
  },
  handler: async ({ client }, a) => {
    checkInput(a.itemtype, a.input, UPDATE_FIELDS[a.itemtype]);
    const { id: _ignored, ...fields } = a.input;
    if (Object.keys(fields).length === 0) throw invalid('nothing to update');
    await client.updateItem(a.itemtype, a.id, fields);
    return text({ success: true, itemtype: a.itemtype, id: a.id });
  },
});

const deleteItem = defineTool({
  name: 'glpi_delete_item',
  title: 'Delete item',
  toolset: 'assets',
  description:
    'Move an item to the trash (recoverable). purge=true deletes it permanently and requires confirm_id equal to id.',
  inputSchema: {
    itemtype: itemtypeSchema,
    id: id('Item id'),
    purge: optBool('Delete permanently (irreversible); needs confirm_id'),
    confirm_id: optInt('Repeat the item id to confirm a purge'),
  },
  handler: async ({ client }, a) => {
    const purge = checkPurge(a.id, a.purge, a.confirm_id);
    await client.deleteItem(a.itemtype, a.id, purge);
    return text({ success: true, itemtype: a.itemtype, id: a.id, purged: purge });
  },
});

export const ITEM_TOOLS: ToolDef[] = [listItems, getItem, createItem, updateItem, deleteItem];
