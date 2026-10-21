# Changelog

## 4.0.0 (unreleased)

Stub with the facts for the release notes (rewritten in step 4).

### Breaking changes
- 46 listed tools instead of 87. The 50 removed names stay callable as hidden
  aliases (listed again with `GLPI_LEGACY_TOOLS=1`).
- Outputs are compact JSON. Lists return
  `{ totalcount, start, count, next_start, items }` (default limit 25, max 500;
  `range` still accepted). Detail tools return a compact projection
  (`verbose: true` for every field). HATEOAS `links` are gone
  (`get_hateoas=false`). Text fields (`content`, `answer`, `comment`...) are
  plain text capped at `max_content_chars` (default 2000; `raw_html: true`
  keeps the stored HTML). ITIL objects carry `status_label`,
  `urgency_label`, `priority_label`.
- Search rows: well-known Ticket options get friendly keys (`requester_name`,
  `technician_name`, `technician_group`, `requester_group`, `observer_name`,
  `observer_group`, `category`, `entity`, `status`, `priority`, `urgency`,
  `date`, `date_mod`, `solvedate`, `closedate`, `time_to_resolve`, `content`);
  Change/Problem get `category`, `entity`, `status`, `date`, `date_mod`.
- Arguments are validated strictly (unknown keys rejected, JSON-RPC
  InvalidParams). GLPI/runtime failures are `isError` results with a hint.
- `purge`/`force` on glpi_delete_ticket and glpi_delete_item needs
  `confirm_id` equal to `id` (the legacy glpi_delete_computer alias keeps
  the v3 behaviour). glpi_create_user has no `password` parameter.
- Open tickets (`open_only`, glpi_list_overdue_tickets, glpi://tickets/open)
  use status `notold`: `lessthan 5` matched Solved tickets.

### New
- glpi_list_items / glpi_get_item / glpi_create_item / glpi_update_item /
  glpi_delete_item over 24 itemtypes; glpi_set_ticket_status;
  glpi_find_user; glpi_set_active_entity; glpi_set_active_profile;
  `me` in glpi_get_session_info; `kinds` on glpi_get_ticket_timeline (adds
  attached documents); `itemtype` (Change/Problem) on glpi_add_followup /
  glpi_add_task / glpi_add_solution; `query` on glpi_list_search_options.
- `GLPI_TOOLSETS` (tickets, itil, assets, users, kb, search, stats, session,
  admin), `GLPI_READ_ONLY=1`, `GLPI_LEGACY_TOOLS=1`; HTTP mode warns when
  `GLPI_READ_ONLY` is unset. Server `instructions`.
- Smaller `tools/list`: 25.7k characters for the full catalogue (v3: 41.9k),
  12.5k with `GLPI_READ_ONLY=1`. Code tables (status, urgency, priority...),
  the date format and the paging/text rules are in the server
  `instructions`, sent once per session; parameter descriptions point there.
  Legacy parameters (`range`, `force`, `parent_id`/`child_id`/`link_type`)
  are still accepted but no longer listed. `npm run measure` prints the
  sizes.

### Alias table (v3 name -> v4 call)
| v3 tool | v4 tool and mapped arguments |
|---|---|
| glpi_list_tickets | glpi_search_tickets (range -> start/limit) |
| glpi_get_ticket_followups / _tasks / _solutions / _validations / _documents {ticket_id} | glpi_get_ticket_timeline {id, kinds:[followup / task / solution / validation / document]} |
| glpi_get_change_tasks {change_id} | glpi_get_ticket_timeline {itemtype:Change, id, kinds:[task]} |
| glpi_get_problem_tasks {problem_id} | glpi_get_ticket_timeline {itemtype:Problem, id, kinds:[task]} |
| glpi_list_{computers, softwares, network_equipments, printers, monitors, phones} | glpi_list_items {itemtype: Computer, Software, NetworkEquipment, Printer, Monitor, Phone} |
| glpi_get_{computer, software, network_equipment, printer, monitor, phone} {with_*} | glpi_get_item {itemtype, id, with:[...]} |
| glpi_create_computer, glpi_create_software | glpi_create_item {itemtype, input} |
| glpi_update_computer | glpi_update_item {itemtype:Computer, id, input} |
| glpi_delete_computer {force} | glpi_delete_item {itemtype:Computer, purge, confirm_id} |
| glpi_list_knowbase, glpi_get_knowbase_item | glpi_list_items / glpi_get_item {itemtype:KnowbaseItem} |
| glpi_list/get/create_contract(s), _supplier(s), _location(s) | glpi_list_items / glpi_get_item / glpi_create_item {itemtype: Contract, Supplier, Location} |
| glpi_list/get/create/update_project(s) | glpi_*_item {itemtype:Project} |
| glpi_list_groups, glpi_get_group, glpi_create_group | glpi_list_items / glpi_get_item / glpi_create_item {itemtype:Group} |
| glpi_list_categories | glpi_list_items {itemtype:ITILCategory} |
| glpi_list_entities, glpi_get_entity | glpi_list_items / glpi_get_item {itemtype:Entity} |
| glpi_list_documents, glpi_get_document | glpi_list_items / glpi_get_item {itemtype:Document} |
| glpi_search_user {name} | glpi_find_user {query:name, exact:true} |
| glpi_get_ticket_stats | glpi_tickets_stats_by {dimension:status} |
| glpi_search {itemtype, field, searchtype, value} | glpi_search_v2 {itemtype, criteria:[{field, searchtype, value}]} |

## 3.5.0 — 2026-10-21

Corrective release (to be folded into 4.0.0).

### Fixed — HTTP layer
- Writes are no longer replayed after an ambiguous failure: only GET is
  retried after a network error, a timeout or a 5xx; POST/PUT/DELETE are
  retried only after ECONNREFUSED / ENOTFOUND / EAI_AGAIN (request never
  sent). 429 is still retried for every method.
- Retry-After and exponential backoff are capped at 30 s, with ±20 % jitter;
  Retry-After also accepts an HTTP date.
- The response body is read inside the timeout window, so a stalled body
  aborts instead of hanging.
- `initSession` fails clearly when GLPI returns no `session_token`.
- Concurrent 401s: the session is dropped/refreshed only if it is still the
  token the failing request used.
- `killSession` uses the current token and never re-authenticates.
- New global in-flight limit (`GLPI_MAX_CONCURRENCY`, default 8).

### Fixed — search and data
- `search/{itemtype}` rows (glpi_search_v2, glpi_search_tickets,
  glpi_list_overdue_tickets, glpi_search, glpi_search_knowbase, resources)
  now use readable keys instead of numeric option ids: own column -> field
  name (`status`), joined column -> last two uid segments
  (`itilcategory_completename`), collisions suffixed with the option id
  (`user_name_4` requester, `user_name_5` technician). `uid_cols` is not
  used: GLPI merges requester and technician under one uid key.
- `SearchOptionsCache`: one in-flight fetch per itemtype, failures not
  cached, raw entries kept only with `GLPI_DEBUG`.
- `glpi_list_users` (active filter) returns the same shape as the plain list
  and honours sort/order; this also fixes `glpi_tickets_stats_by
  dimension=technician`, which read fields the search rows did not have.
- `glpi_search_user` matches the login exactly (including logins stored with
  trailing spaces) and errors when several accounts share it, instead of
  returning the first partial match.
- `glpi_list_tickets` with `status` filters server-side (it used to filter
  one page client-side and miss most matches).
- Resources `glpi://problems/open` (statuses 1,2,3,4,7,8) and
  `glpi://changes/pending` (1,2,3,4,7,9,10,11,12) use server-side status
  criteria, newest `date_mod` first, 50 rows (the old `status < 5` / `< 8`
  filters dropped Accepted/Observed problems and mis-classified changes).
- `glpi_tickets_stats_by dimension=month`: month boundaries in local time
  (UTC conversion shifted them by the timezone offset), tickets created at
  00:00:00 on the 1st are counted, at most 36 months.
- `glpi_list_overdue_tickets` compares with local time and resolves the
  `time_to_resolve` option dynamically (18 as fallback); `glpi_search_tickets`
  resolves its Ticket fields the same way.
- Criteria with an unknown field name are rejected with the 5 closest option
  names (they silently searched on field 0).
- Ticket priority labels use the priority scale (6 = Major), not urgency.
- `glpi_get_ticket` / `glpi_get_change` / `glpi_get_problem` counts use
  `range=0-0` + `Content-Range` instead of downloading every followup/task.

### Fixed — writes and validation
- `glpi_link_tickets`: GLPI `Ticket_Ticket` constants are 3 = SON_OF and
  4 = PARENT_OF with `tickets_id_1` as subject; v3 sent `link_type` 3
  ("parent") as SON_OF, inverting the relation. New arguments `ticket_id`,
  `other_ticket_id`, `relation` (`link`, `duplicate`, `child_of`,
  `parent_of`); legacy `parent_id` / `child_id` / `link_type` keep working
  (3 or 4 there mean "parent_id is the parent of child_id").
- `glpi_assign_ticket` with both `user_id` and `group_id` creates both links
  (the group was ignored) and returns both ids.
- Every tool checks its required arguments and id parameters (integers;
  required ids >= 1) before calling GLPI: a missing id is InvalidParams, not
  `PUT Problem/undefined`.
- Update tools reject unknown fields; `glpi_update_computer` no longer
  forwards arbitrary arguments.
- `glpi_set_validation_status` accepts `"2"` / `"3"`.
- `include_deleted` is rejected: it mapped to `is_deleted=1`, which lists
  ONLY deleted rows. `is_deleted` is documented as such.
- `glpi_search_tickets` uses its validated arguments.

### Security
- `glpi_upload_document` reads `file_path` only inside `GLPI_UPLOAD_DIR`
  (realpath, symlinks resolved; disabled when unset), max 20 MB. New inline
  alternative `content_base64` + `filename`.

### Other
- stdio: the server shuts down (kills the GLPI session, exits 0) when stdin
  ends or the transport closes.

## 3.4.0 — 2026-10-21

### Fixed (issue #9 — Change / Problem coverage)

- **Change and Problem tasks are now readable**: new `glpi_get_change_tasks`
  (`GET /Change/{id}/ChangeTask`) and `glpi_get_problem_tasks`
  (`GET /Problem/{id}/ProblemTask`). Previously only `TicketTask` was reachable,
  and passing a change id to `glpi_get_ticket_tasks` silently returned the
  tasks of the unrelated *ticket* with the same number. The ticket tool's
  description now says so.
- **`glpi_get_ticket_timeline` accepts `itemtype`** (`Ticket` default,
  `Change`, `Problem`): followups, tasks, solutions and validations are read
  from the right sub-resources (`ChangeTask`, `ChangeValidation`, ...;
  problems have no validation object in GLPI).
- `glpi_get_change` / `glpi_get_problem` now return `counts` of followups,
  tasks, solutions (and validations for changes), like `glpi_get_ticket`.
- **Change status labels were wrong**: the map assumed a 1..12 sequence, but
  GLPI uses `CommonITILObject` constants (Applied=5, Closed=6, Accepted=7,
  Review=8, Evaluation=9, Approval=10, Testing=11, Qualification=12,
  Refused=13, Cancelled=14). A solved change (5) was labelled "Pending".
- **Problem status labels**: 2 is "Processing (assigned)" (was "Accepted"),
  7 "Accepted" and 8 "Under observation" were missing.
- **`sort` on `glpi_list_*` returned HTTP 400** (`sort param is not a field of
  glpi_changes`): `GET /{itemtype}` sorts by column name, not by search-option
  id. `sort` now accepts a column name (`"date_mod"`) or a search-option id,
  which is resolved to its column through the SearchOptions catalogue (own
  table only; joined fields return a clear error). The zod schema also
  accepted only strings while the JSON schema advertised numbers, so numeric
  sorts on `glpi_list_tickets` failed validation.
- Status labels and ITIL itemtype helpers moved to `src/itil.ts` and are unit
  tested (`test/itil.test.ts`).

### Added

- **Streamable HTTP transport** (`MCP_TRANSPORT=http`, or `--http`): the
  server can now serve MCP over HTTP at `http://<host>:<port>/mcp` (JSON-RPC,
  stateless, JSON responses) in addition to stdio. This is the only transport
  Open WebUI supports ("MCP (Streamable HTTP)" under Admin Settings → External
  Tools), so `mcp-glpi` can now be attached to it directly. The endpoint also
  answers `GET /health` for liveness probes. stdio stays the default, so
  existing Claude Desktop / Claude Code configs are unaffected.
- CLI flags: `--http`, `--transport <stdio|http>`, `--host`, `--port`
  (`0` picks a free port), `--path`, `--help`.
- HTTP environment variables: `MCP_HTTP_HOST` (default `127.0.0.1`),
  `MCP_HTTP_PORT` (falls back to `PORT`), `MCP_HTTP_PATH` (default `/mcp`),
  `MCP_HTTP_AUTH_TOKEN` (optional `Authorization: Bearer` requirement),
  `MCP_HTTP_ALLOWED_HOSTS` (Host-header allowlist).
- Tests: `test/http-server.test.ts` covers transport configuration, the
  JSON-RPC endpoint (initialize / tools/list / tools/call), HTTP edge cases
  (405 on GET/DELETE, 404, malformed and oversize bodies), bearer auth and
  Host-header validation.

### Fixed

- Concurrent requests no longer open duplicate GLPI sessions: `initSession()`
  is now single-flight, so parallel calls share one session instead of each
  opening — and leaking — their own. Matters as soon as several HTTP clients
  (or one client issuing parallel tool calls) hit the server at once.

### Changed

- The MCP `serverInfo` version now reports the package version instead of the
  stale hard-coded `3.0.0`.

## 3.3.0 — 2026-08-05

### Added

- **`glpi_upload_document`**: upload a local file as a GLPI Document via
  multipart `POST /Document` (`uploadManifest` + `filename[0]`), with an
  optional `ticket_id` that links the document to the ticket in the same
  call. The link is declared inside the manifest (`itemtype`/`items_id`) so
  it also works for restricted profiles (e.g. Self-Service requesters) that
  cannot `POST Document_Item` directly. MIME type is derived from the file
  extension.
- `form` option in the HTTP layer (`GlpiHttp.request`) for multipart bodies:
  the JSON `Content-Type` is omitted so `fetch` can set the boundary. Note
  the manifest must be appended as a plain string field — parts carrying a
  filename land in PHP's `$_FILES` and GLPI reads the manifest from `$_POST`.
- Tests: multipart header handling, manifest/file pair building, manifest
  item linking, and default document naming (`test/upload.test.ts`).

## 3.2.0 — 2026-07-04

### Added

- **MCP tool safety annotations** on all 84 tools (fixes #3, AgentSeal findings):
  - `readOnlyHint: true` on every list/get/search/count/stats tool (56 tools).
  - `destructiveHint: true` on delete/update/set/assign tools (9 tools) —
    agents now get an explicit signal before invoking `glpi_delete_ticket`,
    `glpi_delete_computer`, `glpi_update_*`, etc.
  - `idempotentHint` and `openWorldHint: false` everywhere (tools only reach
    the configured GLPI instance).
  - Annotations are derived from the tool name, so future tools are
    annotated automatically.
- **Live smoke test** (`npm run smoke`, `npm run smoke -- --write`):
  23 checks against a real instance — session, SearchOptions cache, field
  resolution, count/search/stats, timeline, users/computers/groups/entities,
  and an optional write cycle (create test ticket → followup → rename →
  soft delete → verify trash). Reads credentials from env or `.env`
  (gitignored). Validated against GLPI 11 (French locale).

### Fixed

- **Search off-by-one**: `search()` passed `limit` as the range end, but GLPI
  ranges are inclusive — `limit: 5` returned 6 rows. Affected `glpi_search_v2`,
  `glpi_search_tickets`, `glpi_count`-adjacent paths and the active-users
  filter. Found by the live smoke test.
- **`resolveField` failed on localized instances**: friendly-name resolution
  only matched the translated label ("Statut" on a French GLPI), so
  `resolveField('Ticket', 'status')` returned undefined. Resolution now tries,
  in order: explicit uid → canonical own-table uid (`Ticket.status`) →
  localized label → raw SQL column name, with own-table priority on column
  collisions (e.g. `name` exists on both glpi_tickets and joined glpi_users).

## 3.1.0 — 2026-07-04

Reliability hardening after the v3.0.0 audit.

### Added

- **Request timeouts**: every HTTP call (including `initSession`) is wrapped in
  an `AbortController` with a configurable timeout (`GLPI_TIMEOUT_MS`, default
  15 s). A hung GLPI backend can no longer block the MCP server indefinitely.
- **Retry on `429` and network errors**: rate-limited responses honour the
  `Retry-After` header; transient network failures (ECONNRESET, timeouts) are
  retried with the same exponential backoff as `5xx`.
- **Runtime input validation (zod)** on ticket tools (`glpi_list_tickets`,
  `glpi_get_ticket`, `glpi_search_tickets`): invalid arguments now return a
  clear `InvalidParams` MCP error instead of failing downstream in GLPI.
- **Differentiated MCP errors**: zod validation → `InvalidParams`;
  `GlpiError` → message with HTTP status + GLPI code; everything else →
  `InternalError`.
- **Config validation at startup**: `GLPI_URL` must be a valid URL and an
  authentication method must be configured — fail fast with a clear message.
- **Debug logging** (`GLPI_DEBUG=1`): retries, re-authentication and
  rate-limiting events are logged to stderr (stdout stays reserved for the MCP
  stdio transport).
- **Resilient startup**: if GLPI is unreachable when the server starts, a
  warning is logged and the session is established lazily on the first request
  (previously the server exited immediately).
- New env vars: `GLPI_TIMEOUT_MS`, `GLPI_MAX_RETRIES`, `GLPI_DEBUG`.
- 3 new HTTP-layer tests (timeout abort, 429 retry, network-error retry) — 7 total.

## 3.0.0 — 2026-06-08

Major overhaul focused on the foundations and on ITSM/reporting coverage.

### Added

- **Unified HTTP layer** (`src/http.ts`) with:
  - Automatic re-authentication on `401` (expired `session_token`).
  - Exponential-backoff retry on `5xx`.
  - Structured `GlpiError` exposing HTTP status + GLPI error code/message + body.
- **Multi-criteria search** via the new high-level `GlpiSearch` (`src/search.ts`):
  - Array of criteria with `link` operator (`AND` / `OR` / `AND NOT` / `OR NOT`).
  - `forcedisplay` to choose returned columns.
  - Pagination via `start`/`limit`, `fetch_all` with `max_rows` safety cap (default 1000).
  - Reads `totalcount` and `Content-Range` header.
- **`SearchOptionsCache`** (`src/search-options.ts`): caches
  `/listSearchOptions/{itemtype}` (TTL 1h) so high-level tools translate
  friendly names ↔ `field_id` resilient to GLPI version drift.
- **New MCP tools**:
  - `glpi_count` — cheap totalcount probe (range=0-0) with criteria.
  - `glpi_search_v2` — multi-criteria search; `glpi_search` kept as deprecated alias.
  - `glpi_list_search_options` — discover field ids of an itemtype.
  - `glpi_search_tickets` — friendly params (status, assigned_user/group,
    requester, category, entity, priority, urgency, date_from/to, text_search,
    open_only) translated to criteria internally.
  - `glpi_get_ticket_timeline` — merged followups + tasks + solutions +
    validations, sorted chronologically.
  - `glpi_tickets_stats_by(dimension, period)` — counts ventilated by
    status / category / technician / entity / month.
  - `glpi_link_tickets` — Ticket_Ticket relations (link / duplicate / parent).
  - `glpi_add_ticket_validation`, `glpi_set_validation_status`,
    `glpi_get_ticket_validations`.
  - `glpi_attach_document_to_ticket`, `glpi_get_ticket_documents`.
  - `glpi_get_ticket_satisfaction`, `glpi_list_overdue_tickets`.
  - `glpi_get_ticket_solutions`.
  - Symmetric `update`/`delete` on Monitor, Phone, Printer, Software,
    NetworkEquipment (parity with Computer).
- **`expand_dropdowns=true` by default** on all detail reads — foreign-key IDs
  come back resolved (technician name, category label, entity, etc.) while raw
  IDs remain available alongside.
- **Tests**: minimal integration tests using `node --test` + `tsx` (HTTP layer,
  re-auth, retry, error parsing).

### Fixed

- **F9** — Ticket and asset stats no longer fetch up to 9999 rows just to count
  them: they now use criteria + `range=0-0` totalcount probes. Accurate beyond
  10 k tickets, much faster.
- **F10** — `glpi_list_users` `active_only` filter previously used `searchText`
  (LIKE on a label column), which silently mismatched. Now uses the search
  endpoint with `criteria=is_active equals 1`.
- **F12** — `glpi_assign_ticket` ignored `group_id`. It now routes to
  `Group_Ticket` when a group is provided, and `Ticket_User` for a user.
- `glpi_search_knowbase` no longer hard-codes `field=6` for the title; the
  field id is resolved via `listSearchOptions/KnowbaseItem`.

### Changed (breaking)

- **`GlpiClient` constructor**: same shape (`GlpiConfig`) but the internal
  fetch/session/error layer is now `GlpiHttp`. Public domain methods keep
  their v2 names; their behaviour is hardened (see Fixed).
- **`glpi_list_*` tools**: now accept `start`, `range`, `sort`, `order`,
  `expand_dropdowns`. The previous `limit`-only form still works.
- **`glpi_search`**: marked deprecated. Prefer `glpi_search_v2`.
- **Build target**: `strict` TypeScript already, with `tsx` instead of
  `jest`/`ts-node` for test execution.

### Removed

- `eslint` was referenced in `package.json` scripts but never installed; the
  unused script is removed to avoid confusion. Linting can be reintroduced
  alongside tests if needed.
