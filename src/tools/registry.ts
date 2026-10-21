/**
 * Tool registry: typed tool definitions, toolset / read-only filtering,
 * hidden aliases for the v3 names, and the tools/list + tools/call handlers.
 *
 * Tools are registered on the McpServer (`registerTool`), then the two tool
 * request handlers are replaced so that:
 *   - aliases are callable but not listed (unless GLPI_LEGACY_TOOLS=1);
 *   - argument validation failures and unknown tools stay protocol errors
 *     (JSON-RPC InvalidParams / MethodNotFound), while GLPI and runtime
 *     failures become `isError` results with a hint (errors.ts);
 *   - listed JSON schemas are converted once and carry no `$schema` noise.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { GlpiClient } from '../glpi-client.js';
import { toolError } from '../errors.js';

export const TOOLSETS = ['tickets', 'itil', 'assets', 'users', 'kb', 'search', 'stats', 'session', 'admin'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface RegistryOptions {
  /** Only these toolsets are registered (default: all). */
  toolsets?: ReadonlySet<Toolset>;
  /** Only read-only tools are registered. */
  readOnly?: boolean;
  /** List the hidden v3 aliases too. */
  legacyTools?: boolean;
}

export interface ToolContext {
  client: GlpiClient;
  options: RegistryOptions;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  inputSchema: S;
  /** Overrides of the name-derived annotations. */
  annotations?: ToolAnnotations;
  handler: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>;
}

/** Identity helper that keeps the handler's argument type inferred from the shape. */
export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export interface AliasDef {
  /** Former (v3) tool name. */
  name: string;
  /** Tool it routes to. */
  target: string;
  /** Former arguments -> target arguments. */
  mapArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Safety hints derived from the tool name:
 *   list/get/search/find/count/stats -> read-only
 *   delete                          -> destructive (data loss possible)
 *   update/set/assign               -> destructive (overwrites), idempotent
 *   create/add/link/attach/upload   -> additive, not idempotent
 * openWorldHint is false everywhere: tools only reach the configured GLPI.
 */
export function deriveAnnotations(name: string): ToolAnnotations {
  if (/^glpi_(list_|get_|search|find_|count$|tickets_stats)/.test(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (/^glpi_delete_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (/^glpi_(update_|set_|assign_)/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  // idempotentHint defaults to false: not repeated.
  return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
}

export function annotationsOf(def: ToolDef): ToolAnnotations {
  return { ...deriveAnnotations(def.name), ...def.annotations };
}

export function isReadOnly(def: ToolDef): boolean {
  return annotationsOf(def).readOnlyHint === true;
}

// ---------------------------------------------------------------------------
// Options from the environment
// ---------------------------------------------------------------------------

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

export function parseRegistryOptions(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (m) => console.error(m)
): RegistryOptions {
  let toolsets: Set<Toolset> | undefined;
  const raw = env.GLPI_TOOLSETS?.trim();
  if (raw && raw.toLowerCase() !== 'all') {
    toolsets = new Set();
    for (const part of raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
      if ((TOOLSETS as readonly string[]).includes(part)) toolsets.add(part as Toolset);
      else warn(`Warning: GLPI_TOOLSETS: unknown toolset "${part}" ignored (known: ${TOOLSETS.join(', ')})`);
    }
  }
  return { toolsets, readOnly: truthy(env.GLPI_READ_ONLY), legacyTools: truthy(env.GLPI_LEGACY_TOOLS) };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface Selection {
  tools: ToolDef[];
  aliases: AliasDef[];
  /** Known names that are not registered, with the reason (for a clear error). */
  disabled: Map<string, string>;
}

export function selectTools(defs: readonly ToolDef[], aliases: readonly AliasDef[], options: RegistryOptions): Selection {
  const tools: ToolDef[] = [];
  const disabled = new Map<string, string>();
  for (const def of defs) {
    if (options.toolsets && !options.toolsets.has(def.toolset)) {
      disabled.set(def.name, `toolset "${def.toolset}" is not enabled (GLPI_TOOLSETS)`);
    } else if (options.readOnly && !isReadOnly(def)) {
      disabled.set(def.name, 'the server runs read-only (GLPI_READ_ONLY=1)');
    } else {
      tools.push(def);
    }
  }
  const registered = new Set(tools.map((t) => t.name));
  const kept: AliasDef[] = [];
  for (const alias of aliases) {
    if (registered.has(alias.target)) kept.push(alias);
    else disabled.set(alias.name, disabled.get(alias.target) ?? `${alias.target} is not available`);
  }
  return { tools, aliases: kept, disabled };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const schemaCache = new WeakMap<object, { zod: z.ZodObject<ZodRawShape>; json: Record<string, unknown> }>();

/** Strict zod object + its JSON schema, built once per definition. */
function schemasOf(def: ToolDef) {
  let cached = schemaCache.get(def);
  if (!cached) {
    const zod = z.object(def.inputSchema).strict();
    const json = zodToJsonSchema(zod, { strictUnions: true, pipeStrategy: 'input', $refStrategy: 'none' }) as Record<
      string,
      unknown
    >;
    delete json.$schema;
    cached = { zod, json };
    schemaCache.set(def, cached);
  }
  return cached;
}

const ALIAS_SCHEMA = z.object({}).passthrough();
const ALIAS_JSON_SCHEMA = { type: 'object', additionalProperties: true };

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join('.') || '(root)';
      return `${path}: ${i.message}`;
    })
    .join('; ');
}

/**
 * Run a tool: validate (protocol error on failure), call the handler, turn
 * any non-protocol failure into an `isError` result.
 */
export async function runTool(
  def: ToolDef,
  ctx: ToolContext,
  rawArgs: Record<string, unknown>,
  calledAs = def.name
): Promise<CallToolResult> {
  const parsed = schemasOf(def).zod.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${calledAs}: ${formatZodError(parsed.error)}`);
  }
  try {
    return await def.handler(ctx, parsed.data as never);
  } catch (error) {
    // Argument errors detected by the handler stay protocol-level.
    if (error instanceof McpError && error.code === ErrorCode.InvalidParams) throw error;
    return toolError(error);
  }
}

/**
 * Register the selected tools and aliases on `server` and install the
 * tools/list and tools/call handlers. Returns the selection (for tests).
 */
export function registerAll(
  server: McpServer,
  ctx: ToolContext,
  defs: readonly ToolDef[],
  aliases: readonly AliasDef[],
  options: RegistryOptions
): Selection {
  const selection = selectTools(defs, aliases, options);
  const byName = new Map(selection.tools.map((d) => [d.name, d]));

  for (const def of selection.tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: schemasOf(def).zod as never,
        annotations: annotationsOf(def),
      },
      ((args: Record<string, unknown>) => runTool(def, ctx, args)) as never
    );
  }

  const aliasByName = new Map<string, { alias: AliasDef; target: ToolDef }>();
  for (const alias of selection.aliases) {
    const target = byName.get(alias.target)!;
    aliasByName.set(alias.name, { alias, target });
    server.registerTool(
      alias.name,
      {
        title: `${target.title} (legacy name)`,
        description: `Deprecated v3 name, routed to ${target.name}. Prefer ${target.name}.`,
        inputSchema: ALIAS_SCHEMA as never,
        annotations: annotationsOf(target),
      },
      ((args: Record<string, unknown>) => runTool(target, ctx, alias.mapArgs ? alias.mapArgs(args) : args, alias.name)) as never
    );
  }

  const listed: ListToolsResult['tools'] = selection.tools.map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: schemasOf(def).json as ListToolsResult['tools'][number]['inputSchema'],
    annotations: annotationsOf(def),
  }));
  if (options.legacyTools) {
    for (const { alias, target } of aliasByName.values()) {
      listed.push({
        name: alias.name,
        title: `${target.title} (legacy name)`,
        description: `Deprecated v3 name, routed to ${target.name}. Prefer ${target.name}.`,
        inputSchema: ALIAS_JSON_SCHEMA as ListToolsResult['tools'][number]['inputSchema'],
        annotations: annotationsOf(target),
      });
    }
  }

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const def = byName.get(name);
    if (def) return runTool(def, ctx, args);
    const entry = aliasByName.get(name);
    if (entry) {
      const mapped = entry.alias.mapArgs ? entry.alias.mapArgs(args) : args;
      return runTool(entry.target, ctx, mapped, name);
    }
    const reason = selection.disabled.get(name);
    if (reason) throw new McpError(ErrorCode.InvalidRequest, `Tool ${name} is disabled: ${reason}`);
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  });

  return selection;
}
