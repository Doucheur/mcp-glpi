/**
 * Search results (`search/{itemtype}`) as list envelopes with readable rows.
 */

import { ArgumentError } from '../errors.js';
import type { GlpiClient } from '../glpi-client.js';
import type { SearchResponse } from '../search.js';
import { cleanTextFields, listEnvelope, type ListEnvelope, type TextOptions, withItilLabels } from '../output.js';

/** Rows keep the readable keys from search.ts, plus ITIL labels and plain-text content. */
export function searchEnvelope(
  itemtype: string,
  result: SearchResponse<Record<string, unknown>>,
  opts: TextOptions = {}
): ListEnvelope<Record<string, unknown>> {
  const items = result.data.map((row) => cleanTextFields(withItilLabels(itemtype, row), opts));
  return listEnvelope(items, result.start, result.totalcount);
}

/** A sort argument for search/: option id, or a name/uid/column resolved through the catalogue. */
export async function resolveSearchSort(
  client: GlpiClient,
  itemtype: string,
  sort: string | number | undefined
): Promise<number | undefined> {
  if (sort === undefined) return undefined;
  if (typeof sort === 'number') return sort;
  const resolved = await client.searchOptions.resolveField(itemtype, sort);
  if (resolved === undefined) {
    throw new ArgumentError(`sort: "${sort}" is not a search option of ${itemtype} (see glpi_list_search_options)`);
  }
  return resolved;
}
