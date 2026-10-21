/**
 * MCP prompts: ready-made workflows that spell out the exact tool sequence,
 * so the model does not need the README. Prompt arguments are strings (MCP
 * protocol); ids are validated as digits.
 *
 * Prompts only read, then PROPOSE write calls: the model must ask the user
 * before running any of them.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import type { GlpiClient } from './glpi-client.js';
import { TICKET_PRIORITY, TICKET_STATUS, TICKET_URGENCY } from './itil.js';
import type { RegistryOptions } from './tools/registry.js';

export interface PromptContext {
  client: GlpiClient;
  options?: RegistryOptions;
}

const codes = (table: Record<number, string>) =>
  Object.entries(table)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

/** Reference block embedded in every prompt. */
export const STATUS_REFERENCE = [
  'GLPI reference:',
  `- Ticket status: ${codes(TICKET_STATUS)}. Open = status "notold" (1-4), finished = "old" (5-6).`,
  `- Urgency / impact: ${codes(TICKET_URGENCY)}. Priority: ${codes(TICKET_PRIORITY)}.`,
  '- Ticket type: 1 Incident, 2 Request. Actor role (glpi_assign_ticket type): 1 Requester, 2 Assigned, 3 Observer.',
  '- Dates are "YYYY-MM-DD HH:MM:SS" in the GLPI server timezone. Ids are per itemtype.',
].join('\n');

const LANGUAGE = 'Answer in the language the user writes in (these instructions are in English for precision only).';

const CONFIRM =
  'Do NOT run any write tool (create/update/assign/add/set) yourself: show the proposed calls with their exact arguments ' +
  'and wait for the user to confirm, then run them.';

const idArg = (what: string) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a positive integer')
    .describe(`${what} (number)`);

const userMessage = (description: string, body: string): GetPromptResult => ({
  description,
  messages: [{ role: 'user', content: { type: 'text', text: `${body}\n\n${STATUS_REFERENCE}\n\n${LANGUAGE}` } }],
});

/** Local date YYYY-MM-DD (GLPI stores server-local datetimes). */
function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

interface PromptDef {
  name: string;
  title: string;
  description: string;
  argsSchema: z.ZodRawShape;
  build: (args: Record<string, string | undefined>) => GetPromptResult;
}

export const PROMPTS: readonly PromptDef[] = [
  {
    name: 'triage_ticket',
    title: 'Triage a ticket',
    description: 'Read a ticket and its timeline, classify it, propose an assignment and a first response (writes need confirmation).',
    argsSchema: { id: idArg('Ticket id to triage') },
    build: ({ id }) =>
      userMessage(
        `Triage ticket ${id}`,
        [
          `Triage GLPI ticket ${id}.`,
          '',
          'Steps:',
          `1. glpi_get_ticket {"id": ${id}} — title, description, status, urgency, impact, category, entity, requester.`,
          `2. glpi_get_ticket_timeline {"id": ${id}} — followups, tasks, solutions, validations so far.`,
          '3. glpi_list_items {"itemtype": "ITILCategory"} for the categories, and glpi_list_items {"itemtype": "Group"} ' +
            '(or glpi_find_user {"query": "..."}) to choose an assignee.',
          '4. Optionally glpi_search_tickets {"text_search": "<keywords>", "limit": 5} to spot duplicates or similar past tickets.',
          '',
          'Then report:',
          '- Summary of the request in two sentences.',
          '- Classification: type (Incident/Request), category (name + id), urgency and impact (1-5) with a one-line justification each.',
          '- Proposed assignment: group and/or technician (name + id) and why.',
          '- A first response to the requester (short, polite, states the next step).',
          '- Possible duplicates, if any.',
          '',
          'End with the exact tool calls to apply the triage, for example:',
          `  glpi_update_ticket {"id": ${id}, "type": <1|2>, "itilcategories_id": <id>, "urgency": <1-5>, "impact": <1-5>}`,
          `  glpi_assign_ticket {"ticket_id": ${id}, "group_id": <id>, "user_id": <id>, "type": 2}`,
          `  glpi_add_followup {"ticket_id": ${id}, "content": "<first response>"}`,
          CONFIRM,
        ].join('\n')
      ),
  },
  {
    name: 'daily_report',
    title: 'Daily service desk report',
    description: 'New/solved/closed ticket counts for one day, overdue tickets, top categories and a 10-line summary.',
    argsSchema: {
      entity_id: z
        .string()
        .regex(/^\d+$/, 'must be an integer')
        .optional()
        .describe('Entity id to restrict the report to (number, 0 = root entity; default all active entities)'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
        .optional()
        .describe('Day to report on, YYYY-MM-DD (default today, server-local)'),
    },
    build: ({ entity_id, date }) => {
      const day = date ?? today();
      const from = `${day} 00:00:00`;
      const to = `${day} 23:59:59`;
      const ent = entity_id !== undefined ? `, "entity_id": ${entity_id}` : '';
      const entCrit = entity_id !== undefined ? `, {"link": "AND", "field": "Ticket.Entity.completename", "searchtype": "equals", "value": ${entity_id}}` : '';
      return userMessage(
        `Daily report for ${day}${entity_id !== undefined ? ` (entity ${entity_id})` : ''}`,
        [
          `Write the service desk daily report for ${day}${entity_id !== undefined ? ` in entity ${entity_id}` : ''}.`,
          '',
          'Steps:',
          `1. New tickets: glpi_tickets_stats_by {"dimension": "status", "date_from": "${from}", "date_to": "${to}"${ent}} ` +
            '— tickets opened that day, broken down by their current status (total = new tickets).',
          `2. Top categories: glpi_tickets_stats_by {"dimension": "category", "date_from": "${from}", "date_to": "${to}"${ent}} — keep the top 5.`,
          '3. Solved and closed that day (glpi_tickets_stats_by filters on the opening date, so count on the solve/close date):',
          `   glpi_count {"itemtype": "Ticket", "criteria": [{"field": "solvedate", "searchtype": "morethan", "value": "${from}"}, ` +
            `{"link": "AND", "field": "solvedate", "searchtype": "lessthan", "value": "${to}"}${entCrit}]}`,
          `   glpi_count {"itemtype": "Ticket", "criteria": [{"field": "closedate", "searchtype": "morethan", "value": "${from}"}, ` +
            `{"link": "AND", "field": "closedate", "searchtype": "lessthan", "value": "${to}"}${entCrit}]}`,
          `4. Backlog: glpi_count {"itemtype": "Ticket", "criteria": [{"field": "status", "searchtype": "equals", "value": "notold"}${entCrit}]}.`,
          `5. Overdue: glpi_list_overdue_tickets {"limit": 20${ent}} — open tickets past their resolution deadline.`,
          '',
          'Report format:',
          '- A table: new, solved, closed, open backlog, overdue.',
          '- Top categories of the day with counts.',
          '- Overdue tickets: id, title, deadline, technician (at most 10, oldest deadline first).',
          '- A summary of at most 10 lines: workload trend, risks (overdue, Very high urgency), suggested actions.',
          'This report is read-only: do not modify any ticket.',
        ].join('\n')
      );
    },
  },
  {
    name: 'draft_solution',
    title: 'Draft a ticket solution',
    description: 'Read a ticket and its timeline, search the knowledge base, draft a solution and propose glpi_add_solution.',
    argsSchema: { id: idArg('Ticket id to solve') },
    build: ({ id }) =>
      userMessage(
        `Draft a solution for ticket ${id}`,
        [
          `Draft a solution for GLPI ticket ${id}.`,
          '',
          'Steps:',
          `1. glpi_get_ticket {"id": ${id}} and glpi_get_ticket_timeline {"id": ${id}} — understand the problem and what was already tried.`,
          '2. glpi_search_knowbase {"query": "<2-3 keywords from the title or error message>"} — try several short keyword sets ' +
            '(it matches the article title). Read promising articles with glpi_get_item {"itemtype": "KnowbaseItem", "id": <id>}.',
          '3. Optionally glpi_search_tickets {"text_search": "<keywords>", "status": 5} for similar solved tickets, then their timeline.',
          '',
          'Then write:',
          '- The diagnosis (cause, or most likely cause and how to confirm it).',
          '- The solution text for the requester: numbered steps, plain language, mention the KB article ids used.',
          '- What is still uncertain or needs checking.',
          '',
          'Propose (do not execute):',
          `  glpi_add_solution {"ticket_id": ${id}, "content": "<solution text>"}`,
          'Adding a solution marks the ticket Solved (5). If information is missing, propose a glpi_add_followup asking the requester instead.',
          CONFIRM,
        ].join('\n')
      ),
  },
  {
    name: 'kb_from_ticket',
    title: 'Knowledge base article from a ticket',
    description: 'Turn a solved ticket into a knowledge base article and propose glpi_create_knowbase_item.',
    argsSchema: { id: idArg('Solved ticket id') },
    build: ({ id }) =>
      userMessage(
        `KB article from ticket ${id}`,
        [
          `Turn solved GLPI ticket ${id} into a knowledge base article.`,
          '',
          'Steps:',
          `1. glpi_get_ticket {"id": ${id}} — check the status is 5 Solved or 6 Closed; if not, say so and stop.`,
          `2. glpi_get_ticket_timeline {"id": ${id}} — the solution and the followups/tasks that led to it.`,
          '3. glpi_search_knowbase {"query": "<keywords>"} — if an article already covers it, propose updating that one ' +
            '(glpi_update_item {"itemtype": "KnowbaseItem", "id": <id>, "input": {"answer": "..."}}) instead of a duplicate.',
          '',
          'Write the article, generic (no requester names, no passwords, no internal ticket chatter):',
          '- Title: the symptom as a user would search it.',
          '- Symptoms, Cause, Resolution (numbered steps), Keywords (5-10 search terms).',
          `- A last line "Source: ticket ${id}".`,
          '',
          'Propose (do not execute):',
          '  glpi_create_knowbase_item {"name": "<title>", "answer": "<HTML body with <h2>Symptoms</h2>, <h2>Cause</h2>, ' +
            '<h2>Resolution</h2>, <h2>Keywords</h2>>", "is_faq": false}',
          CONFIRM,
        ].join('\n')
      ),
  },
  {
    name: 'my_open_tickets',
    title: 'My open tickets',
    description: 'List the open tickets assigned to the GLPI account this server is connected as, with what to do next.',
    argsSchema: {},
    build: () =>
      userMessage('My open tickets', [
        'List the open GLPI tickets assigned to me (the account this server is connected as).',
        '',
        'Steps:',
        '1. glpi_search_tickets {"assigned_user_id": "me", "open_only": true, "sort": "time_to_resolve", "order": "ASC", "limit": 50}',
        '   "me" is the connected account (glpi_get_session_info shows who it is). If totalcount > 50, page with start = next_start.',
        '2. Optionally glpi_list_overdue_tickets {} and keep the ones assigned to me to flag overdue tickets.',
        '',
        'Report: a table (id, title, status_label, priority, deadline, last update), overdue tickets first, then by priority; ' +
          'end with the three tickets to handle first and why. Read-only: do not modify tickets.',
      ].join('\n')),
  },
];

export function registerPrompts(server: McpServer, _ctx: PromptContext): void {
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, (args: unknown) =>
      p.build((args ?? {}) as Record<string, string | undefined>)
    );
  }
  // McpServer advertises listChanged: true; the prompt set is fixed.
  server.server.registerCapabilities({ prompts: { listChanged: false } });
}
