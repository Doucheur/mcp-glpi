# MCP Server for GLPI v3

A Model Context Protocol (MCP) server that exposes GLPI (IT Service
Management) to AI assistants like Claude.

v3 is a foundations-and-coverage overhaul on top of v2. See
[CHANGELOG.md](./CHANGELOG.md) for the full list of changes; the rest of this
README documents what's exposed today.

## What's in v3

- **Two transports**: stdio for desktop clients (Claude Desktop, Claude Code)
  and a stateless Streamable HTTP endpoint for web clients such as Open WebUI.
- **Solid foundations**: unified HTTP layer with auto re-authentication on 401,
  structured errors, retry on 5xx.
- **Real search**: multi-criteria with `AND` / `OR` / `AND NOT` / `OR NOT`,
  `forcedisplay`, pagination, `fetch_all`, dedicated count probe.
- **Dynamic field mapping**: `/listSearchOptions/{itemtype}` is cached so
  `field_id` ↔ name translations stay valid across GLPI versions.
- **High-level reporting**: `glpi_search_tickets` accepts friendly params,
  `glpi_tickets_stats_by` ventilates counts by status / category / technician /
  entity / month.
- **Full ITIL coverage**: timeline (followups + tasks + solutions +
  validations), validations request/approve, ticket linking, document
  attachment, satisfaction, overdue (SLA) tickets.
- **Resolved foreign keys by default**: detail views return `users_id_tech: 42`
  *and* the resolved name, so the LLM doesn't have to guess.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `GLPI_URL` | yes | Base URL of the GLPI instance |
| `GLPI_APP_TOKEN` | no | Application token (Setup → General → API) |
| `GLPI_USER_TOKEN` | no\* | User API token |
| `GLPI_USERNAME` | no\* | Login (when not using user token) |
| `GLPI_PASSWORD` | no\* | Password (when not using user token) |
| `GLPI_TIMEOUT_MS` | no | HTTP request timeout in ms (default `15000`) |
| `GLPI_MAX_RETRIES` | no | Max retries on 5xx / 429 / network errors (default `2`) |
| `GLPI_DEBUG` | no | Set to any value to log HTTP retries/re-auth to stderr |
| `GLPI_UPLOAD_DIR` | no | Directory `glpi_upload_document` may read `file_path` from (symlinks resolved). Unset = uploads by path are disabled; `content_base64` still works |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` |
| `MCP_HTTP_HOST` | no | HTTP bind address (default `127.0.0.1`) |
| `MCP_HTTP_PORT` | no | HTTP port (default `3000`; falls back to `PORT`) |
| `MCP_HTTP_PATH` | no | HTTP endpoint path (default `/mcp`) |
| `MCP_HTTP_AUTH_TOKEN` | no | When set, requests must send `Authorization: Bearer <token>` |
| `MCP_HTTP_ALLOWED_HOSTS` | no | Comma-separated `Host` header allowlist |

\* either `GLPI_USER_TOKEN` or `GLPI_USERNAME`+`GLPI_PASSWORD` is required.
The `MCP_*` variables only apply to the HTTP transport.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "glpi": {
      "command": "npx",
      "args": ["mcp-glpi"],
      "env": {
        "GLPI_URL": "https://glpi.example.com",
        "GLPI_APP_TOKEN": "...",
        "GLPI_USER_TOKEN": "..."
      }
    }
  }
}
```

### Streamable HTTP (Open WebUI and other web clients)

Stdio is the default. To serve MCP over HTTP instead:

```bash
MCP_TRANSPORT=http GLPI_URL="https://glpi.example.com" GLPI_USER_TOKEN="..." npx mcp-glpi
# or the equivalent flags:
npx mcp-glpi --http --port 3000
```

```
MCP GLPI Server v3.4.0 listening on http://127.0.0.1:3000/mcp
  transport: streamable HTTP (stateless, JSON responses)
  auth: none — bind to loopback or set MCP_HTTP_AUTH_TOKEN before exposing this port
```

| Flag | Description |
|---|---|
| `--http` | Shorthand for `--transport http` |
| `--transport <mode>` | `stdio` (default) or `http` |
| `--host <host>` | Bind address (default `127.0.0.1`) |
| `--port <port>` | Port; `0` picks a free port (default `3000`) |
| `--path <path>` | Endpoint path (default `/mcp`) |
| `-h`, `--help` | Print usage |

Endpoints: `POST /mcp` (JSON-RPC, MCP Streamable HTTP) and `GET /health`
(liveness). `GET`/`DELETE /mcp` return 405 — the server is stateless and never
initiates messages, so there is no SSE stream to open and no session to end.

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The `Accept` header must list both types (a bare `*/*` is accepted too) — the
transport rejects a POST that only accepts `application/json` with 406. MCP
clients, Open WebUI included, send the right thing already.

CLI flags override the `MCP_*` environment variables.

#### Open WebUI

Requires Open WebUI v0.6.31+.

1. Start the server in HTTP mode (above), on a host and port Open WebUI can reach.
2. In Open WebUI: **Admin Settings → External Tools → + (Add Server)**.
3. **Type**: `MCP (Streamable HTTP)` — *not* OpenAPI.
4. **Server URL**: `http://<host>:3000/mcp`
   (Open WebUI in Docker reaching a host-run server: `http://host.docker.internal:3000/mcp`).
5. **Auth**: `None`, unless you set `MCP_HTTP_AUTH_TOKEN` — then `Bearer` and
   paste the token as the key. `Bearer` with an empty key is rejected by Open WebUI.
6. **Save**, then enable the tool per chat via **+ → Integrations → Tools**.

All tools are exposed as one connection; the *Function Name Filter List* is
optional.

#### Exposing the endpoint

The endpoint has no auth by default, so it binds to `127.0.0.1` only. Before
binding to a reachable interface (`--host 0.0.0.0`) — required for Open WebUI in
a Linux container, which cannot use the host loopback — set
`MCP_HTTP_AUTH_TOKEN`, and either put the port behind TLS or keep it on a private
network. Every HTTP client shares the single configured GLPI account.

`MCP_HTTP_ALLOWED_HOSTS` restricts which `Host` headers are accepted
(DNS-rebinding protection). It defaults to the loopback names plus
`host.docker.internal`, and is switched off when the bind address is not
loopback — startup logs a warning in that case.

## Tool catalogue

### Tickets — read

| Tool | Description |
|---|---|
| `glpi_list_tickets` | List with `start`/`limit`/`range`/`sort`/`order`/`status` (`sort` = column name such as `date_mod`, or a search-option id of the same table) |
| `glpi_get_ticket` | Detail + status/urgency labels + counts of linked items |
| `glpi_get_ticket_timeline` | Followups + tasks + solutions + validations, chronological. `itemtype` = `Ticket` (default), `Change` or `Problem` |
| `glpi_search_tickets` | High-level search (status, assigned, requester, dates, ...) |
| `glpi_get_ticket_followups` | Followups of a ticket |
| `glpi_get_ticket_tasks` | Tasks (`TicketTask`, tickets only — see `glpi_get_change_tasks` / `glpi_get_problem_tasks`) |
| `glpi_get_ticket_solutions` | Solutions |
| `glpi_get_ticket_validations` | Validations (approvals) |
| `glpi_get_ticket_documents` | Linked documents |
| `glpi_get_ticket_satisfaction` | Satisfaction survey result |
| `glpi_list_overdue_tickets` | Tickets whose SLA deadline has passed |

### Tickets — write

| Tool | Description |
|---|---|
| `glpi_create_ticket` | Create a ticket |
| `glpi_update_ticket` | Update fields |
| `glpi_delete_ticket` | ⚠️ Delete (force=true purges) |
| `glpi_add_followup` | Add a followup |
| `glpi_add_task` | Add a task with time tracking |
| `glpi_add_solution` | Add a solution |
| `glpi_assign_ticket` | Assign to user OR group |
| `glpi_link_tickets` | `ticket_id` `relation` `other_ticket_id`, relation = `link` / `duplicate` / `child_of` (ticket_id is a child of other_ticket_id) / `parent_of` (ticket_id is the parent). Legacy `parent_id` + `child_id` (+ `link_type`) still accepted |
| `glpi_add_ticket_validation` | Request a validation |
| `glpi_set_validation_status` | Approve (2) or refuse (3) |
| `glpi_upload_document` | Upload a Document (max 20 MB) from `content_base64` + `filename`, or from `file_path` — only when `GLPI_UPLOAD_DIR` is set and the file resolves inside it; `ticket_id` attaches it in the same call |
| `glpi_attach_document_to_ticket` | Link an uploaded document to a ticket |

### Problems & Changes

| Tool | Description |
|---|---|
| `glpi_list_problems` / `glpi_get_problem` / `glpi_create_problem` / `glpi_update_problem` | Problem management (`get` includes followup/task/solution counts) |
| `glpi_get_problem_tasks` | Tasks of a problem (`ProblemTask`) |
| `glpi_list_changes` / `glpi_get_change` / `glpi_create_change` / `glpi_update_change` | Change management (`get` includes followup/task/solution/validation counts) |
| `glpi_get_change_tasks` | Tasks of a change (`ChangeTask`) |
| `glpi_get_ticket_timeline` with `itemtype: "Change"` or `"Problem"` | Chronological timeline of a change / problem |

Ids are per itemtype: Ticket #12, Change #12 and Problem #12 are unrelated records, so the `glpi_get_ticket_*` tools must not be used with a change or problem id.

### Assets

| Tool family | Notes |
|---|---|
| Computer, Software, NetworkEquipment, Printer, Monitor, Phone | `list_*`, `get_*`, plus `create`/`update`/`delete` symmetry |

### Knowledge base, contracts, suppliers, locations, projects, documents

`glpi_list_*`, `glpi_get_*`, and `glpi_create_*` where the GLPI API allows it.
`glpi_search_knowbase` performs a free-text search on the title (field id
resolved dynamically — no longer hard-coded).

### Users, groups, categories, entities

`glpi_list_users` filters active users via the search endpoint (not
`searchText`); `glpi_create_user`/`glpi_create_group`/`glpi_add_user_to_group`
cover provisioning.

### Statistics

| Tool | Description |
|---|---|
| `glpi_get_ticket_stats` | Counts by status (optional entity / date filters) |
| `glpi_get_asset_stats` | Total counts per asset type |
| `glpi_tickets_stats_by` | Ventilation by `status` / `category` / `technician` / `entity` / `month`, optional period |

### Generic / introspection

| Tool | Description |
|---|---|
| `glpi_search_v2` | Multi-criteria search (`criteria[]`, `forcedisplay`, `fetch_all`, ...) |
| `glpi_count` | Cheap totalcount probe with criteria |
| `glpi_list_search_options` | Catalogue of searchable fields for an itemtype |
| `glpi_get_session_info` | Active profile + available profiles + entities |
| `glpi_search` | **Deprecated**: single-criterion alias kept for backward compat |

### Resources

`glpi://tickets/open`, `glpi://tickets/recent`, `glpi://problems/open`,
`glpi://changes/pending`, `glpi://computers`, `glpi://groups`,
`glpi://categories`, `glpi://stats/tickets`, `glpi://stats/assets`.

## Reference

### Ticket status

| ID | Label |
|---|---|
| 1 | New |
| 2 | Processing (assigned) |
| 3 | Processing (planned) |
| 4 | Pending |
| 5 | Solved |
| 6 | Closed |

### Validation status

| ID | Label |
|---|---|
| 1 | Waiting |
| 2 | Granted |
| 3 | Refused |

### Urgency / impact / priority

| ID | Label |
|---|---|
| 1 | Very low |
| 2 | Low |
| 3 | Medium |
| 4 | High |
| 5 | Very high |

### Problem status

Same numbering as tickets for 1–6 (`CommonITILObject` constants), plus:

| ID | Label |
|---|---|
| 1 | New |
| 2 | Processing (assigned) |
| 3 | Processing (planned) |
| 4 | Pending |
| 5 | Solved |
| 6 | Closed |
| 7 | Accepted |
| 8 | Under observation |

### Change status

GLPI's `Change::getAllStatusArray()` values — the ids are not in workflow order:

| ID | Label |
|---|---|
| 1 | New |
| 9 | Evaluation |
| 10 | Approval |
| 7 | Accepted |
| 4 | Pending |
| 11 | Testing |
| 12 | Qualification |
| 5 | Applied (solved) |
| 8 | Review (under observation) |
| 6 | Closed |
| 13 | Refused |
| 14 | Cancelled |

### Sorting list tools

`glpi_list_*` tools call `GET /{itemtype}`, which sorts by **column name**
(`date_mod`, `status`, `entities_id`, ...). A numeric `sort` is accepted and
resolved to its column through `listSearchOptions`, but only for options of
the itemtype's own table; a joined field (requester name, category label)
returns a clear error — use `glpi_search_v2` with a search-option id for
those.

## Development

```bash
git clone https://github.com/GMS64260/mcp-glpi.git
cd mcp-glpi
npm install
npm run build
npm test          # node --test via tsx, mocked fetch
```

Run locally:

```bash
export GLPI_URL="https://glpi.example.com"
export GLPI_USER_TOKEN="..."
npm start
```

Add `-- --http` (`npm start -- --http --port 3000`) to run the HTTP transport
instead of stdio.

## License

MIT

## Links

- [GLPI Project](https://glpi-project.org/)
- [GLPI High-Level API](https://glpi-user-documentation.readthedocs.io/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [NPM Package](https://www.npmjs.com/package/mcp-glpi)
