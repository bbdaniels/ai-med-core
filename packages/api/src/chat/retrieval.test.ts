// Run: npm -w @ai-med/api test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtureIndex } from '../../test-support/fixture-index.js';
import { openReadingsIndex, type OpenIndex } from '../readings.js';
import { makeIssuer, type CompletionClient } from './completion.js';
import { makeEmbedder, makeRestater, runRetrievalLoop } from './retrieval.js';

/** A client that answers from a queue and records every request. */
function memoryClient(replies: any[]) {
  const chats: any[] = [];
  const embeds: any[] = [];
  const client: CompletionClient = {
    chat: { completions: { async create(req: any) {
      chats.push(structuredClone(req));
      const r = replies.shift();
      if (r instanceof Error) throw r;
      if (!r) throw new Error('no reply queued');
      return r;
    } } },
    embeddings: { async create(req: any) {
      embeds.push(req);
      return { data: [{ embedding: [0, 0, 0, 0, 0, 0, 0, 1] }] };
    } },
  };
  return { client, chats, embeds };
}

const answer = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});
const search = (args: object | string, id = 'call-1') => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
    id, type: 'function',
    function: { name: 'search_readings', arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  }] } }],
  usage: { prompt_tokens: 20, completion_tokens: 3 },
});

let tmp = '';
let index: OpenIndex;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-test-'));
  const dest = path.join(tmp, 'fixture.db');
  buildFixtureIndex(dest, {
    documents: [{ id: 'doc-one', authors: 'Fixture, A.', author_short: 'Fixture', year: 2026, title: 'A fixture document' }],
    chunks: [
      { doc_id: 'doc-one', header: 'Fixture | Methods', text: 'The zebrafish protocol ran for twelve weeks.', page_start: 1, page_end: 1 },
      { doc_id: 'doc-one', header: 'Fixture | Results', text: 'Attendance rose by a third.', page_start: 2, page_end: 2 },
    ],
  });
  process.env.READINGS_INDEX_RETRIEVAL_FIXTURE = dest;
  index = openReadingsIndex(tmp, 'retrieval_fixture', 'unused.db')!;
  assert.ok(index);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const loop = (client: CompletionClient, over: Partial<Parameters<typeof runRetrievalLoop>[0]> = {}) =>
  runRetrievalLoop({
    convo: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }],
    issue: makeIssuer(client, { model: 'gpt-4o-mini', structured: false }),
    index,
    languageCode: null,
    restate: async q => q,
    embed: makeEmbedder(client),
    log: () => {},
    ...over,
  });

test('no index: one completion, no tools offered', async () => {
  const m = memoryClient([answer('A.')]);
  const r = await loop(m.client, { index: null });
  assert.equal(m.chats.length, 1);
  assert.equal(m.chats[0].tools, undefined);
  assert.equal(m.chats[0].tool_choice, undefined);
  assert.equal(r.response.choices[0].message.content, 'A.');
  assert.deepEqual(r.usages, [{ prompt_tokens: 10, completion_tokens: 2 }]);
});

test('a search, then the answer: the tool result reaches the second request', async () => {
  const m = memoryClient([search({ query: 'zebrafish protocol' }), answer('Twelve weeks.')]);
  const r = await loop(m.client);
  assert.equal(m.chats.length, 2);
  assert.equal(m.chats[0].tools[0].function.name, 'search_readings');
  assert.equal(m.chats[0].tool_choice, 'auto');
  assert.equal(m.embeds.length, 1);
  assert.equal(m.embeds[0].model, 'text-embedding-3-small');
  const tool = m.chats[1].messages.at(-1);
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call-1');
  assert.match(tool.content, /zebrafish/);
  assert.equal(r.usages.length, 2);
  assert.deepEqual(r.searches, [{ asked: 'zebrafish protocol', ran: 'zebrafish protocol', week: null, results: r.searches[0].results }]);
  assert.ok(r.searches[0].results >= 1);
  assert.equal(r.convo.length, 4);                 // system, user, assistant tool call, tool result
});

test('the hop cap: past the last hop the tools are withheld', async () => {
  const m = memoryClient([search({ query: 'a' }), search({ query: 'b' }), search({ query: 'c' }), answer('Done.')]);
  const r = await loop(m.client);
  assert.equal(m.chats.length, 4);
  assert.ok(m.chats[2].tools);
  assert.equal(m.chats[3].tools, undefined);
  assert.equal(r.response.choices[0].message.content, 'Done.');
});

test('the hop cap is hard: a tool call past it is ignored, never run', async () => {
  // A reply to the tool-less request that still asks to search, with or
  // without an answer beside it.
  const late = (content: string | null) => {
    const r: any = search({ query: 'd' }, 'call-late');
    r.choices[0].message.content = content;
    return r;
  };
  for (const content of ['Answered anyway.', null]) {
    const m = memoryClient([search({ query: 'a' }), search({ query: 'b' }), search({ query: 'c' }), late(content)]);
    const r = await loop(m.client);
    assert.equal(m.chats.length, 4);                 // no fifth completion
    assert.equal(m.embeds.length, 3);                // the late query is never embedded
    assert.deepEqual(r.searches.map(s => s.asked), ['a', 'b', 'c']);
    assert.equal(r.usages.length, 4);
    assert.equal(r.response.choices[0].message.content, content);
    assert.ok(!r.convo.some((c: any) => c.tool_call_id === 'call-late'));
  }
  // maxHops 0: one tool-less completion, and its tool call is ignored too.
  const m0 = memoryClient([late('Zero.')]);
  const r0 = await loop(m0.client, { maxHops: 0 });
  assert.equal(m0.chats.length, 1);
  assert.equal(m0.chats[0].tools, undefined);
  assert.equal(m0.embeds.length, 0);
  assert.equal(r0.response.choices[0].message.content, 'Zero.');
});

test('an empty query is answered with an instruction, not a search', async () => {
  const m = memoryClient([search({ query: '' }), answer('A.')]);
  const r = await loop(m.client);
  assert.equal(m.embeds.length, 0);
  assert.equal(m.chats[1].messages.at(-1).content, 'search_readings requires a non-empty query string.');
  assert.deepEqual(r.searches, []);
});

test('a search that throws tells the model the search is unavailable', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const m = memoryClient([search({ query: 'x' }), answer('A.')]);
    await loop(m.client, { restate: async () => { throw new Error('boom'); } });
    assert.equal(m.chats[1].messages.at(-1).content,
      'The reading search failed. Tell the student the search is unavailable right now rather than answering from memory.');
    const m2 = memoryClient([search('{not json'), answer('A.')]);
    await loop(m2.client);
    assert.match(m2.chats[1].messages.at(-1).content, /^The reading search failed\./);
  } finally {
    console.error = quiet;
  }
});

test('restatement: skipped in the corpus language, run before the embedding otherwise', async () => {
  const same = memoryClient([]);
  assert.equal(await makeRestater(same.client, 'Vietnamese', ' vietnamese ')('hỏi'), 'hỏi');
  assert.equal(same.chats.length, 0);
  // The page sends the name its languages list shows; the corpus is declared in English.
  const list = [{ code: 'en', name: 'English' }, { code: 'vi', name: 'Tiếng Việt' }];
  for (const session of ['Tiếng Việt', 'Vietnamese', 'tieng viet', 'vi']) {
    assert.equal(await makeRestater(same.client, 'Vietnamese', session, list)('hỏi'), 'hỏi', session);
  }
  assert.equal(same.chats.length, 0);
  assert.equal(await makeRestater(same.client, null, 'English')('q'), 'q');
  assert.equal(same.chats.length, 0);

  // Queue order: the loop's first completion, then the restatement, then the answer.
  const m3 = memoryClient([search({ query: 'maternity leave' }), answer('nghỉ thai sản'), answer('A.')]);
  const r = await loop(m3.client, { restate: makeRestater(m3.client, 'Vietnamese', 'English') });
  assert.equal(m3.chats.length, 3);
  assert.equal(m3.chats[1].model, 'gpt-4o-mini');
  assert.equal(m3.chats[1].temperature, 0);
  assert.equal(m3.chats[1].max_tokens, 200);
  assert.equal(m3.chats[1].messages[1].content, 'maternity leave');
  assert.equal(m3.embeds[0].input, 'nghỉ thai sản');
  assert.deepEqual(r.searches.map(s => [s.asked, s.ran]), [['maternity leave', 'nghỉ thai sản']]);
});

test('the ladder: json_schema, then json_object, then plain', async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const m = memoryClient([new Error('400 schema'), new Error('400 object'), answer('plain')]);
    const issue = makeIssuer(m.client, { model: 'gpt-4o', structured: true });
    const r = await issue([{ role: 'user', content: 'Q' }], null);
    assert.equal(r.choices[0].message.content, 'plain');
    assert.deepEqual(m.chats.map(c => c.response_format?.type ?? null), ['json_schema', 'json_object', null]);
    assert.ok(m.chats.every(c => c.model === 'gpt-4o' && c.max_tokens === 1000 && c.temperature === 0.7));
  } finally {
    console.warn = quiet;
  }
});
