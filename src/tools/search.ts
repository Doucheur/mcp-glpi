/**
 * Generic search (search/{itemtype}), counts, the search-option catalogue,
 * and the knowledge base.
 */

import { z } from 'zod';
import { pageLimit, text } from '../output.js';
import { type CriteriaArg, resolveCriteria } from '../tool-helpers.js';
import { advertisedAs, defineTool, type ToolDef } from './registry.js';
import { expandDropdowns, isDeleted, optBool, optStr, pageShape, searchPageShape, textShape } from './common.js';
import { resolveSearchSort, searchEnvelope } from './search-rows.js';

const SEARCHTYPES = [
  'contains', 'notcontains', 'equals', 'notequals', 'lessthan', 'morethan', 'under', 'notunder', 'empty', 'notempty',
] as const;

const criteriaSchema = z
  .array(
    z
      .object({
        field: z.union([z.number().int(), z.string().min(1)]).describe('Search-option id, uid, column or label'),
        searchtype: z.enum(SEARCHTYPES).describe('under/notunder: tree descendants'),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Omit for empty/notempty'),
        link: z.enum(['AND', 'OR', 'AND NOT', 'OR NOT']).optional().describe('With the previous one (default AND)'),
      })
      .strict()
  )
  .optional()
  .describe('See instructions');

const itemtypeArg = z.string().min(1).describe('GLPI itemtype, case-sensitive');

/**
 * glpi_count validates the same criteria but lists them once, on
 * glpi_search_v2 (`describe` makes a distinct schema instance to tag).
 */
const countCriteriaSchema = advertisedAs(criteriaSchema.describe('As in glpi_search_v2'), {
  type: 'array',
  items: { type: 'object' },
  description: 'As in glpi_search_v2',
});

function toCriteriaArgs(criteria: z.infer<typeof criteriaSchema>): CriteriaArg[] {
  return (criteria ?? []).map((c) => ({ ...c, value: c.value ?? '' }));
}

const searchV2 = defineTool({
  name: 'glpi_search_v2',
  title: 'Search any itemtype',
  toolset: 'core',
  description:
    'Search any itemtype with criteria; rows have readable keys. For tickets prefer glpi_search_tickets.',
  inputSchema: {
    itemtype: itemtypeArg,
    criteria: criteriaSchema,
    forcedisplay: z.array(z.number().int()).optional().describe('Extra columns, search-option ids'),
    ...searchPageShape,
    expand_dropdowns: expandDropdowns,
    is_deleted: isDeleted,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const criteria = await resolveCriteria(client, a.itemtype, toCriteriaArgs(a.criteria));
    const result = await client.search.search<Record<string, unknown>>(a.itemtype, {
      criteria,
      forcedisplay: a.forcedisplay,
      start: a.start ?? 0,
      limit: pageLimit(a.limit),
      sort: await resolveSearchSort(client, a.itemtype, a.sort),
      order: a.order,
      fetchAll: a.fetch_all,
      maxRows: a.max_rows,
      expandDropdowns: a.expand_dropdowns !== false,
      isDeleted: a.is_deleted,
    });
    return text(searchEnvelope(a.itemtype, result, a));
  },
});

const count = defineTool({
  name: 'glpi_count',
  title: 'Count items',
  toolset: 'core',
  description: 'Count the items matching criteria, without rows.',
  inputSchema: {
    itemtype: itemtypeArg,
    criteria: countCriteriaSchema,
  },
  handler: async ({ client }, a) => {
    const criteria = await resolveCriteria(client, a.itemtype, toCriteriaArgs(a.criteria));
    return text({ itemtype: a.itemtype, totalcount: await client.search.count(a.itemtype, criteria) });
  },
});

const listSearchOptions = defineTool({
  name: 'glpi_list_search_options',
  title: 'List search options',
  toolset: 'core',
  description: 'Searchable fields of an itemtype (id, uid, column, datatype, searchtypes) to build criteria.',
  inputSchema: {
    itemtype: itemtypeArg,
    query: optStr('Filter on name, uid or column'),
  },
  handler: async ({ client }, a) => {
    const cat = await client.searchOptions.get(a.itemtype);
    const needle = a.query?.toLowerCase();
    const options = Array.from(cat.byId.values())
      .filter((o) => !needle || [o.name, o.uid, o.field].some((s) => s?.toLowerCase().includes(needle)))
      .map((o) => ({
        id: o.id,
        name: o.name,
        uid: o.uid,
        field: o.field,
        datatype: o.datatype,
        searchtypes: o.available_searchtypes,
      }));
    return text({ itemtype: a.itemtype, count: options.length, options });
  },
});

const searchKnowbase = defineTool({
  name: 'glpi_search_knowbase',
  title: 'Search knowledge base',
  toolset: 'kb',
  description: 'Find knowledge base articles by title. Read one with glpi_get_item, itemtype KnowbaseItem.',
  inputSchema: {
    query: z.string().min(1).describe('Text in the title'),
    ...pageShape,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const fieldId = (await client.searchOptions.resolveField('KnowbaseItem', 'name').catch(() => undefined)) ?? 6;
    const result = await client.search.search<Record<string, unknown>>('KnowbaseItem', {
      criteria: [{ field: fieldId, searchtype: 'contains', value: a.query }],
      start: a.start ?? 0,
      limit: pageLimit(a.limit),
      expandDropdowns: true,
    });
    return text(searchEnvelope('KnowbaseItem', result, a));
  },
});

const createKnowbaseItem = defineTool({
  name: 'glpi_create_knowbase_item',
  title: 'Create KB article',
  toolset: 'kb',
  description: 'Create a knowledge base article and return its id.',
  inputSchema: {
    name: z.string().min(1).describe('Title'),
    answer: z.string().min(1).describe('Body, text or HTML'),
    is_faq: optBool(),
    knowbaseitemcategories_id: z.number().int().min(0).optional(),
  },
  handler: async ({ client }, a) => {
    const result = await client.createKnowbaseItem({
      name: a.name,
      answer: a.answer,
      is_faq: a.is_faq ? 1 : 0,
      knowbaseitemcategories_id: a.knowbaseitemcategories_id,
    });
    return text({ success: true, ...result });
  },
});

export const SEARCH_TOOLS: ToolDef[] = [searchV2, count, listSearchOptions, searchKnowbase, createKnowbaseItem];
