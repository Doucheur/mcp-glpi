/**
 * Tool failures as `isError` results the model can read and act on.
 *
 * Text: `GLPI <METHOD> <path> -> <status> <code>: <message>` followed by a
 * hint for the GLPI error codes that have a known remedy.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiError, GlpiTimeoutError } from './http.js';

const RIGHTS_HINT =
  'Hint: the active GLPI profile lacks the right for this action (or the item is outside the active entities). ' +
  'Check glpi_get_session_info; glpi_set_active_profile / glpi_set_active_entity can switch.';

/** Hint line per GLPI error code. */
export const GLPI_ERROR_HINTS: Record<string, string> = {
  ERROR_SESSION_TOKEN_INVALID:
    'Hint: the GLPI session expired; the server re-authenticated and the retry failed. Check GLPI_USER_TOKEN / GLPI_APP_TOKEN.',
  ERROR_SESSION_TOKEN_MISSING:
    'Hint: no GLPI session could be opened. Check GLPI_USER_TOKEN (or GLPI_USERNAME/GLPI_PASSWORD) and GLPI_APP_TOKEN.',
  ERROR_RIGHT_MISSING: RIGHTS_HINT,
  ERROR_GLPI_ADD: RIGHTS_HINT + ' A missing mandatory field also gives this error.',
  ERROR_GLPI_UPDATE: RIGHTS_HINT + ' A read-only or unknown field also gives this error.',
  ERROR_GLPI_DELETE: RIGHTS_HINT,
  ERROR_GLPI_PURGE: RIGHTS_HINT,
  ERROR_ITEM_NOT_FOUND:
    'Hint: check the itemtype and the id. Ids are per itemtype: Ticket 12 and Change 12 are unrelated records.',
  ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM:
    'Hint: unknown itemtype. Itemtypes are case-sensitive GLPI class names (Ticket, Computer, NetworkEquipment, ITILCategory...).',
  ERROR_BAD_ARRAY:
    'Hint: the request body has the wrong shape. Check the field names and types of the arguments (see the tool schema).',
  ERROR_LOGIN_PARAMETERS_MISSING:
    'Hint: server configuration: set GLPI_USER_TOKEN, or GLPI_USERNAME + GLPI_PASSWORD.',
  ERROR_WRONG_APP_TOKEN_PARAMETER: 'Hint: server configuration: GLPI_APP_TOKEN is wrong for this GLPI API client.',
  ERROR_NOT_ALLOWED_IP: 'Hint: the GLPI API client does not allow the IP address of this server (Setup > General > API).',
};

const STATUS_HINTS: Record<number, string> = {
  400: 'Hint: GLPI rejected the arguments. Check the field names and value types.',
  401: GLPI_ERROR_HINTS.ERROR_SESSION_TOKEN_INVALID,
  403: RIGHTS_HINT,
  404: GLPI_ERROR_HINTS.ERROR_ITEM_NOT_FOUND,
};

/** "https://glpi/apirest.php/Ticket/5?expand_dropdowns=true" -> "Ticket/5". */
function apiPath(url: string): string {
  const noQuery = url.split('?')[0];
  const i = noQuery.indexOf('/apirest.php/');
  return i >= 0 ? noQuery.slice(i + '/apirest.php/'.length) : noQuery;
}

/** Human-readable error text with an optional hint line. */
export function describeError(err: unknown): string {
  if (err instanceof GlpiError) {
    const code = err.glpiCode ? ` ${err.glpiCode}` : '';
    const message = err.glpiMessage ?? (err.glpiCode ? '' : err.body.slice(0, 300));
    const head = `GLPI ${err.method} ${apiPath(err.url)} -> ${err.status}${code}${message ? `: ${message}` : ''}`;
    const hint = (err.glpiCode && GLPI_ERROR_HINTS[err.glpiCode]) ?? STATUS_HINTS[err.status];
    return hint ? `${head}\n${hint}` : head;
  }
  if (err instanceof GlpiTimeoutError) {
    return `${err.message}\nHint: GLPI did not answer in time. Retry, narrow the request, or raise GLPI_TIMEOUT_MS.`;
  }
  if (err instanceof TypeError && err.message === 'fetch failed') {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? 'network error';
    return `Cannot reach GLPI (${detail}).\nHint: check GLPI_URL and that the GLPI server is reachable from this machine.`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function toolError(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}
