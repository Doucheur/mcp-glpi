/**
 * Schema building blocks and small helpers shared by the tool modules.
 */

import { z } from 'zod';
import type { ListOptions } from '../glpi-client.js';
import { DEFAULT_LIST_LIMIT, pageLimit } from '../output.js';

/** Numeric strings ("12") are accepted for numbers, as in v3. */
const numericString = (v: unknown) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v);

/** Required positive integer id. */
export const id = (description: string) => z.preprocess(numericString, z.number().int().positive()).describe(description);

/** Optional id where 0 is meaningful (root entity, "no category"). */
export const optId = (description: string) =>
  z.preprocess(numericString, z.number().int().nonnegative()).optional().describe(description);

export const optInt = (description: string) => z.preprocess(numericString, z.number().int()).optional().describe(description);

export const optBool = (description: string) => z.boolean().optional().describe(description);
export const optStr = (description: string) => z.string().optional().describe(description);

export const STATUS_TICKET_DESC = 'Ticket status: 1 New, 2 Processing (assigned), 3 Processing (planned), 4 Pending, 5 Solved, 6 Closed';
export const STATUS_PROBLEM_DESC =
  'Problem status: 1 New, 2 Processing (assigned), 3 Processing (planned), 4 Pending, 5 Solved, 6 Closed, 7 Accepted, 8 Under observation';
export const STATUS_CHANGE_DESC =
  'Change status: 1 New, 9 Evaluation, 10 Approval, 7 Accepted, 4 Pending, 11 Testing, 12 Qualification, 5 Applied, 8 Review, 6 Closed, 13 Refused, 14 Cancelled';
export const URGENCY_DESC = '1 Very low, 2 Low, 3 Medium, 4 High, 5 Very high';
export const PRIORITY_DESC = '1 Very low, 2 Low, 3 Medium, 4 High, 5 Very high, 6 Major';
export const DATE_DESC = "'YYYY-MM-DD HH:MM:SS' (or 'YYYY-MM-DD'), GLPI server time";

export const itilItemtype = z
  .enum(['Ticket', 'Change', 'Problem'])
  .optional()
  .describe('ITIL object type (default Ticket). Ids are per itemtype.');

/** max_content_chars / raw_html. */
export const textShape = {
  max_content_chars: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Max chars per text field (default 2000, 0 = no cap)'),
  raw_html: optBool('Keep stored HTML (no conversion, no cap)'),
};

export const orderSchema = z.enum(['ASC', 'DESC']).optional().describe('Sort direction');

/** Paging/sorting arguments of the GET /{itemtype} list tools. */
export const listShape = {
  start: z.number().int().min(0).optional().describe('Offset (default 0); next page: next_start'),
  limit: z.number().int().min(1).optional().describe(`Rows per page (default ${DEFAULT_LIST_LIMIT}, max 500)`),
  range: optStr('Legacy "START-END", overrides start/limit'),
  sort: z
    .union([z.string().min(1), z.number().int().min(1)])
    .optional()
    .describe('Own column ("date_mod", "name"...) or its search-option id'),
  order: orderSchema,
  expand_dropdowns: optBool('Labels instead of ids (default true)'),
  is_deleted: optBool('true = list ONLY trashed rows'),
};

export interface ListArgs {
  start?: number;
  limit?: number;
  range?: string;
  sort?: string | number;
  order?: 'ASC' | 'DESC';
  expand_dropdowns?: boolean;
  is_deleted?: boolean;
}

/** start/limit (or legacy range) -> ListOptions + the effective start. */
export function toListOptions(args: ListArgs, defaultOrder?: 'ASC' | 'DESC'): { opts: ListOptions; start: number; limit: number } {
  let start = args.start ?? 0;
  let limit = pageLimit(args.limit);
  const m = args.range?.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (m) {
    start = parseInt(m[1], 10);
    limit = pageLimit(Math.max(1, parseInt(m[2], 10) - start + 1));
  }
  const opts: ListOptions = {
    range: `${start}-${start + limit - 1}`,
    expand_dropdowns: args.expand_dropdowns !== false,
  };
  if (args.sort !== undefined) opts.sort = args.sort;
  if (args.order ?? defaultOrder) opts.order = args.order ?? defaultOrder;
  if (args.is_deleted !== undefined) opts.is_deleted = args.is_deleted;
  return { opts, start, limit };
}

/** "10-29" -> { start: 10, limit: 20 } for alias mappers. */
export function rangeArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.range !== 'string') return args;
  const m = args.range.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return args;
  const { range: _range, ...rest } = args;
  const start = parseInt(m[1], 10);
  return { ...rest, start, limit: Math.max(1, parseInt(m[2], 10) - start + 1) };
}

/** Copy without undefined values. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Booleans to GLPI's 0/1. */
export function bool01(v: unknown): unknown {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}
