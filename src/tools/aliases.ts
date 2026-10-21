/**
 * v3 tool names that v4 folded into other tools. They stay callable (hidden
 * from tools/list unless GLPI_LEGACY_TOOLS=1) and translate their arguments.
 *
 * Every argument a v3 tool listed is accepted (checked against the v3.4
 * catalogue, test/server.test.ts "every alias accepts its v3 arguments"):
 *   - list aliases: start, limit, range, sort, order, expand_dropdowns
 *     (glpi_list_items takes them; include_deleted gets an explanatory
 *     isError, see common.ts);
 *   - get aliases: id, and with_softwares / with_networkports /
 *     with_connections / with_documents on the six asset types;
 *   - create / update aliases: their columns, passed as `input`;
 *   - glpi_list_tickets: the list arguments plus status;
 *   - glpi_search: itemtype, field, searchtype, value (plus start, limit,
 *     range, expand_dropdowns, which v3 ignored).
 */

import { ArgumentError } from '../errors.js';
import type { AliasDef } from './registry.js';
import type { TimelineKind } from './tickets.js';
import { INCLUDE_DELETED_REMOVED, bool01, defined, rangeArgs } from './common.js';

type Args = Record<string, unknown>;

/** Split off `keys`; the rest of the arguments become `input`. */
function toInput(args: Args, keep: readonly string[] = []): { kept: Args; input: Args } {
  const kept: Args = {};
  const input: Args = {};
  for (const [k, v] of Object.entries(args)) {
    if (keep.includes(k)) kept[k] = v;
    else input[k] = bool01(v);
  }
  return { kept, input };
}

const WITH_ARGS = ['with_softwares', 'with_networkports', 'with_connections', 'with_documents'];

function listAlias(name: string, itemtype: string): AliasDef {
  return { name, target: 'glpi_list_items', mapArgs: (a) => ({ ...rangeArgs(a), itemtype }) };
}

function getAlias(name: string, itemtype: string): AliasDef {
  return {
    name,
    target: 'glpi_get_item',
    mapArgs: (a) => {
      const withFlags = WITH_ARGS.filter((k) => a[k] === true).map((k) => k.slice('with_'.length));
      const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !WITH_ARGS.includes(k)));
      return { ...rest, itemtype, ...(withFlags.length ? { with: withFlags } : {}) };
    },
  };
}

function createAlias(name: string, itemtype: string): AliasDef {
  return { name, target: 'glpi_create_item', mapArgs: (a) => ({ itemtype, input: toInput(a).input }) };
}

function updateAlias(name: string, itemtype: string): AliasDef {
  return {
    name,
    target: 'glpi_update_item',
    mapArgs: (a) => {
      const { kept, input } = toInput(a, ['id']);
      return { itemtype, id: kept.id, input };
    },
  };
}

function timelineAlias(name: string, idKey: string, kind: TimelineKind, itemtype?: string): AliasDef {
  return {
    name,
    target: 'glpi_get_ticket_timeline',
    mapArgs: (a) => {
      const { [idKey]: parentId, ...rest } = a;
      return { ...rest, id: parentId, kinds: [kind], ...(itemtype ? { itemtype } : {}) };
    },
  };
}

const ASSETS: Array<[string, string, string]> = [
  ['computers', 'computer', 'Computer'],
  ['softwares', 'software', 'Software'],
  ['network_equipments', 'network_equipment', 'NetworkEquipment'],
  ['printers', 'printer', 'Printer'],
  ['monitors', 'monitor', 'Monitor'],
  ['phones', 'phone', 'Phone'],
];

export const ALIASES: AliasDef[] = [
  // tickets
  {
    name: 'glpi_list_tickets',
    target: 'glpi_search_tickets',
    mapArgs: (a) => {
      if (a.include_deleted !== undefined) throw new ArgumentError(INCLUDE_DELETED_REMOVED);
      // Search rows always carry labels: expand_dropdowns has no equivalent.
      const { expand_dropdowns: _e, ...rest } = rangeArgs(a);
      return rest;
    },
  },
  timelineAlias('glpi_get_ticket_followups', 'ticket_id', 'followup'),
  timelineAlias('glpi_get_ticket_tasks', 'ticket_id', 'task'),
  timelineAlias('glpi_get_ticket_solutions', 'ticket_id', 'solution'),
  timelineAlias('glpi_get_ticket_validations', 'ticket_id', 'validation'),
  timelineAlias('glpi_get_ticket_documents', 'ticket_id', 'document'),
  timelineAlias('glpi_get_change_tasks', 'change_id', 'task', 'Change'),
  timelineAlias('glpi_get_problem_tasks', 'problem_id', 'task', 'Problem'),

  // assets
  ...ASSETS.flatMap(([plural, singular, itemtype]) => [
    listAlias(`glpi_list_${plural}`, itemtype),
    getAlias(`glpi_get_${singular}`, itemtype),
  ]),
  createAlias('glpi_create_computer', 'Computer'),
  updateAlias('glpi_update_computer', 'Computer'),
  {
    name: 'glpi_delete_computer',
    target: 'glpi_delete_item',
    // v3 purged on force=true without confirmation: keep that for old callers.
    mapArgs: (a) =>
      defined({ itemtype: 'Computer', id: a.id, purge: a.force === true, confirm_id: a.force === true ? a.id : undefined }),
  },
  createAlias('glpi_create_software', 'Software'),

  // KB / contracts / suppliers / locations / projects
  listAlias('glpi_list_knowbase', 'KnowbaseItem'),
  getAlias('glpi_get_knowbase_item', 'KnowbaseItem'),
  listAlias('glpi_list_contracts', 'Contract'),
  getAlias('glpi_get_contract', 'Contract'),
  createAlias('glpi_create_contract', 'Contract'),
  listAlias('glpi_list_suppliers', 'Supplier'),
  getAlias('glpi_get_supplier', 'Supplier'),
  createAlias('glpi_create_supplier', 'Supplier'),
  listAlias('glpi_list_locations', 'Location'),
  getAlias('glpi_get_location', 'Location'),
  createAlias('glpi_create_location', 'Location'),
  listAlias('glpi_list_projects', 'Project'),
  getAlias('glpi_get_project', 'Project'),
  createAlias('glpi_create_project', 'Project'),
  updateAlias('glpi_update_project', 'Project'),

  // users / groups / categories / entities / documents
  { name: 'glpi_search_user', target: 'glpi_find_user', mapArgs: (a) => ({ query: a.name, exact: true }) },
  listAlias('glpi_list_groups', 'Group'),
  getAlias('glpi_get_group', 'Group'),
  createAlias('glpi_create_group', 'Group'),
  listAlias('glpi_list_categories', 'ITILCategory'),
  listAlias('glpi_list_entities', 'Entity'),
  getAlias('glpi_get_entity', 'Entity'),
  listAlias('glpi_list_documents', 'Document'),
  getAlias('glpi_get_document', 'Document'),

  // stats / search
  { name: 'glpi_get_ticket_stats', target: 'glpi_tickets_stats_by', mapArgs: (a) => ({ ...a, dimension: 'status' }) },
  {
    name: 'glpi_search',
    target: 'glpi_search_v2',
    mapArgs: (a) => {
      const { itemtype, field, searchtype, value, ...rest } = rangeArgs(a);
      return { ...rest, itemtype, criteria: [{ field, searchtype, value }] };
    },
  },
];
