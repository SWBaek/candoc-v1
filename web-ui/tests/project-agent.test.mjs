import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { harness } from './role-harness.mjs';
import { roleAnnotationDocument } from './fixtures/role-annotation-document.mjs';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';

export const models = async () => [{ model: 'test-model', displayName: 'Synthetic', efforts: ['medium'], defaultEffort: 'medium' }];
export const projectRunner = file => args => runCodexSuggestions({ ...args, launch: { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-project-agent-app-server.mjs', import.meta.url)), file] }, timeoutMs: 15000 });
async function setup(t, runner) { let file; const h = await harness(t, roleAnnotationDocument(), { codexModelRunner: models, projectAgentRunner: args => runner ? runner(args) : projectRunner(file)(args) }); file = path.join(path.dirname(h.dbPath), 'fake-thread.json'); await h.request('/api/project/codex/check', 'POST', {}); assert.equal((await h.call('/api/project/codex', { version: 0, model: 'test-model', effort: 'medium' })).status, 200); const source = h.app.source; await h.put('/api/review/role-annotations', { sourceHash: source.sourceHash, ruleHash: source.ruleHash, page: 4, rect: { left: .08, top: .04, width: .76, height: .09 }, comment: '이 영역의 반복 머리말' }); return { h, file }; }
const agent = async h => (await h.call('/api/project/agent')).data;
async function start(h, message = '반복 머리말을 제안해', extra = {}) { const c = await agent(h), s = await h.state(), a = (await h.call('/api/role-annotations')).data.annotations[0]; return h.request('/api/project/agent', 'POST', { conversationId: c.conversationId, sourceHash: h.app.source.sourceHash, ruleHash: h.app.source.ruleHash, revision: s.revision, message, attachment: { stage: s.activeStage, page: s.selectedPage, refs: [], annotationId: a.id }, ...extra }); }
async function finish(h) { for (let i = 0; i < 200; i++) { const c = await agent(h); if (!c.running) return c.turns.at(-1); await new Promise(resolve => setTimeout(resolve, 15)); } throw Error('fixture timeout'); }
async function save(h, turn, exceptions = [], extra = {}) { return h.put('/api/review/agent-proposal', { turnId: turn.id, proposalId: turn.proposals[0].id, exceptions, sourceHash: h.app.source.sourceHash, ruleHash: h.app.source.ruleHash, ...extra }); }

test('project conversation persists and resumes the same thread across stage movement, reload and server restart; no review writes before approval', async t => {
  const { h, file } = await setup(t), before = await h.state();
  assert.equal((await start(h)).status, 202); const first = await finish(h);
  assert.equal(first.status, 'completed', first.error); assert.deepEqual(first.proposals[0].changes.map(row => row.ref), ['#/texts/0', '#/texts/1', '#/texts/2', '#/texts/9', '#/texts/10', '#/texts/11']);
  assert.ok(first.queries.length >= 3, 'the Agent actually retrieves paginated data'); assert.deepEqual(await h.state(), before);
  await h.put('/api/review/navigation', { stage: 5, selectedPage: 4, filter: 'all' }); assert.equal((await agent(h)).turns[0].stale, false, 'navigation is not a judgment change');
  await h.restart(); assert.equal((await start(h, 'chat')).status, 202); const second = await finish(h);
  assert.match(second.response, /이전 요청 반복 머리말/); assert.match(second.response, /현재 단계 5/);
  const state = JSON.parse(readFileSync(file)); assert.equal(state.starts, 1); assert.equal(state.resumes, 1); assert.ok(state.prompts.every(n => n < 16000));
  assert.equal((await agent(h)).total, 2); assert.deepEqual((await h.state()).roleReviews, before.roleReviews);
});

test('explicit approval/save with exceptions preserves mixed provenance, original membership and unrelated judgments; reload/restore and stale protection', async t => {
  const { h } = await setup(t); await h.put('/api/review/pages/1', { status: 'excluded', reason: '범위 제외', note: '', evidence: 'json' });
  await h.put('/api/review/roles', { ref: '#/texts/7', status: 'normal', region: 'footnote', role: 'footnote', parentRef: '', reason: '기존 기록', evidence: 'json', followUp: '' });
  const before = await h.state(), source = structuredClone(h.app.source.roleSource.items);
  await start(h); const turn = await finish(h); assert.equal(turn.status, 'completed', turn.error);
  assert.equal((await save(h, turn, ['#/texts/11'])).status, 200);
  const saved = await h.state(); assert.ok(!saved.roleReviews.some(row => row.ref === '#/texts/0')); assert.ok(!saved.roleReviews.some(row => row.ref === '#/texts/11')); assert.deepEqual(saved.roleReviews.find(row => row.ref === '#/texts/7'), before.roleReviews.find(row => row.ref === '#/texts/7'));
  assert.deepEqual(h.app.source.roleSource.items, source); assert.equal((await agent(h)).turns[0].proposals[0].saved.refs.length, 4);
  await h.restart(); assert.deepEqual(await h.state(), saved); assert.equal((await save(h, turn)).status, 409);
  assert.equal((await h.put('/api/review/role-groups', { action: 'restore', id: saved.roleUndo.id })).status, 200); assert.deepEqual((await h.state()).roleReviews, before.roleReviews);
});

test('invalid refs/unknown tools/failed and cancelled turns never create applicable proposals; concurrent request and stale attachments fail closed', async t => {
  const { h } = await setup(t), before = await h.state();
  for (const message of ['invalid-ref', 'unread-ref', 'unknown-tool', 'fail-after-proposal']) { await start(h, message); const turn = await finish(h); assert.deepEqual(turn.proposals, []); assert.deepEqual(await h.state(), before); }
  await start(h, 'hang'); assert.equal((await start(h, 'chat')).status, 409); const c = await agent(h); assert.equal((await h.request('/api/project/agent', 'DELETE', { id: c.running })).status, 200); assert.equal((await agent(h)).turns.at(-1).status, 'cancelled');
  assert.equal((await start(h, 'chat', { revision: -1 })).status, 409);
  assert.equal((await start(h, 'chat', { attachment: { stage: 3, page: 4, refs: ['#/texts/999999'] } })).status, 404);
  assert.deepEqual(await h.state(), before);
});

test('group save is atomic including proposal status; exceptions, review changes and source/rule conflicts are rejected', async t => {
  const { h } = await setup(t); await start(h); const turn = await finish(h), before = await h.state();
  assert.equal((await save(h, turn, ['#/texts/9999'])).status, 400); assert.equal((await save(h, turn, [], { sourceHash: 'changed' })).status, 409);
  const db = new DatabaseSync(h.dbPath); db.exec("CREATE TRIGGER agent_atomic_failure BEFORE INSERT ON role_reviews WHEN NEW.element_ref='#/texts/10' BEGIN SELECT RAISE(ABORT,'agent atomic test failure'); END"); db.close();
  assert.equal((await save(h, turn)).status, 500); assert.deepEqual(await h.state(), before); assert.equal((await agent(h)).turns[0].proposals[0].saved, undefined);
  const cleanup = new DatabaseSync(h.dbPath); cleanup.exec('DROP TRIGGER agent_atomic_failure'); cleanup.close();
  await h.put('/api/review/pages/4', { status: 'excluded', reason: '범위 변경', note: '', evidence: 'json' }); assert.equal((await save(h, turn)).status, 409); assert.equal((await start(h)).status, 409);
});

test('interrupted request recovers without auto inference and newer requests retain the same conversation', async t => {
  const { h, file } = await setup(t); await start(h, 'hang'); for(let n=0;n<100 && !(() => { try { return JSON.parse(readFileSync(file)).messages.length; } catch { return false; } })(); n++) await new Promise(r=>setTimeout(r,10));
  const id = (await agent(h)).conversationId; await h.restart(); assert.equal((await agent(h)).conversationId, id); assert.equal((await agent(h)).turns[0].status, 'cancelled');
  await start(h, 'chat'); assert.equal((await finish(h)).status, 'completed'); assert.equal(JSON.parse(readFileSync(file)).starts, 1);
});

test('bounded queries preserve full original mixed-page provenance and orig; unread refs, invalid geometry and query limits cannot become changes', async t => {
  const queries = [];
  const { h } = await setup(t, async args => {
    args.conversation.onThread('local-query-fixture');
    const call = args.conversation.callTool;
    assert.throws(() => call('candoc_query', { operation: 'refs', refs: ['#/texts/9', '#/texts/9'] }), /중복/);
    assert.throws(() => call('candoc_query', { operation: 'region', rect: { left: -1, top: 0, width: 1, height: 1 } }), /영역/);
    assert.throws(() => call('candoc_query', { operation: 'page', limit: 31 }), /limit/);
    assert.throws(() => call('candoc_propose_roles', { reason: 'unread', region: 'header', role: 'header', refs: ['#/texts/7'] }), /조회/);
    for (const operation of ['summary', 'pages', 'page', 'region', 'pattern', 'outline', 'reviews']) queries.push(call('candoc_query', { operation, limit: 2 }));
    queries.push(call('candoc_query', { operation: 'refs', refs: ['#/texts/9'] }));
    assert.ok(args.taskPrompt.length < 16000); assert.ok(!args.taskPrompt.includes('Important footnote content'));
    return '합성: 조회 범위를 확인했으며 판단은 저장하지 않았습니다.';
  });
  const before = await h.state(); await start(h); const turn = await finish(h); assert.equal(turn.status, 'completed', turn.error); assert.deepEqual(await h.state(), before);
  const item = queries.at(-1).rows[0], original = roleAnnotationDocument().texts[9];
  assert.deepEqual(item.provenance.map(({ page, rect, ...raw }) => raw), original.prov); assert.equal(item.orig, original.orig); assert.equal(item.parentRef, original.parent.$ref);
  assert.ok(queries.find(row => row.operation === 'pattern').nextOffset !== null); assert.deepEqual(turn.proposals, []);
});

test('in-flight review changes invalidate fetched proposals, while ordinary stage navigation permits the same turn to finish', async t => {
  for (const change of ['judgment', 'navigation']) {
    let release, queried; const ready = new Promise(resolve => queried = resolve), gate = new Promise(resolve => release = resolve);
    const { h } = await setup(t, async args => {
      args.conversation.onThread('local-freshness-fixture'); const call = args.conversation.callTool;
      call('candoc_query', { operation: 'refs', refs: ['#/texts/1'] }); call('candoc_propose_roles', { reason: '합성 근거', region: 'header', role: 'header', refs: ['#/texts/1'] }); queried(); await gate; return '합성: 확인한 항목의 변경안입니다.';
    });
    await start(h); await ready;
    if (change === 'judgment') await h.put('/api/review/pages/2', { status: 'excluded', reason: '범위 변경', note: '', evidence: 'json' });
    else await h.put('/api/review/navigation', { stage: 5, selectedPage: 4, filter: 'all' });
    release(); const turn = await finish(h);
    assert.equal(turn.status, change === 'judgment' ? 'failed' : 'completed'); assert.equal(turn.proposals.length, change === 'judgment' ? 0 : 1); assert.deepEqual((await h.state()).roleReviews, []);
  }
});


