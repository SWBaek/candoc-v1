import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { harness } from './role-harness.mjs';
import { roleAnnotationDocument } from './fixtures/role-annotation-document.mjs';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';

const endpoint = '/api/project/codex';
const models = [{ model: 'test-model', displayName: 'Test model', efforts: ['low', 'medium'], isDefault: true, defaultEffort: 'medium' }, { model: 'another', displayName: 'Another model', efforts: ['high'], isDefault: false }];
const check = h => h.request(endpoint + '/check', 'POST', {});
const settings = (model = 'test-model', effort = 'medium', version = 0) => ({ model, effort, version });

test('connection probe performs stdio login/model catalogue only; preferences persist independently of judgments', async t => {
  const launch = { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-role-annotation-app-server.mjs', import.meta.url)), 'catalogue-only'] };
  const h = await harness(t, roleAnnotationDocument(), { codexModelRunner: args => runCodexSuggestions({ ...args, catalogue: true, launch, timeoutMs: 5000 }) });
  const before = await h.state();
  assert.equal((await h.call(endpoint)).data.connection.status, 'unchecked');
  assert.equal((await h.call(endpoint, settings())).status, 400);
  const probe = await check(h); assert.equal(probe.status, 200); assert.equal(probe.data.connection.status, 'connected');
  assert.deepEqual(probe.data.connection.models[0].efforts, ['low', 'medium']);
  assert.equal((await h.call(endpoint, settings('test-model', 'high'))).status, 400);
  const saved = await h.call(endpoint, settings()); assert.equal(saved.status, 200); assert.equal(saved.data.settings.version, 1);
  assert.deepEqual(await h.state(), before);
  await h.restart(); const restored = (await h.call(endpoint)).data;
  assert.deepEqual(restored.settings, saved.data.settings); assert.equal(restored.connection.status, 'unchecked'); assert.deepEqual(restored.connection.models, []);
  assert.deepEqual(await h.state(), before);
});

test('unsupported combinations, settings conflicts and probe failure preserve saved settings and review', async t => {
  let mode = 'ok'; const h = await harness(t, roleAnnotationDocument(), { codexModelRunner: async () => { if (mode === 'failed') throw Error('Synthetic unauthenticated Codex'); return mode === 'removed' ? models.slice(1) : models; } });
  const before = await h.state(); await check(h);
  assert.equal((await h.call(endpoint, settings('missing'))).status, 400);
  assert.equal((await h.call(endpoint, settings('another', 'medium'))).status, 400);
  const saved = (await h.call(endpoint, settings())).data.settings;
  assert.equal((await h.call(endpoint, settings('another', 'high'))).status, 409);
  assert.equal((await h.call(endpoint, { ...settings('another', 'high', 1), token: 'must not persist' })).status, 400);
  mode = 'failed'; const failed = await check(h); assert.equal(failed.status, 503); assert.equal(failed.data.connection.status, 'failed'); assert.deepEqual(failed.data.connection.models, []); assert.deepEqual(failed.data.settings, saved);
  assert.equal((await h.call(endpoint, settings('another', 'high', 1))).status, 400);
  mode = 'removed'; await check(h);
  assert.equal((await h.request('/api/review/page-suggestions', 'POST', {})).status, 400);
  assert.deepEqual((await h.call(endpoint)).data.settings, saved); assert.deepEqual(await h.state(), before);
});

test('all three recommendation routes use saved model/effort and reject stale client overrides', async t => {
  const seen = [];
  const h = await harness(t, roleAnnotationDocument(), {
    codexModelRunner: async () => models,
    suggestionRunner: async ({ selectedModel, selectedEffort }) => { seen.push(['pages', selectedModel, selectedEffort]); return []; },
    headingSuggestionRunner: async ({ model, effort }) => { seen.push(['headings', model, effort]); return []; },
    roleAnnotationRunner: async ({ model, effort }) => { seen.push(['annotations', model, effort]); return []; }
  });
  await check(h); await h.call(endpoint, settings());
  const doc = (await h.call('/api/document')).data;
  assert.equal((await h.put('/api/review/role-annotations', { sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, page: 4, rect: { left: .08, top: .04, width: .76, height: .09 }, comment: 'header' })).status, 200);
  const annotationId = (await h.call('/api/role-annotations')).data.annotations[0].id, before = await h.state();
  assert.equal((await h.request('/api/review/page-suggestions', 'POST', {})).status, 202);
  assert.equal((await h.request('/api/review/heading-suggestions', 'POST', { revision: before.revision })).status, 202);
  assert.equal((await h.request('/api/review/role-annotation-suggestions', 'POST', { revision: before.revision, sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, annotationId })).status, 202);
  assert.deepEqual(seen, [['pages', 'test-model', 'medium'], ['headings', 'test-model', 'medium'], ['annotations', 'test-model', 'medium']]);
  assert.deepEqual(await h.state(), before);
  assert.equal((await h.request('/api/review/heading-suggestions', 'POST', { revision: before.revision, model: 'another', effort: 'high' })).status, 409);
  assert.equal((await h.request('/api/review/role-annotation-suggestions', 'POST', { revision: before.revision, sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, annotationId, model: 'test-model', effort: 'low' })).status, 409);
});

test('a settings update does not alter or cancel an in-flight request; the next request uses the new settings', async t => {
  let finish; const seen = [];
  const h = await harness(t, roleAnnotationDocument(), { codexModelRunner: async () => models, suggestionRunner: args => { seen.push([args.selectedModel, args.selectedEffort]); return new Promise(resolve => { finish = resolve; }); } });
  await check(h); await h.call(endpoint, settings()); const before = await h.state();
  const running = await h.request('/api/review/page-suggestions', 'POST', {});
  assert.equal((await h.call(endpoint, settings('another', 'high', 1))).status, 200);
  assert.equal((await h.call('/api/review/page-suggestions')).data.status, 'running');
  assert.equal(running.data.model, 'test-model'); assert.equal(running.data.effort, 'medium');
  finish([]);
  for (let i = 0; i < 20 && (await h.call('/api/review/page-suggestions')).data.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await h.request('/api/review/page-suggestions', 'POST', {}); finish([]);
  assert.deepEqual(seen, [['test-model', 'medium'], ['another', 'high']]); assert.deepEqual(await h.state(), before);
});

test('overlapping connection probes are rejected without a second runner or a judgment write', async t => {
  let finish, calls = 0;
  const h = await harness(t, roleAnnotationDocument(), { codexModelRunner: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const before = await h.state(), first = check(h);
  for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await check(h)).status, 409); finish(models); assert.equal((await first).status, 200); assert.equal(calls, 1); assert.deepEqual(await h.state(), before);
});
