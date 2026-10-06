import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { DatabaseSync } from 'node:sqlite';
import { fixtureJson } from './local-fixture.mjs';
import { seedReading } from './fixtures/reading-document.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const originalPath = fixtureJson;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('document information is outside review completion and legacy records survive', async t => {
  const h = await harness(t, true);
  let state = (await h.call('/api/review')).data;
  state = (await h.call('/api/review/pages/1', { revision: state.revision, status: 'excluded', reason: '기존 제외 근거', note: '기존 메모', evidence: 'page_image' })).data;
  state = (await h.call('/api/review/stages/2', { revision: state.revision, action: 'complete', includeUnreviewed: true, note: '페이지 선별 완료' })).data;
  const before = state;
  await h.restart(dbPath => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("INSERT INTO stage_reviews(review_id, stage_id, status, note) SELECT id, 0, 'pending', '예전 대상 확인 메모' FROM reviews; INSERT INTO stage_reviews(review_id, stage_id, status, note) SELECT id, 1, 'pending', '예전 무결성 메모' FROM reviews; UPDATE reviews SET active_stage = 1;");
    } finally { db.close(); }
  });
  state = (await h.call('/api/review')).data;
  assert.equal(state.activeStage, 0);
  assert.equal(state.revision, before.revision);
  assert.deepEqual(state.decisions, before.decisions);
  assert.deepEqual(state.stages, before.stages);
  for (const id of [0, 1]) assert.equal((await h.call(`/api/review/stages/${id}`, { revision: state.revision, action: 'complete', note: '정보 화면 완료 시도' })).status, 400);
  state = (await h.call('/api/review/navigation', { revision: state.revision, stage: 0, selectedPage: state.selectedPage, filter: 'all' })).data;
  assert.equal(state.activeStage, 0);
  state = (await h.call('/api/review/roles', { revision: state.revision, ref: '#/texts/0', status: 'normal', region: 'body', role: 'body', parentRef: '', reason: '두 번째 페이지의 본문 영역과 원본 소속을 확인함', evidence: 'json', followUp: '' })).data;
  await seedReading(async (endpoint, body) => { const result = await h.call(endpoint, { revision: state.revision, ...body }); if (result.status === 200) state = result.data; return result; }, (await h.call('/api/reading-review')).data);
  for (let id = 3; id < 12; id++) {
    const result = await h.call(`/api/review/stages/${id}`, { revision: state.revision, action: 'complete', note: '수동 검토 범위와 근거' });
    assert.equal(result.status, 200); state = result.data;
  }
  const completed = await h.call('/api/review/stages/12', { revision: state.revision, action: 'complete', note: '검사 결과 기록 완료' });
  assert.equal(completed.status, 200, 'legacy pending stages 0 and 1 must not gate final review');
  assert.ok(completed.data.stages.every(stage => stage.status === 'completed'));
  assert.deepEqual(h.app.source.stages.map(stage => stage.id), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  await h.restart(dbPath => {
    const db = new DatabaseSync(dbPath);
    try { assert.deepEqual(db.prepare('SELECT stage_id, note, status FROM stage_reviews WHERE stage_id < 2 ORDER BY stage_id').all().map(row => ({ ...row })), [{ stage_id: 0, note: '예전 대상 확인 메모', status: 'pending' }, { stage_id: 1, note: '예전 무결성 메모', status: 'pending' }]); }
    finally { db.close(); }
  });
  assert.deepEqual((await h.call('/api/review')).data, completed.data);
});

test('unknown document version and missing images allow JSON review without technical gates', async t => {
  const h = await harness(t, true);
  const document = JSON.parse(await readFile(h.jsonPath, 'utf8'));
  document.version = '1.11.0';
  document.pages['2'].image.uri = 'artifacts/not-provided.png';
  document.body.children = [{ $ref: '#/groups/999' }];
  await writeFile(h.jsonPath, JSON.stringify(document));
  await h.restart();
  const { status, data: info } = await h.call('/api/document');
  assert.equal(status, 200);
  assert.equal(info.schemaVersion, '1.11.0');
  assert.equal(info.converterVersion, null);
  assert.equal(info.input.versionConfirmed, false);
  assert.deepEqual(info.input.missingImages, [2]);
  assert.equal((await fetch(h.url + '/api/pages/2/image')).status, 404);
  const state = (await h.call('/api/review')).data;
  const included = await h.call('/api/review/pages/2', { revision: state.revision, status: 'included', reason: '', note: 'JSON으로 검수', evidence: 'json' });
  assert.equal(included.status, 200);
  assert.equal(included.data.decisions[1].status, 'included');
});

test('unreadable input shows a usable error screen and preserves existing review DB', async t => {
  const h = await harness(t, true);
  let state = (await h.call('/api/review')).data;
  state = (await h.call('/api/review/pages/1', { revision: state.revision, status: 'excluded', reason: '보존할 판단', note: '보존할 메모', evidence: 'json' })).data;
  const valid = await readFile(h.jsonPath, 'utf8');
  const invalid = [
    ['{not JSON', 'JSON으로 읽을 수 없습니다'],
    [JSON.stringify({ schema_name: 'OtherDocument' }), 'DoclingDocument JSON 형식이 아닙니다'],
    [JSON.stringify({ schema_name: 'DoclingDocument', pages: {} }), '표시할 페이지 정보가 없습니다'],
    [JSON.stringify({ schema_name: 'DoclingDocument', pages: { 1: null } }), '페이지 번호를 구분할 수 없어'],
    [JSON.stringify({ schema_name: 'DoclingDocument', pages: { 1: { page_no: 1 }, 2: { page_no: 1 } } }), '페이지 번호를 구분할 수 없어'],
  ];
  for (const [content, message] of invalid) {
    await writeFile(h.jsonPath, content); await h.restart();
    const result = await h.call('/api/document');
    assert.equal(result.status, 422);
    assert.ok(result.data.error.includes(message));
    assert.equal((await fetch(h.url)).status, 200);
    assert.equal(h.app.source, null);
  }
  await writeFile(h.jsonPath, valid); await h.restart();
  assert.deepEqual((await h.call('/api/review')).data, state);
});
async function harness(t, small = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-ui-api-'));
  const dbPath = path.join(directory, 'inspection/review.sqlite');
  let jsonPath = originalPath;
  if (small) {
    jsonPath = path.join(directory, 'raw/ieee1547-document.json');
    await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true });
    const original = JSON.parse(await readFile(originalPath, 'utf8'));
    await copyFile(path.join(path.dirname(originalPath), original.pages['1'].image.uri), path.join(directory, 'raw/artifacts/page.png'));
    const fixture = { schema_name: 'DoclingDocument', version: '1.10.0', name: 'Three page fixture', body: { self_ref: '#/body', children: [{ $ref: '#/texts/0' }] }, texts: [{ self_ref: '#/texts/0', label: 'text', parent: { $ref: '#/body' }, text: 'A paragraph across the review scope.', prov: [{ page_no: 2, bbox: { l: 1, r: 20, t: 50, b: 30, coord_origin: 'BOTTOMLEFT' } }] }], tables: [], pictures: [], pages: Object.fromEntries([1, 2, 3].map(number => [String(number), { ...original.pages['1'], page_no: number, image: { ...original.pages['1'].image, uri: 'artifacts/page.png' } }])) };
    await writeFile(jsonPath, JSON.stringify(fixture));
  }
  let app; let url;
  async function start() {
    app = createReviewApp({ projectDir: small ? directory : path.dirname(path.dirname(originalPath)), jsonPath, dbPath });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('candoc-ui-api-'));
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (endpoint, body, extraHeaders = {}) => {
    const response = await fetch(url + endpoint, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, data: await response.json() };
  };
  return { call, get url() { return url; }, get app() { return app; }, jsonPath, restart: async beforeStart => { await app.close(); if (beforeStart) await beforeStart(dbPath); await start(); } };
}

test('actual document, 138 page images, clean initial progress, immutable source', async t => {
  const baseline = digest(await readFile(originalPath));
  const h = await harness(t);
  const { data: doc } = await h.call('/api/document');
  assert.equal(doc.pageCount, 138);
  assert.equal(doc.pages.length, 138);
  assert.deepEqual(doc.input.missingImages, []);
  assert.equal(doc.schemaVersion, "1.10.0");
  assert.equal(doc.converterVersion, null);
  assert.equal(doc.originalFile, "IEEE-1547-2018.pdf");
  assert.equal(doc.input.versionConfirmed, true);
  assert.equal(doc.integrity, undefined);
  const { data: review } = await h.call('/api/review');
  assert.equal(review.activeStage, 2);
  assert.deepEqual(review.stages.map(stage => stage.id), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(review.stages.every(stage => stage.status === 'pending'));
  assert.ok(review.decisions.every(decision => decision.status === 'unreviewed'));
  assert.equal(review.panelVisible, false);
  assert.deepEqual(review.selectedPages, []);
  assert.equal(review.thumbnailSize, 240);
  assert.equal(review.pagesPerView, undefined);
  for (let offset = 0; offset < doc.pages.length; offset += 6) {
    await Promise.all(doc.pages.slice(offset, offset + 6).map(async page => {
      const response = await fetch(h.url + page.imageUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }));
  }
  assert.equal(digest(await readFile(originalPath)), baseline);
});

test('validation, explicit decisions, navigation and server restart persistence', async t => {
  const h = await harness(t);
  let { data: state } = await h.call('/api/review');
  const invalid = await h.call('/api/review/pages/18', { revision: state.revision, status: 'excluded', reason: '', note: '', evidence: 'page_image' });
  assert.equal(invalid.status, 400);
  assert.equal((await h.call('/api/review')).data.revision, state.revision);
  const excluded = await h.call('/api/review/pages/18', { revision: state.revision, status: 'excluded', reason: '테스트용 제외 판단 근거', note: '이전·다음 페이지 연결 확인 필요', evidence: 'both' });
  assert.equal(excluded.status, 200); state = excluded.data;
  const moved = await h.call('/api/review/navigation', { revision: state.revision, stage: 5, selectedPage: 18, filter: 'excluded' });
  assert.equal(moved.status, 200); state = moved.data;
  assert.equal(state.stages.find(stage => stage.id === 5).status, 'pending');
  const stale = await h.call('/api/review/pages/18', { revision: 0, status: 'included', reason: '', note: '', evidence: 'json' });
  assert.equal(stale.status, 409);
  await h.restart();
  const restored = (await h.call('/api/review')).data;
  assert.equal(restored.activeStage, 5); assert.equal(restored.selectedPage, 18); assert.equal(restored.filter, 'excluded');
  assert.equal(restored.revision, state.revision);
  assert.equal(restored.decisions.find(decision => decision.page === 18).reason, '테스트용 제외 판단 근거');
  const included = await h.call('/api/review/pages/18', { revision: restored.revision, status: 'included', reason: '제외 취소 근거', note: '원본 보존 확인', evidence: 'page_image' });
  assert.equal(included.status, 200);
  assert.equal(included.data.decisions.find(decision => decision.page === 18).status, 'included');
  assert.equal((await h.call('/api/review/navigation', { revision: included.data.revision, stage: 99, selectedPage: 18, filter: 'all' })).status, 400);
  assert.equal((await h.call('/api/review/pages/9999', { revision: included.data.revision, status: 'included', reason: '', note: '', evidence: 'json' })).status, 400);
});

test('completion gates and targeted reinspection after scope change', async t => {
  const h = await harness(t, true);
  let state = (await h.call('/api/review')).data;
  async function stage(id, action, note = '') { const result = await h.call(`/api/review/stages/${id}`, { revision: state.revision, action, note }); if (result.status === 200) state = result.data; return result; }
  async function decide(page, status, reason = '') { const result = await h.call(`/api/review/pages/${page}`, { revision: state.revision, status, reason, note: '', evidence: 'page_image' }); assert.equal(result.status, 200); state = result.data; }
  assert.equal((await stage(2, 'complete')).status, 400);
  assert.equal((await stage(4, 'complete')).status, 400);
  await decide(1, 'included'); await decide(2, 'excluded', '중복 페이지 확인'); await decide(3, 'pending', '페이지 역할 확인 필요');
  assert.equal((await stage(2, 'complete')).status, 400);
  await decide(3, 'included');
  assert.equal((await stage(2, 'complete')).status, 200);
  assert.equal(state.stages.find(stage => stage.id === 2).status, 'completed');
  await seedReading(async (endpoint, body) => { const result = await h.call(endpoint, { revision: state.revision, ...body }); if (result.status === 200) state = result.data; return result; }, (await h.call('/api/reading-review')).data);
  await stage(4, 'complete', '원본 1~3페이지 연결 수동 확인');
  await stage(8, 'complete', '목록 없음 확인');
  await decide(2, 'included', '제외 취소');
  assert.equal(state.stages.find(stage => stage.id === 2).status, 'pending');
  assert.equal(state.stages.find(stage => stage.id === 4).status, 'needs_review');
  assert.equal(state.stages.find(stage => stage.id === 8).status, 'completed', 'unrelated list review remains valid');
  assert.deepEqual(state.impacts.find(impact => impact.stage === 4).affectedPages, [1, 2, 3]);
  assert.equal((await stage(12, 'complete', '전체 완료 시도')).status, 400);
  state = (await h.call('/api/review/roles', { revision: state.revision, ref: '#/texts/0', status: 'normal', region: 'body', role: 'body', parentRef: '', reason: '복구 페이지 영역 확인', evidence: 'json', followUp: '' })).data;
  await seedReading(async (endpoint, body) => { const result = await h.call(endpoint, { revision: state.revision, ...body }); if (result.status === 200) state = result.data; return result; }, (await h.call('/api/reading-review')).data);
  await stage(4, 'complete', '원본 1~3페이지 변경 후 재검토');
  assert.equal(state.impacts.filter(impact => impact.stage === 4).length, 0);
});

test('keep remaining pages and complete atomically preserves explicit decisions across filters and restart', async t => {
  const h = await harness(t);
  let state = (await h.call('/api/review')).data;
  state = (await h.call('/api/review/pages', { revision: state.revision, pages: [1, 2], status: 'excluded', reason: '앞부분의 불필요한 페이지', note: '제외 근거 보존', evidence: 'page_image' })).data;
  state = (await h.call('/api/review/pages/3', { revision: state.revision, status: 'included', reason: '명시적인 포함 판단', note: '기존 메모 보존', evidence: 'both' })).data;
  const explicit = state.decisions.slice(0, 3);
  state = (await h.call('/api/review/stages/6', { revision: state.revision, action: 'complete', note: '본문 검토 근거' })).data;
  state = (await h.call('/api/review/navigation', { revision: state.revision, stage: 2, selectedPage: 1, selectedPages: [], filter: 'excluded', panelVisible: false })).data;
  const before = state;
  const body = { revision: state.revision, action: 'complete', note: '', includeUnreviewed: true };
  const completed = await h.call('/api/review/stages/2', body);
  assert.equal(completed.status, 200); state = completed.data;
  assert.equal(state.revision, before.revision + 1, 'inclusion and completion use a single transaction');
  assert.equal(state.stages.find(stage => stage.id === 2).status, 'completed');
  assert.equal(state.stages.find(stage => stage.id === 6).status, 'needs_review');
  assert.deepEqual(state.decisions.slice(0, 3), explicit, 'existing decisions, reasons, evidence and timestamps remain unchanged');
  assert.equal(state.decisions.filter(page => page.status === 'included').length, 136);
  assert.ok(state.decisions.slice(3).every(page => page.status === 'included' && page.evidence === 'selection' && page.reason.includes('유지하기로 결정')));
  assert.equal(state.filter, 'excluded', 'hidden pages are included without changing the current filter');
  assert.deepEqual(state.selectedPages, [], 'no page selection is required');
  assert.equal((await h.call('/api/review/stages/2', body)).status, 409, 'stale completion cannot overwrite newer records');
  assert.deepEqual((await h.call('/api/review')).data, state);
  await h.restart();
  assert.deepEqual((await h.call('/api/review')).data, state);
});

test('keep remaining pages preserves pending decisions and rejects unsupported completion requests', async t => {
  const h = await harness(t, true);
  let state = (await h.call('/api/review')).data;
  state = (await h.call('/api/review/pages/1', { revision: state.revision, status: 'excluded', reason: '중복 페이지', note: '제외 메모', evidence: 'page_image' })).data;
  state = (await h.call('/api/review/pages/2', { revision: state.revision, status: 'pending', reason: '역할 확인 필요', note: '보류 메모', evidence: 'json' })).data;
  const body = { revision: state.revision, action: 'complete', note: '', includeUnreviewed: true };
  assert.equal((await h.call('/api/review/stages/2', body)).status, 400);
  assert.deepEqual((await h.call('/api/review')).data, state, 'failed completion cannot partially include remaining pages');
  assert.equal((await h.call('/api/review/stages/2', { ...body, includeUnreviewed: 'true' })).status, 400);
  assert.equal((await h.call('/api/review/stages/4', { ...body, note: '전용 페이지 선별 동작을 다른 단계에서 시도' })).status, 400);
  assert.equal((await h.call('/api/review/stages/12', body)).status, 400);
  assert.equal((await h.call('/api/review/stages/2', { ...body, action: 'reopen' })).status, 400);
  assert.equal((await h.call('/api/review/pages/2', { revision: state.revision, status: 'pending', reason: '보류 유지', note: '', evidence: 'selection' })).status, 400);
  state = (await h.call('/api/review/pages/2', { revision: state.revision, status: 'included', reason: '보류 해결', note: '확인 완료', evidence: 'json' })).data;
  const result = await h.call('/api/review/stages/2', { ...body, revision: state.revision });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.decisions.slice(0, 2), state.decisions.slice(0, 2));
  assert.equal(result.data.decisions[2].status, 'included');
  assert.equal(result.data.decisions[2].evidence, 'selection');
  assert.equal(result.data.stages.find(stage => stage.id === 2).status, 'completed');
});

test('changed input refuses old writes and opens an isolated review session on restart', async t => {
  const h = await harness(t, true);
  const state = (await h.call('/api/review')).data;
  const saved = await h.call('/api/review/pages/1', { revision: state.revision, status: 'included', reason: '', note: 'old source', evidence: 'json' });
  assert.equal(saved.status, 200);
  const document = JSON.parse(await readFile(h.jsonPath, 'utf8')); document.name = 'New input revision';
  await writeFile(h.jsonPath, JSON.stringify(document));
  assert.equal((await h.call('/api/review/pages/2', { revision: saved.data.revision, status: 'included', reason: '', note: '', evidence: 'json' })).status, 409);
  await h.restart();
  const next = (await h.call('/api/review')).data;
  assert.notEqual(next.sourceHash, state.sourceHash);
  assert.ok(next.decisions.every(decision => decision.status === 'unreviewed'));
  assert.equal(next.revision, 0);
});

test('image/file boundaries and cross-origin mutations', async t => {
  const h = await harness(t, true);
  const state = (await h.call('/api/review')).data;
  const result = await h.call('/api/review/pages/1', { revision: state.revision, status: 'included', reason: '', note: '', evidence: 'json' }, { Origin: 'https://example.com' });
  assert.equal(result.status, 403);
  for (const route of ['/AGENTS.md', '/api/pages/0/image', '/api/pages/1/image/../../raw/ieee1547-document.json']) assert.equal((await fetch(h.url + route)).status, 404);
});

test('bulk decisions are atomic and display/selection preferences persist', async t => {
  const h = await harness(t, true);
  let state = (await h.call('/api/review')).data;
  const body = { revision: state.revision, pages: [1, 9999], status: 'excluded', reason: '공통 제외 사유', note: '공통 메모', evidence: 'both' };
  assert.equal((await h.call('/api/review/pages', body)).status, 400);
  assert.ok((await h.call('/api/review')).data.decisions.every(decision => decision.status === 'unreviewed'));
  assert.equal((await h.call('/api/review/pages', { ...body, pages: [1, 1] })).status, 400);
  const excluded = await h.call('/api/review/pages', { ...body, pages: [1, 2] });
  assert.equal(excluded.status, 200); state = excluded.data;
  assert.equal(state.revision, 1, 'bulk save increments revision once');
  assert.deepEqual(state.decisions.slice(0, 2).map(decision => [decision.status, decision.reason, decision.note]), [['excluded', '공통 제외 사유', '공통 메모'], ['excluded', '공통 제외 사유', '공통 메모']]);
  const moved = await h.call('/api/review/navigation', { revision: state.revision, stage: 2, selectedPage: 1, selectedPages: [1, 2], filter: 'all', panelVisible: false, thumbnailSize: 360 });
  assert.equal(moved.status, 200);
  await h.restart();
  state = (await h.call('/api/review')).data;
  assert.deepEqual(state.selectedPages, [1, 2]); assert.equal(state.thumbnailSize, 360); assert.equal(state.panelVisible, false);
  const restored = await h.call('/api/review/pages', { revision: state.revision, pages: [1, 2], status: 'included', reason: '일괄 제외 취소', note: '', evidence: 'page_image' });
  assert.equal(restored.status, 200);
  assert.ok(restored.data.decisions.slice(0, 2).every(decision => decision.status === 'included'));
});

test('legacy page-limit DB migrates without losing review decisions or navigation', async t => {
  const h = await harness(t, true);
  let state = (await h.call('/api/review')).data;
  state = (await h.call('/api/review/pages/2', { revision: state.revision, status: 'excluded', reason: '기존 제외 판단', note: '유지할 검수 메모', evidence: 'page_image' })).data;
  state = (await h.call('/api/review/navigation', { revision: state.revision, stage: 5, selectedPage: 2, selectedPages: [1, 2], filter: 'excluded', panelVisible: true })).data;
  await h.restart(dbPath => {
    const legacy = new DatabaseSync(dbPath);
    try { legacy.exec('ALTER TABLE reviews DROP COLUMN thumbnail_size; ALTER TABLE reviews ADD COLUMN pages_per_view INTEGER NOT NULL DEFAULT 36;'); }
    finally { legacy.close(); }
  });
  const migrated = (await h.call('/api/review')).data;
  assert.equal(migrated.thumbnailSize, 240);
  assert.equal(migrated.pagesPerView, undefined);
  assert.equal(migrated.revision, state.revision);
  assert.equal(migrated.activeStage, 5); assert.equal(migrated.selectedPage, 2); assert.equal(migrated.filter, 'excluded'); assert.equal(migrated.panelVisible, true);
  assert.deepEqual(migrated.selectedPages, [1, 2]);
  assert.deepEqual(migrated.decisions, state.decisions);
});
