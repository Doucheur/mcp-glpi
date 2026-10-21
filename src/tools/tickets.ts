/**
 * Ticket tools: search, detail, timeline, SLA, satisfaction, and writes
 * (followup / task / solution also accept a Change or Problem).
 */

import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { SearchCriterion } from '../search.js';
import { type ItilItemtype, VALIDATION_STATUS } from '../itil.js';
import { cleanTextFields, compactItem, pageLimit, stripLinks, text } from '../output.js';
import {
  formatGlpiDate,
  parseValidationStatus,
  resolveLinkArgs,
  resolveUploadSource,
  ticketField,
} from '../tool-helpers.js';
import { defineTool, type ToolDef } from './registry.js';
import {
  DATE_DESC,
  PRIORITY_DESC,
  STATUS_TICKET_DESC,
  URGENCY_DESC,
  defined,
  id,
  itilItemtype,
  optBool,
  optId,
  optInt,
  optStr,
  orderSchema,
  textShape,
} from './common.js';
import { resolveSearchSort, searchEnvelope } from './search-rows.js';

const invalid = (message: string) => new McpError(ErrorCode.InvalidParams, message);

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export const TIMELINE_KINDS = ['followup', 'task', 'solution', 'validation', 'document'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

const TIMELINE_FIELDS: Record<TimelineKind, readonly string[]> = {
  followup: ['id', 'users_id', 'is_private', 'requesttypes_id', 'content'],
  task: ['id', 'users_id', 'users_id_tech', 'groups_id_tech', 'state', 'actiontime', 'begin', 'end', 'is_private', 'content'],
  solution: ['id', 'users_id', 'status', 'solutiontypes_id', 'content'],
  validation: [
    'id', 'users_id', 'users_id_validate', 'status', 'status_label', 'submission_date', 'validation_date',
    'comment_submission', 'comment_validation',
  ],
  document: ['id', 'documents_id', 'users_id'],
};

function timelineDate(kind: TimelineKind, row: Record<string, unknown>): string {
  const d = kind === 'validation' ? row.submission_date ?? row.date_creation ?? row.date : row.date_creation ?? row.date ?? row.date_mod;
  return typeof d === 'string' ? d : '';
}

function timelineEntry(
  kind: TimelineKind,
  raw: unknown,
  opts: { verbose?: boolean; max_content_chars?: number; raw_html?: boolean }
): Record<string, unknown> {
  const row = stripLinks((raw ?? {}) as Record<string, unknown>);
  const withLabel =
    kind === 'validation' ? { ...row, status_label: VALIDATION_STATUS[Number(row.status)] ?? row.status } : row;
  let out: Record<string, unknown>;
  if (opts.verbose) out = withLabel;
  else {
    out = {};
    for (const k of TIMELINE_FIELDS[kind]) if (withLabel[k] !== undefined) out[k] = withLabel[k];
  }
  return { kind, date: timelineDate(kind, row), ...cleanTextFields(out, opts) };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchTickets = defineTool({
  name: 'glpi_search_tickets',
  title: 'Search tickets',
  toolset: 'tickets',
  description:
    'Find tickets with friendly filters (status, actors, category, entity, dates, title text). ' +
    'Returns {totalcount,start,count,next_start,items}; rows have readable keys (id, name, status, status_label, ' +
    'requester_name, technician_name, category, entity, date, date_mod...). For other itemtypes or arbitrary criteria use glpi_search_v2.',
  inputSchema: {
    status: optInt(STATUS_TICKET_DESC),
    open_only: optBool('Only status < 5 (not solved/closed)'),
    assigned_user_id: optId('Assigned technician (User id)'),
    assigned_group_id: optId('Assigned group (Group id)'),
    requester_user_id: optId('Requester (User id)'),
    category_id: optId('ITILCategory id'),
    entity_id: optId('Entity id (0 = root entity)'),
    priority: optInt(`Priority: ${PRIORITY_DESC}`),
    urgency: optInt(`Urgency: ${URGENCY_DESC}`),
    date_from: optStr(`Opened after, ${DATE_DESC}`),
    date_to: optStr(`Opened before, ${DATE_DESC}`),
    text_search: optStr('Text contained in the title'),
    is_deleted: optBool('true = search ONLY trashed tickets'),
    start: z.number().int().min(0).optional().describe('First row (default 0)'),
    limit: z.number().int().min(1).optional().describe('Rows per page (default 25, max 500)'),
    fetch_all: optBool('Follow pages until totalcount, capped by max_rows'),
    max_rows: z.number().int().min(1).optional().describe('Cap for fetch_all (default 1000)'),
    sort: z
      .union([z.number().int().min(1), z.string().min(1)])
      .optional()
      .describe('Search option id (19 = last update, 15 = opening date, 2 = id) or a column name'),
    order: orderSchema.describe('Sort direction (default DESC)'),
    ...textShape,
  },
  handler: async ({ client }, q) => {
    const criteria: SearchCriterion[] = [];
    const push = (c: SearchCriterion) => {
      if (criteria.length > 0 && !c.link) c.link = 'AND';
      criteria.push(c);
    };
    const f = (key: Parameters<typeof ticketField>[1]) => ticketField(client, key);
    if (q.status !== undefined) push({ field: await f('status'), searchtype: 'equals', value: q.status });
    if (q.assigned_user_id !== undefined) push({ field: await f('technician_user'), searchtype: 'equals', value: q.assigned_user_id });
    if (q.assigned_group_id !== undefined) push({ field: await f('technician_group'), searchtype: 'equals', value: q.assigned_group_id });
    if (q.requester_user_id !== undefined) push({ field: await f('requester_user'), searchtype: 'equals', value: q.requester_user_id });
    if (q.category_id !== undefined) push({ field: await f('category'), searchtype: 'equals', value: q.category_id });
    if (q.entity_id !== undefined) push({ field: await f('entity'), searchtype: 'equals', value: q.entity_id });
    if (q.priority !== undefined) push({ field: await f('priority'), searchtype: 'equals', value: q.priority });
    if (q.urgency !== undefined) push({ field: await f('urgency'), searchtype: 'equals', value: q.urgency });
    if (q.date_from) push({ field: await f('date'), searchtype: 'morethan', value: q.date_from });
    if (q.date_to) push({ field: await f('date'), searchtype: 'lessthan', value: q.date_to });
    if (q.text_search) push({ field: await f('name'), searchtype: 'contains', value: q.text_search });
    if (q.open_only) push({ field: await f('status'), searchtype: 'lessthan', value: 5 });

    const result = await client.search.search<Record<string, unknown>>('Ticket', {
      criteria,
      start: q.start ?? 0,
      limit: pageLimit(q.limit),
      fetchAll: q.fetch_all,
      maxRows: q.max_rows,
      sort: await resolveSearchSort(client, 'Ticket', q.sort),
      order: q.order ?? 'DESC',
      expandDropdowns: true,
      isDeleted: q.is_deleted,
    });
    return text(searchEnvelope('Ticket', result, q));
  },
});

const getTicket = defineTool({
  name: 'glpi_get_ticket',
  title: 'Get ticket',
  toolset: 'tickets',
  description:
    'One ticket: compact fields with status/urgency/priority labels, plain-text content, and counts of followups/tasks/solutions. ' +
    'Use glpi_get_ticket_timeline for the conversation.',
  inputSchema: {
    id: id('Ticket id'),
    with_logs: optBool('Include the history log (_logs; can be long)'),
    verbose: optBool('All fields, as GLPI sends them'),
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const [ticket, counts] = await Promise.all([
      client.getTicket(a.id, { with_logs: a.with_logs }),
      client.countItilChildren('Ticket', a.id),
    ]);
    return text({ ...compactItem('Ticket', ticket, a), counts });
  },
});

const getTimeline = defineTool({
  name: 'glpi_get_ticket_timeline',
  title: 'Get ITIL timeline',
  toolset: 'tickets',
  description:
    'Chronological timeline of a Ticket, Change or Problem: followups, tasks, solutions, validations and attached documents, ' +
    'oldest first, content as plain text. Use kinds to fetch only some of them. Set itemtype for changes/problems (ids are per itemtype).',
  inputSchema: {
    id: id('Id of the Ticket (or Change/Problem with itemtype)'),
    itemtype: itilItemtype,
    kinds: z
      .array(z.enum(TIMELINE_KINDS))
      .min(1)
      .optional()
      .describe('Entries to include (default all): followup, task, solution, validation (not for Problem), document'),
    verbose: optBool('Return every field of each entry'),
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const itemtype: ItilItemtype = a.itemtype ?? 'Ticket';
    const kinds = new Set<TimelineKind>(a.kinds ?? TIMELINE_KINDS);
    const none = async () => [] as unknown[];
    const [followups, tasks, solutions, validations, documents] = await Promise.all([
      kinds.has('followup') ? client.getItilFollowups(itemtype, a.id) : none(),
      kinds.has('task') ? client.getItilTasks(itemtype, a.id) : none(),
      kinds.has('solution') ? client.getItilSolutions(itemtype, a.id) : none(),
      kinds.has('validation') ? client.getItilValidations(itemtype, a.id) : none(),
      kinds.has('document') ? client.getItilDocuments(itemtype, a.id) : none(),
    ]);
    const timeline = [
      ...followups.map((r) => timelineEntry('followup', r, a)),
      ...tasks.map((r) => timelineEntry('task', r, a)),
      ...solutions.map((r) => timelineEntry('solution', r, a)),
      ...validations.map((r) => timelineEntry('validation', r, a)),
      ...documents.map((r) => timelineEntry('document', r, a)),
    ].sort((x, y) => String(x.date).localeCompare(String(y.date)));
    return text({ itemtype, id: a.id, count: timeline.length, timeline });
  },
});

const listOverdue = defineTool({
  name: 'glpi_list_overdue_tickets',
  title: 'List overdue tickets',
  toolset: 'tickets',
  description: 'Open tickets (status < 5) whose resolution deadline (time_to_resolve) is past, oldest deadline first.',
  inputSchema: {
    entity_id: optId('Entity id (0 = root entity)'),
    start: z.number().int().min(0).optional().describe('First row (default 0)'),
    limit: z.number().int().min(1).optional().describe('Rows per page (default 25, max 500)'),
    ...textShape,
  },
  handler: async ({ client }, a) => {
    // GLPI stores server-local datetimes: compare with local time, not UTC.
    const now = formatGlpiDate(new Date());
    const ttr = await ticketField(client, 'time_to_resolve');
    const criteria: SearchCriterion[] = [
      { field: await ticketField(client, 'status'), searchtype: 'lessthan', value: 5 },
      { field: ttr, searchtype: 'lessthan', value: now, link: 'AND' },
      { field: ttr, searchtype: 'notempty', value: '', link: 'AND' },
    ];
    if (a.entity_id !== undefined) {
      criteria.push({ field: await ticketField(client, 'entity'), searchtype: 'equals', value: a.entity_id, link: 'AND' });
    }
    const result = await client.search.search<Record<string, unknown>>('Ticket', {
      criteria,
      start: a.start ?? 0,
      limit: pageLimit(a.limit),
      expandDropdowns: true,
      order: 'ASC',
      sort: ttr,
    });
    return text(searchEnvelope('Ticket', result, a));
  },
});

const getSatisfaction = defineTool({
  name: 'glpi_get_ticket_satisfaction',
  title: 'Get ticket satisfaction',
  toolset: 'tickets',
  description: 'Satisfaction survey of a ticket (satisfaction score, comment, dates). Empty list when no survey.',
  inputSchema: { ticket_id: id('Ticket id') },
  handler: async ({ client }, a) => {
    const rows = await client.getTicketSatisfaction(a.ticket_id);
    return text(rows.map((r) => cleanTextFields(r as Record<string, unknown>)));
  },
});

// ---- writes ----------------------------------------------------------------

const createTicket = defineTool({
  name: 'glpi_create_ticket',
  title: 'Create ticket',
  toolset: 'tickets',
  description: 'Create a ticket. Returns its id.',
  inputSchema: {
    name: z.string().min(1).describe('Title'),
    content: z.string().min(1).describe('Description (plain text or HTML)'),
    type: optInt('1 Incident (default), 2 Request'),
    urgency: optInt(`Urgency (default 3): ${URGENCY_DESC}`),
    impact: optInt(`Impact: ${URGENCY_DESC}`),
    priority: optInt(`Priority (computed by GLPI when omitted): ${PRIORITY_DESC}`),
    category_id: optId('ITILCategory id'),
    entity_id: optId('Entity id (default: active entity)'),
    requester_user_id: optId('Requester (User id)'),
    requester_group_id: optId('Requester group (Group id)'),
    user_id_assign: optId('Assigned technician (User id)'),
    group_id_assign: optId('Assigned group (Group id)'),
    time_to_resolve: optStr(`Resolution deadline, ${DATE_DESC}`),
  },
  handler: async ({ client }, a) => {
    const result = await client.createTicket(
      defined({
        name: a.name,
        content: a.content,
        urgency: a.urgency ?? 3,
        impact: a.impact,
        priority: a.priority,
        type: a.type ?? 1,
        itilcategories_id: a.category_id,
        entities_id: a.entity_id,
        _users_id_assign: a.user_id_assign,
        _groups_id_assign: a.group_id_assign,
        _users_id_requester: a.requester_user_id,
        _groups_id_requester: a.requester_group_id,
        time_to_resolve: a.time_to_resolve,
      }) as Parameters<typeof client.createTicket>[0]
    );
    return text({ success: true, ...result });
  },
});

const updateTicket = defineTool({
  name: 'glpi_update_ticket',
  title: 'Update ticket',
  toolset: 'tickets',
  description: 'Change fields of a ticket. Only the fields given are written.',
  inputSchema: {
    id: id('Ticket id'),
    name: optStr('Title'),
    content: optStr('Description'),
    status: optInt(STATUS_TICKET_DESC),
    urgency: optInt(`Urgency: ${URGENCY_DESC}`),
    impact: optInt(`Impact: ${URGENCY_DESC}`),
    priority: optInt(`Priority: ${PRIORITY_DESC}`),
    itilcategories_id: optId('ITILCategory id'),
    type: optInt('1 Incident, 2 Request'),
    time_to_resolve: optStr(`Resolution deadline, ${DATE_DESC}`),
  },
  handler: async ({ client }, a) => {
    const { id: ticketId, ...fields } = a;
    const updates = defined(fields);
    if (Object.keys(updates).length === 0) throw invalid('nothing to update: pass at least one field besides id');
    await client.updateTicket(ticketId, updates as never);
    return text({ success: true, id: ticketId });
  },
});

const setTicketStatus = defineTool({
  name: 'glpi_set_ticket_status',
  title: 'Set ticket status',
  toolset: 'tickets',
  description: 'Change the status of a ticket. To solve with an explanation, prefer glpi_add_solution.',
  inputSchema: {
    id: id('Ticket id'),
    status: z.number().int().min(1).max(6).describe(STATUS_TICKET_DESC),
  },
  handler: async ({ client }, a) => {
    await client.updateTicket(a.id, { status: a.status });
    return text({ success: true, id: a.id, status: a.status });
  },
});

/** purge (or legacy force) requires confirm_id === id. */
export function checkPurge(itemId: number, purge: boolean | undefined, confirmId: number | undefined): boolean {
  if (!purge) return false;
  if (confirmId !== itemId) {
    throw invalid(
      `purge permanently destroys the item: set confirm_id to the same id (${itemId}) to confirm, ` +
        'or omit purge to move it to the trash (recoverable).'
    );
  }
  return true;
}

const deleteTicket = defineTool({
  name: 'glpi_delete_ticket',
  title: 'Delete ticket',
  toolset: 'tickets',
  description:
    'Move a ticket to the trash (recoverable). purge=true deletes it permanently and requires confirm_id equal to id.',
  inputSchema: {
    id: id('Ticket id'),
    purge: optBool('Delete permanently (irreversible); needs confirm_id'),
    force: optBool('Legacy name of purge'),
    confirm_id: optInt('Repeat the ticket id to confirm a purge'),
  },
  handler: async ({ client }, a) => {
    const purge = checkPurge(a.id, a.purge ?? a.force, a.confirm_id);
    await client.deleteTicket(a.id, purge);
    return text({ success: true, id: a.id, purged: purge });
  },
});

const ITIL_PARENT_DESC = 'Id of the Ticket (or of the Change/Problem when itemtype is set)';

const addFollowup = defineTool({
  name: 'glpi_add_followup',
  title: 'Add followup',
  toolset: 'tickets',
  description: 'Add a followup (comment) to a ticket, change or problem. Visible to the requester unless is_private.',
  inputSchema: {
    ticket_id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    content: z.string().min(1).describe('Text (plain text or HTML)'),
    is_private: optBool('Private: hidden from the requester'),
  },
  handler: async ({ client }, a) => {
    const result = await client.addItilFollowup(a.itemtype ?? 'Ticket', a.ticket_id, a.content, a.is_private ?? false);
    return text({ success: true, followup_id: result.id });
  },
});

const addTask = defineTool({
  name: 'glpi_add_task',
  title: 'Add task',
  toolset: 'tickets',
  description: 'Add a task (work log, time tracking) to a ticket, change or problem.',
  inputSchema: {
    ticket_id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    content: z.string().min(1).describe('Text'),
    actiontime: optInt('Time spent, in seconds'),
    state: optInt('0 Information, 1 To do (default), 2 Done'),
    is_private: optBool('Private: hidden from the requester'),
    users_id_tech: optId('Technician in charge (User id)'),
    groups_id_tech: optId('Group in charge (Group id)'),
    begin: optStr(`Planned start, ${DATE_DESC}`),
    end: optStr(`Planned end, ${DATE_DESC}`),
  },
  handler: async ({ client }, a) => {
    const result = await client.addItilTask(a.itemtype ?? 'Ticket', a.ticket_id, a.content, {
      is_private: a.is_private,
      actiontime: a.actiontime,
      state: a.state,
      users_id_tech: a.users_id_tech,
      groups_id_tech: a.groups_id_tech,
      begin: a.begin,
      end: a.end,
    });
    return text({ success: true, task_id: result.id });
  },
});

const addSolution = defineTool({
  name: 'glpi_add_solution',
  title: 'Add solution',
  toolset: 'tickets',
  description: 'Add a solution to a ticket, change or problem (GLPI then marks it solved, pending approval if configured).',
  inputSchema: {
    ticket_id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    content: z.string().min(1).describe('Solution text'),
    solutiontypes_id: optId('SolutionType id'),
  },
  handler: async ({ client }, a) => {
    const result = await client.addItilSolution(a.itemtype ?? 'Ticket', a.ticket_id, a.content, a.solutiontypes_id);
    return text({ success: true, solution_id: result.id });
  },
});

const assignTicket = defineTool({
  name: 'glpi_assign_ticket',
  title: 'Assign ticket',
  toolset: 'tickets',
  description: 'Add a user and/or a group to a ticket as requester, assignee (default) or observer. Both links are created when both are given.',
  inputSchema: {
    ticket_id: id('Ticket id'),
    user_id: optId('User id'),
    group_id: optId('Group id'),
    type: optInt('Role: 1 Requester, 2 Assigned (default), 3 Observer'),
  },
  handler: async ({ client }, a) => {
    if (!a.user_id && !a.group_id) throw invalid('user_id or group_id required');
    const result = await client.assignTicket(a.ticket_id, { users_id: a.user_id, groups_id: a.group_id, type: a.type });
    return text({
      success: true,
      assignment_id: result.id,
      ...(result.user_link_id !== undefined ? { user_assignment_id: result.user_link_id } : {}),
      ...(result.group_link_id !== undefined ? { group_assignment_id: result.group_link_id } : {}),
    });
  },
});

const linkTickets = defineTool({
  name: 'glpi_link_tickets',
  title: 'Link tickets',
  toolset: 'tickets',
  description:
    'Link two tickets: "ticket_id <relation> other_ticket_id". relation: link (default), duplicate (ticket_id duplicates other), ' +
    'child_of (ticket_id is a child of other), parent_of (ticket_id is the parent of other). ' +
    'Legacy form parent_id + child_id (+ link_type) still accepted.',
  inputSchema: {
    ticket_id: optId('Subject ticket'),
    other_ticket_id: optId('Ticket it is related to'),
    relation: z.enum(['link', 'duplicate', 'child_of', 'parent_of']).optional().describe('Default link'),
    link_type: optInt('Legacy numeric relation: 1 link, 2 duplicate, 3 child of, 4 parent of'),
    parent_id: optId('Legacy: parent ticket (use ticket_id + relation)'),
    child_id: optId('Legacy: child ticket (use other_ticket_id)'),
  },
  handler: async ({ client }, a) => {
    const { ticketId, otherTicketId, relation } = resolveLinkArgs(a);
    const result = await client.linkTickets(ticketId, otherTicketId, relation);
    return text({ success: true, link_id: result.id, ticket_id: ticketId, other_ticket_id: otherTicketId, relation });
  },
});

const addValidation = defineTool({
  name: 'glpi_add_ticket_validation',
  title: 'Request ticket validation',
  toolset: 'tickets',
  description: 'Ask a user to approve a ticket (TicketValidation, status Waiting). The user is notified by GLPI.',
  inputSchema: {
    ticket_id: id('Ticket id'),
    users_id_validate: id('User asked to approve'),
    comment_submission: optStr('Message to the approver'),
  },
  handler: async ({ client }, a) => {
    const result = await client.addTicketValidation(a.ticket_id, {
      users_id_validate: a.users_id_validate,
      comment_submission: a.comment_submission,
    });
    return text({ success: true, validation_id: result.id });
  },
});

const setValidationStatus = defineTool({
  name: 'glpi_set_validation_status',
  title: 'Answer ticket validation',
  toolset: 'tickets',
  description: 'Approve or refuse an existing TicketValidation (id from the timeline). status: 2 Granted, 3 Refused.',
  inputSchema: {
    validation_id: id('TicketValidation id'),
    status: z.union([z.number(), z.string()]).describe('2 Granted, 3 Refused'),
    comment_validation: optStr('Answer comment'),
  },
  handler: async ({ client }, a) => {
    const status = parseValidationStatus(a.status);
    await client.setTicketValidationStatus(a.validation_id, status, a.comment_validation);
    return text({ success: true, validation_id: a.validation_id, status_label: VALIDATION_STATUS[status] });
  },
});

const uploadDocument = defineTool({
  name: 'glpi_upload_document',
  title: 'Upload document',
  toolset: 'tickets',
  description:
    'Upload a file as a GLPI Document (max 20 MB): inline with content_base64 + filename, or by file_path ' +
    '(only when the server sets GLPI_UPLOAD_DIR; the path must resolve inside it). With ticket_id the document is attached to that ticket.',
  inputSchema: {
    content_base64: optStr('File content, base64-encoded'),
    filename: optStr('File name, required with content_base64 (e.g. "screenshot.png")'),
    file_path: optStr('Path of a file inside GLPI_UPLOAD_DIR on the server'),
    name: optStr('Document title (default: file name)'),
    ticket_id: optId('Attach the document to this ticket'),
  },
  handler: async ({ client }, a) => {
    const source = await resolveUploadSource(a);
    // Linking via the manifest lets GLPI create the Document_Item itself,
    // which also works for profiles that cannot POST Document_Item.
    const document = await client.uploadDocument({
      filename: source.filename,
      data: source.data,
      name: a.name,
      mimeType: source.mimeType,
      ...(a.ticket_id ? { itemtype: 'Ticket', items_id: a.ticket_id } : {}),
    });
    return text({ success: true, document_id: document.id, ...(a.ticket_id ? { ticket_id: a.ticket_id } : {}) });
  },
});

const attachDocument = defineTool({
  name: 'glpi_attach_document_to_ticket',
  title: 'Attach document to ticket',
  toolset: 'tickets',
  description: 'Link an existing Document to a ticket (Document_Item).',
  inputSchema: {
    ticket_id: id('Ticket id'),
    document_id: id('Document id'),
  },
  handler: async ({ client }, a) => {
    const result = await client.attachDocumentToTicket(a.ticket_id, a.document_id);
    return text({ success: true, link_id: result.id });
  },
});

export const TICKET_TOOLS: ToolDef[] = [
  searchTickets,
  getTicket,
  getTimeline,
  listOverdue,
  getSatisfaction,
  createTicket,
  updateTicket,
  setTicketStatus,
  deleteTicket,
  addFollowup,
  addTask,
  addSolution,
  assignTicket,
  linkTickets,
  addValidation,
  setValidationStatus,
  uploadDocument,
  attachDocument,
];
