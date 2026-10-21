/**
 * Generic search (search/{itemtype}), counts, the search-option catalogue,
 * and the knowledge base.
 */

import { z } from 'zod';
import { pageLimit, text } from '../output.js';
import { type CriteriaArg, resolveCriteria } from '../tool-helpers.js';
import { defineTool, type ToolDef } from './registry.js';
import { optBool, optStr, orderSchema, textShape } from './common.js';
import { resolveSearchSort, searchEnvelope } from './search-rows.js';

const SEARCHTYPES = [
  'contains', 'notcontains', 'equals', 'notequals', 'lessthan', 'morethan', 'under', 'notunder', 'empty', 'notempty',
] as const;

const criteriaSchema = z
  .array(
    z
      .object({
        field: z
          .union([z.number().int(), z.string().min(1)])
          .describe('Search option id, or its uid/column/label (see glpi_list_search_options)'),
        searchtype: z.enum(SEARCHTYPES).describe('Comparison; under/notunder = tree descendants (entities, categories)'),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Value to compare (omit for empty/notempty)'),
        link: z.enum(['AND', 'OR', 'AND NOT', 'OR NOT']).optional().describe('Operator with the previous criterion (default AND)'),
      })
      .strict()
  )
  .optional()
  .describe('Criteria combined in order');

const itemtypeArg = z
  .string()
  .min(1)
  .describe('GLPI itemtype, case-sensitive (Ticket, Computer, User, NetworkEquipment, KnowbaseItem...)');

function toCriteriaArgs(criteria: z.infer<typeof criteriaSchema>): CriteriaArg[] {
  return (criteria ?? []).map((c) => ({ ...c, value: c.value ?? '' }));
}

const searchV2 = defineTool({
  name: 'glpi_search_v2',
  title: 'Search any itemtype',
  toolset: 'search',
  description:
    'Multi-criteria search on any itemtype. Rows have readable keys. Returns {totalcount,start,count,next_start,items}. ' +
    'Example: {"itemtype":"Computer","criteria":[{"field":"name","searchtype":"contains","value":"PC-"},' +
    '{"link":"AND","field":"Computer.Location.completename","searchtype":"contains","value":"Paris"}],"limit":10}. ' +
    'For tickets prefer glpi_search_tickets.',
  inputSchema: {
    itemtype: itemtypeArg,
    criteria: criteriaSchema,
    forcedisplay: z.array(z.number().int()).optional().describe('Extra columns to return (search option ids)'),
    start: z.number().int().min(0).optional().describe('First row (default 0)'),
    limit: z.number().int().min(1).optional().describe('Rows per page (default 25, max 500)'),
    sort: z.union([z.number().int().min(1), z.string().min(1)]).optional().describe('Search option id or name to sort on'),
    order: orderSchema,
    fetch_all: optBool('Follow pages until totalcount, capped by max_rows'),
    max_rows: z.number().int().min(1).optional().describe('Cap for fetch_all (default 1000)'),
    expand_dropdowns: optBool('Dropdown labels instead of ids (default true)'),
    is_deleted: optBool('true = search ONLY trashed rows'),
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
  toolset: 'search',
  description:
    'Number of items matching criteria (cheap, no rows). ' +
    'Example: {"itemtype":"Ticket","criteria":[{"field":"status","searchtype":"lessthan","value":5}]} = open tickets.',
  inputSchema: {
    itemtype: itemtypeArg,
    criteria: criteriaSchema,
  },
  handler: async ({ client }, a) => {
    const criteria = await resolveCriteria(client, a.itemtype, toCriteriaArgs(a.criteria));
    return text({ itemtype: a.itemtype, totalcount: await client.search.count(a.itemtype, criteria) });
  },
});

const listSearchOptions = defineTool({
  name: 'glpi_list_search_options',
  title: 'List search options',
  toolset: 'search',
  description:
    'Searchable fields of an itemtype (id, name, uid, column, datatype, searchtypes), to build glpi_search_v2 / glpi_count criteria. ' +
    'Use query to filter.',
  inputSchema: {
    itemtype: itemtypeArg,
    query: optStr('Keep options whose name, uid or column contains this text (case-insensitive)'),
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
  description: 'Find KB articles whose title contains the text. Read one with glpi_get_item {itemtype:"KnowbaseItem", id}.',
  inputSchema: {
    query: z.string().min(1).describe('Text contained in the title'),
    start: z.number().int().min(0).optional().describe('First row (default 0)'),
    limit: z.number().int().min(1).optional().describe('Rows per page (default 25, max 500)'),
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
  description: 'Create a knowledge base article. Returns its id.',
  inputSchema: {
    name: z.string().min(1).describe('Title'),
    answer: z.string().min(1).describe('Article body (plain text or HTML)'),
    is_faq: optBool('Publish in the FAQ'),
    knowbaseitemcategories_id: z.number().int().min(0).optional().describe('KnowbaseItemCategory id'),
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
