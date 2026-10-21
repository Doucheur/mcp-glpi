/**
 * Output conventions (src/output.ts), error texts (src/errors.ts) and the
 * client-side pieces they rely on (get_hateoas=false, getItemsPage).
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiClient } from '../src/glpi-client.js';
import { GlpiError } from '../src/http.js';
import {
  compactItem,
  htmlToText,
  listEnvelope,
  pageLimit,
  stripLinks,
  text,
  truncateText,
  withItilLabels,
} from '../src/output.js';
import { describeError, toolError } from '../src/errors.js';

test('text() is compact JSON', () => {
  const r = text({ a: 1, b: [1, 2] });
  assert.equal(r.content[0].type, 'text');
  assert.equal((r.content[0] as { text: string }).text, '{"a":1,"b":[1,2]}');
});

test('htmlToText decodes entity-encoded HTML, keeps line breaks, collapses spaces', () => {
  const stored = '&lt;p&gt;Bonjour&amp;nbsp;&lt;b&gt;Jean&lt;/b&gt;,&lt;/p&gt;&lt;p&gt;Le   PC&lt;br /&gt;ne d&#233;marre plus&lt;/p&gt;';
  assert.equal(htmlToText(stored), 'Bonjour Jean,\nLe PC\nne démarre plus');
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
  assert.equal(htmlToText('a &lt; b'), 'a < b', 'a lone &lt; is text, not a tag');
});

test('truncateText appends the original length', () => {
  assert.equal(truncateText('abcdef', 3), 'abc…[truncated, 6 chars]');
  assert.equal(truncateText('abc', 3), 'abc');
  assert.equal(truncateText('abcdef', 0), 'abcdef', '0 disables truncation');
});

test('listEnvelope computes next_start', () => {
  assert.deepEqual(listEnvelope([1, 2], 0, 5), { totalcount: 5, start: 0, count: 2, next_start: 2, items: [1, 2] });
  assert.equal(listEnvelope([1], 4, 5).next_start, null);
  assert.equal(listEnvelope([], 0, undefined).totalcount, 0);
  assert.equal(pageLimit(undefined), 25);
  assert.equal(pageLimit(10_000), 500);
});

test('stripLinks removes nested HATEOAS links', () => {
  assert.deepEqual(stripLinks({ id: 1, links: [{ rel: 'x' }], _documents: [{ id: 2, links: [] }] }), {
    id: 1,
    _documents: [{ id: 2 }],
  });
});

test('withItilLabels adds labels per itemtype', () => {
  assert.deepEqual(withItilLabels('Change', { status: 9, urgency: 4, priority: 6 }), {
    status: 9,
    status_label: 'Evaluation',
    urgency: 4,
    urgency_label: 'High',
    priority: 6,
    priority_label: 'Major',
  });
  assert.deepEqual(withItilLabels('Computer', { status: 1 }), { status: 1 });
});

test('compactItem projects per itemtype, keeps with_* data, cleans text; verbose keeps everything', () => {
  const raw = {
    id: 3, name: 'PC-01', serial: 'S1', computertypes_id: 'Laptop', uuid: 'u', links: [{}],
    ram: 'x', _networkports: [{ id: 1 }], comment: '<p>old   box</p>', date_creation: 'd',
  };
  assert.deepEqual(compactItem('Computer', raw), {
    id: 3, name: 'PC-01', serial: 'S1', uuid: 'u', comment: 'old box',
    computertypes_id: 'Laptop', _networkports: [{ id: 1 }],
  });
  const verbose = compactItem('Computer', raw, { verbose: true });
  assert.equal(verbose.ram, 'x');
  assert.equal(verbose.links, undefined);
  const ticket = compactItem('Ticket', { id: 1, status: 2, content: 'x'.repeat(30), users_id_lastupdater: 4 }, { max_content_chars: 10 });
  assert.equal(ticket.status_label, 'Processing (assigned)');
  assert.equal(ticket.content, 'xxxxxxxxxx…[truncated, 30 chars]');
  assert.equal(ticket.users_id_lastupdater, undefined);
  assert.equal(compactItem('Ticket', { content: '<b>x</b>' }, { raw_html: true }).content, '<b>x</b>');
});

test('describeError: GLPI code, path without query, hint', () => {
  const err = new GlpiError({
    status: 403,
    glpiCode: 'ERROR_RIGHT_MISSING',
    glpiMessage: "You don't have permission to perform this action.",
    body: '',
    url: 'https://glpi.test/apirest.php/Ticket/5?expand_dropdowns=true',
    method: 'PUT',
  });
  const msg = describeError(err);
  assert.match(msg, /^GLPI PUT Ticket\/5 -> 403 ERROR_RIGHT_MISSING: You don't have permission/);
  assert.match(msg, /glpi_set_active_profile/);
  const res = toolError(err);
  assert.equal(res.isError, true);
  assert.match(describeError(new GlpiError({ status: 404, body: 'nope', url: 'https://g/apirest.php/Computer/9', method: 'GET' })), /ids are per itemtype/i);
  assert.equal(describeError(new Error('boom')), 'boom');
});

// --- client: get_hateoas + getItemsPage -------------------------------------

function installFetch(handler: (url: string) => Response): string[] {
  const calls: string[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string) => {
    if (url.endsWith('/initSession')) return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    calls.push(url);
    return handler(url);
  });
  return calls;
}

test('GET item/list/sub-resources send get_hateoas=false; getItemsPage reads Content-Range', async () => {
  const calls = installFetch((url) =>
    url.includes('/Computer?')
      ? new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 206, headers: { 'Content-Range': '10-11/57' } })
      : new Response(JSON.stringify([]), { status: 200 })
  );
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  const page = await client.getItemsPage('Computer', { range: '10-11' });
  assert.deepEqual(page, { items: [{ id: 1 }, { id: 2 }], totalcount: 57 });
  await client.getItem('Computer', 1);
  await client.getItilFollowups('Ticket', 1);
  for (const url of calls) assert.equal(new URL(url).searchParams.get('get_hateoas'), 'false', url);
  assert.equal(new URL(calls[2]).searchParams.get('expand_dropdowns'), 'true');

  installFetch(() => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }));
  assert.deepEqual(await client.getItemsPage('Computer', { range: '0-24' }), { items: [{ id: 1 }], totalcount: 1 });
});
