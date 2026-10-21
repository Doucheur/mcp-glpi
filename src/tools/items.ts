/**
 * Generic CRUD over GLPI itemtypes: assets, KB, contracts, suppliers,
 * locations, entities, projects, documents, groups, categories...
 */

import { z } from 'zod';
import { ArgumentError } from '../errors.js';
import type { GetOptions } from '../glpi-client.js';
import { compactItem, listEnvelope, text } from '../output.js';
import { advertisedAs, defineTool, type ToolDef } from './registry.js';
import { ITIL_UPDATE_FIELDS } from './itil.js';
import { TICKET_UPDATE_FIELDS, checkPurge } from './tickets.js';
import { fields, id, listShape, optBool, optInt, textShape, toListOptions, verbose } from './common.js';

const invalid = (message: string) => new ArgumentError(message);

export const ITEMTYPES = [
  'Computer', 'Software', 'NetworkEquipment', 'Printer', 'Monitor', 'Phone', 'Peripheral',
  'Rack', 'Enclosure', 'PDU', 'KnowbaseItem', 'Contract', 'Supplier', 'Location', 'Entity',
  'Project', 'Document', 'Group', 'ITILCategory', 'Ticket', 'Problem', 'Change', 'User', 'Profile',
] as const;
export type Itemtype = (typeof ITEMTYPES)[number];

const itemtypeSchema = z.enum(ITEMTYPES);
/**
 * Write tools validate the same enum but list it as a string: the 24 values
 * are already listed by glpi_list_items / glpi_get_item, and an invalid
 * itemtype is rejected with the allowed values.
 */
const itemtypeWriteSchema = advertisedAs(z.enum(ITEMTYPES), {
  type: 'string',
  description: 'Itemtype, as in glpi_list_items',
});

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
  // Same fields as glpi_update_ticket / glpi_update_problem / glpi_update_change.
  Ticket: TICKET_UPDATE_FIELDS,
  Problem: ITIL_UPDATE_FIELDS,
  Change: ITIL_UPDATE_FIELDS,
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

const inputSchema = z.record(z.unknown()).describe('GLPI columns, e.g. {"name":"PC-42","locations_id":3}; booleans 0/1');

const listItems = defineTool({
  name: 'glpi_list_items',
  title: 'List items',
  toolset: 'core',
  description:
    'List items of one itemtype (assets, KB, contracts, groups, entities...) as compact rows. For criteria use glpi_search_v2.',
  inputSchema: {
    itemtype: itemtypeSchema,
    ...listShape,
    search_text: z.record(z.string()).optional().describe('{column: "substring"}; "^x$" for exact'),
    fields,
    verbose,
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
  toolset: 'core',
  description: 'One item of any itemtype, compact, optionally with related data (ports, software, documents...).',
  inputSchema: {
    itemtype: itemtypeSchema,
    id: id(),
    with: z.array(z.enum(WITH_FLAGS)).optional().describe('Related data to embed'),
    verbose,
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
  description: 'Create an item of any itemtype from GLPI column values and return its id.',
  inputSchema: {
    itemtype: itemtypeWriteSchema,
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
  description: 'Change the given fields of an item; Computer, Project, Ticket, Problem and Change allow only their usual fields.',
  inputSchema: {
    itemtype: itemtypeWriteSchema,
    id: id(),
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
  description: 'Trash an item (recoverable); purge=true with confirm_id=id deletes it for good.',
  inputSchema: {
    itemtype: itemtypeWriteSchema,
    id: id(),
    purge: optBool('Delete permanently; needs confirm_id'),
    confirm_id: optInt('Same id, to confirm a purge'),
  },
  handler: async ({ client }, a) => {
    const purge = checkPurge(a.id, a.purge, a.confirm_id);
    await client.deleteItem(a.itemtype, a.id, purge);
    return text({ success: true, itemtype: a.itemtype, id: a.id, purged: purge });
  },
});

export const ITEM_TOOLS: ToolDef[] = [listItems, getItem, createItem, updateItem, deleteItem];
