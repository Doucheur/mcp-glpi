/**
 * Reporting: ticket counts by dimension, asset totals.
 */

import { z } from 'zod';
import type { SearchCriterion } from '../search.js';
import { TICKET_STATUS } from '../itil.js';
import { text } from '../output.js';
import { TICKET_FIELDS, monthBuckets, monthCriteria, ticketField } from '../tool-helpers.js';
import { defineTool, type ToolDef } from './registry.js';
import { DATE_DESC, optId, optStr } from './common.js';

const ticketsStatsBy = defineTool({
  name: 'glpi_tickets_stats_by',
  title: 'Ticket statistics',
  toolset: 'stats',
  description:
    'Ticket counts broken down by status (default), category, technician, entity or month, optionally for an entity and an opening-date period. ' +
    'dimension=month covers date_from..date_to (default the last 6 months, max 36).',
  inputSchema: {
    dimension: z
      .enum(['status', 'category', 'technician', 'entity', 'month'])
      .optional()
      .describe('Breakdown (default status)'),
    date_from: optStr(`Opened after, ${DATE_DESC}`),
    date_to: optStr(`Opened before, ${DATE_DESC}`),
    entity_id: optId('Entity id (0 = root entity)'),
  },
  handler: async ({ client }, a) => {
    const dimension = a.dimension ?? 'status';
    const base: SearchCriterion[] = [];
    if (a.entity_id !== undefined) base.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: a.entity_id });
    if (a.date_from) base.push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: a.date_from });
    if (a.date_to) base.push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: a.date_to });
    const withBase = (first: SearchCriterion): SearchCriterion[] => [first, ...base.map((b) => ({ ...b, link: 'AND' as const }))];

    const counts: Record<string, number> = {};
    if (dimension === 'status') {
      for (const [statusId, label] of Object.entries(TICKET_STATUS)) {
        counts[label] = await client.search.count(
          'Ticket',
          withBase({ field: TICKET_FIELDS.status, searchtype: 'equals', value: Number(statusId) })
        );
      }
    } else if (dimension === 'category') {
      const cats = await client.getCategories({ range: '0-199' });
      for (const cat of cats) {
        const n = await client.search.count('Ticket', withBase({ field: TICKET_FIELDS.category, searchtype: 'equals', value: cat.id }));
        if (n > 0) counts[cat.completename ?? cat.name] = n;
      }
    } else if (dimension === 'technician') {
      const users = await client.getUsers({ range: '0-199', is_active: true });
      for (const u of users) {
        const n = await client.search.count('Ticket', withBase({ field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: u.id }));
        if (n > 0) counts[`${u.firstname ?? ''} ${u.realname ?? ''} (${u.name})`.trim()] = n;
      }
    } else if (dimension === 'entity') {
      const entities = await client.getEntities({ range: '0-99' });
      for (const e of entities) {
        const n = await client.search.count('Ticket', withBase({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: e.id }));
        if (n > 0) counts[e.completename ?? e.name] = n;
      }
    } else {
      const buckets = monthBuckets(a.date_from, a.date_to);
      const dateField = await ticketField(client, 'date');
      for (const bucket of buckets) {
        const c = monthCriteria(bucket, dateField);
        if (a.entity_id !== undefined) {
          c.push({ field: await ticketField(client, 'entity'), searchtype: 'equals', value: a.entity_id, link: 'AND' });
        }
        counts[bucket.key] = await client.search.count('Ticket', c);
      }
    }
    return text({ dimension, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) });
  },
});

const assetStats = defineTool({
  name: 'glpi_get_asset_stats',
  title: 'Asset statistics',
  toolset: 'stats',
  description: 'Number of computers, monitors, printers, network equipments, phones and software in the active entities.',
  inputSchema: {},
  handler: async ({ client }) => {
    const stats = await client.getAssetStats();
    return text({
      ...stats,
      total: stats.computers + stats.monitors + stats.printers + stats.networkEquipments + stats.phones,
    });
  },
});

export const STATS_TOOLS: ToolDef[] = [ticketsStatsBy, assetStats];
