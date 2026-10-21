/**
 * High-level search/count/fetch_all over GLPI's /search/{itemtype} endpoint.
 *
 * Features:
 *   - Multi-criteria with link operator (AND / OR / AND NOT / OR NOT).
 *   - forcedisplay (choose returned columns).
 *   - Reads totalcount + Content-Range header.
 *   - fetch_all: paginates until totalcount reached, capped by maxRows.
 *   - Optional sort + order.
 */

import { GlpiHttp } from './http.js';
import type { SearchOptionsCatalogue, SearchOptionsCache } from './search-options.js';

export type SearchType =
  | 'contains'
  | 'notcontains'
  | 'equals'
  | 'notequals'
  | 'lessthan'
  | 'morethan'
  | 'under'
  | 'notunder'
  | 'empty'
  | 'notempty';

export type SearchLink = 'AND' | 'OR' | 'AND NOT' | 'OR NOT';

export interface SearchCriterion {
  field: number;
  searchtype: SearchType;
  value: string | number | boolean;
  /** Combination operator with the previous criterion. Ignored on the first one. */
  link?: SearchLink;
}

export interface SearchOptions {
  criteria?: SearchCriterion[];
  /** field_id list to return; if undefined, GLPI uses its default. */
  forcedisplay?: number[];
  /** First row (0-indexed). */
  start?: number;
  /** Maximum rows for this single call. */
  limit?: number;
  /** Sort by field_id (search option id). */
  sort?: number;
  order?: 'ASC' | 'DESC';
  /** If true, paginate until totalcount is reached (or maxRows is hit). */
  fetchAll?: boolean;
  /** Safety cap when fetchAll=true (default 1000). */
  maxRows?: number;
  /** Pass `expand_dropdowns=true` for resolved labels. */
  expandDropdowns?: boolean;
  /** Pass `giveItems=true` to receive raw items. */
  giveItems?: boolean;
}

export interface SearchResponse<T = Record<string, unknown>> {
  itemtype: string;
  totalcount: number;
  count: number;
  start: number;
  data: T[];
  /** Raw Content-Range header value, if present. */
  contentRange?: string;
}

const DEFAULT_PAGE = 100;
const DEFAULT_MAX_ROWS = 1000;

/**
 * Short, readable key for a search option uid.
 *   own table  "Ticket.status"                    -> "status"
 *   joined     "Ticket.ITILCategory.completename"  -> "itilcategory_completename"
 *   joined     "Ticket.Ticket_User.User.name"      -> "user_name"
 */
export function shortKeyForUid(itemtype: string, uid: string): string {
  const parts = uid.split('.');
  if (parts.length === 2 && parts[0] === itemtype) return parts[1];
  if (parts.length < 2) return uid;
  return parts.slice(-2).join('_').toLowerCase();
}

/**
 * Build the key-renaming table for a set of row keys.
 *
 * Keys are either numeric option ids (GLPI's default) or option uids (when
 * `uid_cols` is set). Numeric keys are looked up in `byId`. When two keys
 * produce the same short key (e.g. requester and technician are both
 * "user_name"), every colliding key that is not an own-table column is
 * suffixed with its option id ("user_name_4", "user_name_5"). Unknown keys are
 * kept as they are.
 */
export function buildKeyMap(
  itemtype: string,
  keys: string[],
  catalogue: SearchOptionsCatalogue
): Map<string, string> {
  const resolved = keys.map((key) => {
    const option = /^\d+$/.test(key) ? catalogue.byId.get(parseInt(key, 10)) : catalogue.byUid.get(key);
    const uid = option?.uid ?? (/^\d+$/.test(key) ? undefined : key);
    if (key === 'id') return { key, short: 'id', own: true, optionId: undefined as number | undefined };
    if (!uid) {
      // Option without uid: fall back to its column name, else keep the key.
      return { key, short: option?.field ?? key, own: false, optionId: option?.id };
    }
    const parts = uid.split('.');
    const own = parts.length === 2 && parts[0] === itemtype;
    return { key, short: shortKeyForUid(itemtype, uid), own, optionId: option?.id };
  });

  const counts = new Map<string, number>();
  for (const r of resolved) counts.set(r.short, (counts.get(r.short) ?? 0) + 1);

  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const r of resolved) {
    let target = r.short;
    if ((counts.get(r.short) ?? 0) > 1 && !r.own) {
      target = `${r.short}_${r.optionId ?? r.key}`;
    }
    while (used.has(target)) target = `${target}_${r.optionId ?? r.key}`;
    used.add(target);
    map.set(r.key, target);
  }
  return map;
}

/** Rename the keys of search rows to readable short keys (see buildKeyMap). */
export function mapRowKeys<T = Record<string, unknown>>(
  itemtype: string,
  rows: unknown[],
  catalogue: SearchOptionsCatalogue
): T[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const k of Object.keys(row)) keys.add(k);
    }
  }
  if (keys.size === 0) return rows as T[];
  const keyMap = buildKeyMap(itemtype, [...keys], catalogue);
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[keyMap.get(k) ?? k] = v;
    return out as T;
  });
}

export class GlpiSearch {
  /**
   * @param searchOptions catalogue used to rename row keys (numeric option
   *   ids -> readable names). Without it rows are returned as GLPI sent them.
   */
  constructor(private http: GlpiHttp, private searchOptions?: SearchOptionsCache) {}

  /** Map row keys through the catalogue; falls back to raw rows if it cannot be read. */
  private async readableRows<T>(itemtype: string, rows: T[]): Promise<T[]> {
    if (!this.searchOptions || rows.length === 0) return rows;
    let catalogue: SearchOptionsCatalogue;
    try {
      catalogue = await this.searchOptions.get(itemtype);
    } catch (err) {
      if (process.env.GLPI_DEBUG) {
        console.error(`[glpi-search] listSearchOptions/${itemtype} failed, raw keys kept: ${err instanceof Error ? err.message : err}`);
      }
      return rows;
    }
    return mapRowKeys<T>(itemtype, rows, catalogue);
  }

  /**
   * Execute a search call (single page or fetch_all loop).
   */
  async search<T = Record<string, unknown>>(
    itemtype: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse<T>> {
    if (options.fetchAll) return this.fetchAll<T>(itemtype, options);

    const start = options.start ?? 0;
    const limit = options.limit ?? DEFAULT_PAGE;
    // GLPI ranges are inclusive: "0-4" returns 5 rows.
    return this.fetchPage<T>(itemtype, options, start, start + Math.max(1, limit) - 1);
  }

  /**
   * Return only totalcount for the given criteria. Cheap probe (range=0-0).
   */
  async count(
    itemtype: string,
    criteria: SearchCriterion[] = []
  ): Promise<number> {
    const res = await this.fetchPage(itemtype, { criteria }, 0, 0, false);
    return res.totalcount;
  }

  private async fetchPage<T>(
    itemtype: string,
    options: SearchOptions,
    start: number,
    end: number,
    mapKeys = true
  ): Promise<SearchResponse<T>> {
    // Note: `uid_cols=true` is deliberately NOT sent. GLPI then keys columns
    // by uid, and distinct options sharing a uid (Ticket requester 4 and
    // technician 5 are both "Ticket.Ticket_User.User.name") collapse into a
    // single key, losing data. Numeric keys are renamed via the catalogue.
    const params = new URLSearchParams();

    (options.criteria ?? []).forEach((c, i) => {
      params.append(`criteria[${i}][field]`, String(c.field));
      params.append(`criteria[${i}][searchtype]`, c.searchtype);
      params.append(`criteria[${i}][value]`, String(c.value));
      if (i > 0 && c.link) params.append(`criteria[${i}][link]`, c.link);
    });

    (options.forcedisplay ?? []).forEach((id, i) => {
      params.append(`forcedisplay[${i}]`, String(id));
    });

    params.append('range', `${start}-${end}`);
    if (options.sort !== undefined) params.append('sort', String(options.sort));
    if (options.order) params.append('order', options.order);
    if (options.expandDropdowns) params.append('expand_dropdowns', 'true');
    if (options.giveItems) params.append('giveItems', 'true');

    const { data, headers } = await this.http.request<{
      totalcount?: number;
      count?: number;
      data?: T[];
    }>(`search/${itemtype}`, { query: params });

    const contentRange = headers.get('content-range') ?? undefined;
    let totalcount = data.totalcount ?? 0;
    if (!totalcount && contentRange) {
      // Format: "start-end/total"
      const match = contentRange.match(/\/(\d+)$/);
      if (match) totalcount = parseInt(match[1], 10);
    }

    return {
      itemtype,
      totalcount,
      count: data.count ?? (data.data?.length ?? 0),
      start,
      data: mapKeys ? await this.readableRows<T>(itemtype, data.data ?? []) : data.data ?? [],
      contentRange,
    };
  }

  private async fetchAll<T>(
    itemtype: string,
    options: SearchOptions
  ): Promise<SearchResponse<T>> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const pageSize = options.limit ?? DEFAULT_PAGE;
    let cursor = options.start ?? 0;
    const collected: T[] = [];
    let totalcount = 0;
    let contentRange: string | undefined;

    while (collected.length < maxRows) {
      const remaining = maxRows - collected.length;
      const thisPage = Math.min(pageSize, remaining);
      const end = cursor + thisPage - 1;

      const page = await this.fetchPage<T>(itemtype, options, cursor, end);
      totalcount = page.totalcount;
      contentRange = page.contentRange;

      collected.push(...page.data);
      cursor += page.data.length;

      if (page.data.length === 0) break;
      if (totalcount && cursor >= totalcount) break;
    }

    return {
      itemtype,
      totalcount,
      count: collected.length,
      start: options.start ?? 0,
      data: collected,
      contentRange,
    };
  }
}
