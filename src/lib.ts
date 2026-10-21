/**
 * Library entry point (`main` / `exports` of the package).
 *
 * Importing this module has no side effects: it does not read the
 * environment, open a GLPI session or start a transport. The CLI lives in
 * `index.ts` (the `mcp-glpi` bin).
 */

export { GlpiClient } from './glpi-client.js';
export type { GlpiConfig, ListOptions, GetOptions, TicketRelation, ItilTaskOptions } from './glpi-client.js';
export { TICKET_LINK_TYPES } from './glpi-client.js';

export { GlpiHttp, GlpiError, GlpiTimeoutError } from './http.js';
export type { GlpiHttpConfig, GlpiRawError, RequestOptions, RequestResult } from './http.js';

export { GlpiSearch } from './search.js';
export type { SearchCriterion, SearchLink, SearchOptions, SearchResponse, SearchType } from './search.js';
export { SearchOptionsCache } from './search-options.js';
export type { SearchOption, SearchOptionsCatalogue } from './search-options.js';

export {
  SERVER_VERSION,
  INSTRUCTIONS,
  ALL_TOOLS,
  ALL_ALIASES,
  createMcpServer,
  parseServerOptions,
} from './server.js';
export type { CreateMcpServerOptions, ServerOptions } from './server.js';

export { describeError, toolError } from './errors.js';

export {
  ITIL_ITEMTYPES,
  isItilItemtype,
  TICKET_STATUS,
  PROBLEM_STATUS,
  CHANGE_STATUS,
  VALIDATION_STATUS,
  TICKET_URGENCY,
  TICKET_PRIORITY,
  STATUS_BY_ITEMTYPE,
} from './itil.js';
export type { ItilItemtype } from './itil.js';

export {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  DEFAULT_MAX_CONTENT_CHARS,
  text,
  decodeEntities,
  htmlToText,
  truncateText,
  cleanText,
  cleanTextFields,
  stripLinks,
  listEnvelope,
  pageLimit,
  withItilLabels,
  compactItem,
} from './output.js';
export type { ListEnvelope, TextOptions, CompactOptions } from './output.js';
