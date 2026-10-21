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

export const TOOLSETS = ['core', 'tickets', 'itil', 'assets', 'users', 'kb', 'stats', 'session', 'admin'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/**
 * Always registered, whatever GLPI_TOOLSETS says: generic read, search and
 * session discovery, which every other toolset relies on.
 */
export const CORE_TOOLSET: Toolset = 'core';

export interface RegistryOptions {
  /** Only these toolsets (plus `core`) are registered (default: all). */
  toolsets?: ReadonlySet<Toolset>;
  /** Only read-only tools (and the session switches) are registered. */
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

/**
 * Kept by GLPI_READ_ONLY=1: read-only tools, and the `session` toolset
 * (active entity / profile switches change the session context, not GLPI data).
 */
export function allowedReadOnly(def: ToolDef): boolean {
  return isReadOnly(def) || def.toolset === 'session';
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
    if (options.toolsets && def.toolset !== CORE_TOOLSET && !options.toolsets.has(def.toolset)) {
      disabled.set(def.name, `toolset "${def.toolset}" is not enabled (GLPI_TOOLSETS)`);
    } else if (options.readOnly && !allowedReadOnly(def)) {
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

type Json = Record<string, unknown>;

/**
 * Parameters whose advertised JSON schema differs from the zod one used for
 * validation: `null` = accepted but not listed (`hidden()`), otherwise the
 * JSON schema listed instead of the generated one (`advertisedAs()`).
 */
const advertised = new WeakMap<z.ZodTypeAny, Json | null>();

/** Accepted by the tool, not listed in tools/list (legacy v3 parameter names). */
export function hidden<T extends z.ZodTypeAny>(schema: T): T {
  advertised.set(schema, null);
  return schema;
}

/** Validated by `schema`, listed as `json` (e.g. a long enum listed once elsewhere). */
export function advertisedAs<T extends z.ZodTypeAny>(schema: T, json: Json): T {
  advertised.set(schema, json);
  return schema;
}

/**
 * Trim the advertised JSON schema to what helps a model choose arguments.
 * Validation is unaffected: arguments are checked against the strict zod
 * object, not against this schema.
 *   - drops $schema, `additionalProperties: false`, empty `required`;
 *   - drops `minLength: 1` / `minItems: 1` (non-empty is implied) and
 *     `minimum: 0` (ids, offsets and caps are never negative);
 *   - writes integer `exclusiveMinimum: n` as `minimum: n + 1`;
 *   - drops descriptions on anyOf/oneOf branches when the parent has one;
 *   - drops `default` when the description already states the default;
 *   - merges an anyOf of bare types into a type list.
 * Keeps type, enum, const, required, other minimum/maximum, items.
 */
export function slimJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slimJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$schema') continue;
    if (key === 'additionalProperties' && value === false) continue;
    if (key === 'required' && Array.isArray(value) && value.length === 0) continue;
    if ((key === 'minLength' || key === 'minItems') && value === 1) continue;
    // Ids, offsets and caps are never negative: `minimum: 0` tells nothing.
    if (key === 'minimum' && value === 0) continue;
    // Positive integers: `minimum: 1` says the same as `exclusiveMinimum: 0`, shorter.
    if (key === 'exclusiveMinimum' && typeof value === 'number' && (node as Json).type === 'integer') {
      out.minimum = Math.floor(value) + 1;
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Json = {};
      for (const [name, prop] of Object.entries(value as Json)) props[name] = slimJsonSchema(prop);
      out[key] = props;
      continue;
    }
    out[key] = slimJsonSchema(value);
  }
  const description = typeof out.description === 'string' ? out.description : undefined;
  if (description) {
    for (const key of ['anyOf', 'oneOf'] as const) {
      const branches = out[key];
      if (Array.isArray(branches)) {
        out[key] = branches.map((b) => {
          if (!b || typeof b !== 'object' || !('description' in b)) return b;
          const { description: _d, ...rest } = b as Json;
          return rest;
        });
      }
    }
    if ('default' in out && /default/i.test(description)) delete out.default;
  }
  // anyOf of bare types -> one type list: {"type":["integer","string"]}.
  const anyOf = out.anyOf;
  if (
    Array.isArray(anyOf) &&
    anyOf.every((b) => b && typeof b === 'object' && Object.keys(b).length === 1 && typeof (b as Json).type === 'string')
  ) {
    delete out.anyOf;
    out.type = anyOf.map((b) => (b as Json).type);
  }
  return out;
}

/** "glpi_list_items" -> "list items": a title equal to this adds nothing. */
const readableName = (name: string) => name.replace(/^glpi_/, '').replace(/_/g, ' ');
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The title, unless it only restates the tool name. */
export function usefulTitle(name: string, title: string): string | undefined {
  return normalize(title) === normalize(readableName(name)) ? undefined : title;
}

/** MCP defaults: readOnlyHint false, destructiveHint true, idempotentHint false, openWorldHint true. */
const ANNOTATION_DEFAULTS: Required<ToolAnnotations> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Annotations as listed: keys equal to the MCP default are omitted, and so is
 * openWorldHint. It is false for every tool (only the configured GLPI is
 * reached), but a missing hint means "open world", the cautious reading, and
 * no client relaxes anything on false: 46 copies of it are not worth sending.
 */
export function listedAnnotations(annotations: ToolAnnotations): ToolAnnotations {
  const out: ToolAnnotations = {};
  for (const [key, value] of Object.entries(annotations) as Array<[keyof ToolAnnotations, boolean | undefined]>) {
    if (value === undefined || value === ANNOTATION_DEFAULTS[key] || key === 'openWorldHint') continue;
    // destructive/idempotent hints are meaningless on read-only tools.
    if (annotations.readOnlyHint && (key === 'destructiveHint' || key === 'idempotentHint')) continue;
    out[key] = value;
  }
  return out;
}

const schemaCache = new WeakMap<object, { zod: z.ZodObject<ZodRawShape>; json: Json }>();

/** Strict zod object + its advertised JSON schema, built once per definition. */
function schemasOf(def: ToolDef) {
  let cached = schemaCache.get(def);
  if (!cached) {
    const zod = z.object(def.inputSchema).strict();
    const raw = zodToJsonSchema(zod, { strictUnions: true, pipeStrategy: 'input', $refStrategy: 'none' }) as Json;
    const properties = raw.properties as Json | undefined;
    if (properties) {
      for (const [name, schema] of Object.entries(def.inputSchema)) {
        const listedAs = advertised.get(schema);
        if (listedAs === null) delete properties[name];
        else if (listedAs) properties[name] = listedAs;
      }
      if (Array.isArray(raw.required)) {
        raw.required = raw.required.filter((name) => typeof name === 'string' && name in properties);
      }
    }
    cached = { zod, json: slimJsonSchema(raw) as Json };
    schemaCache.set(def, cached);
  }
  return cached;
}

/** JSON schema advertised for a tool (for tests and measurements). */
export function listedInputSchema(def: ToolDef): Json {
  return schemasOf(def).json;
}

const ALIAS_SCHEMA = z.object({}).passthrough();
const ALIAS_JSON_SCHEMA = { type: 'object' };

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

  type ListedTool = ListToolsResult['tools'][number];
  const listed: ListToolsResult['tools'] = selection.tools.map((def) => {
    const title = usefulTitle(def.name, def.title);
    return {
      name: def.name,
      ...(title ? { title } : {}),
      description: def.description,
      inputSchema: schemasOf(def).json as ListedTool['inputSchema'],
      annotations: listedAnnotations(annotationsOf(def)),
    };
  });
  if (options.legacyTools) {
    for (const { alias, target } of aliasByName.values()) {
      listed.push({
        name: alias.name,
        description: `Deprecated v3 name, routed to ${target.name}. Prefer ${target.name}.`,
        inputSchema: ALIAS_JSON_SCHEMA as ListedTool['inputSchema'],
        annotations: listedAnnotations(annotationsOf(target)),
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
