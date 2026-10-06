import http from 'node:http';
import path from 'node:path';
import { readFileSync, realpathSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { extractPageInput, runCodexSuggestions, validateSuggestions } from './codex-suggestions.mjs';
import { buildRoleSource, createRoleStore } from './role-review.mjs';
import { createRoleQuestionStore } from './role-questions.mjs';
import { createRoleAnnotationStore, runAnnotationSuggestions, validateAnnotationSuggestions } from './role-annotations.mjs';
import { createReadingStore } from './reading-review.mjs';
import { listHeadingModels, runHeadingSuggestions, validateHeadingSuggestions } from './heading-suggestions.mjs';
import { createHeadingStore } from './heading-review.mjs';
import { createProjectCodexSettings } from './project-codex-settings.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(appRoot, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
const confirmedSchemaVersion = '1.10.0';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function serveStatic(req, res, staticDir) {
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (!Object.hasOwn(files, pathname)) throw new RequestError(404, '없는 파일입니다.');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, '지원하지 않는 요청입니다.');
  const [file, type] = files[pathname];
  const bytes = await readFile(path.join(staticDir, file));
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

function unavailableInputApp(error, dbPath, staticDir) {
  const server = http.createServer(async (req, res) => {
    try {
      if (new URL(req.url, 'http://localhost').pathname.startsWith('/api/')) throw error;
      await serveStatic(req, res, staticDir);
    } catch (problem) {
      res.writeHead(problem.status ?? 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: problem.status ? problem.message : '검수 화면을 읽을 수 없습니다.' }));
    }
  });
  return { server, dbPath, source: null, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function loadDocument(jsonPath, rulePath) {
  let bytes, document;
  try { bytes = readFileSync(jsonPath); }
  catch { throw new RequestError(422, '입력 JSON 파일을 읽을 수 없습니다. 파일이 준비되어 있는지 확인하세요.'); }
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { throw new RequestError(422, '입력 파일을 JSON으로 읽을 수 없습니다. Docling에서 내보낸 JSON 파일을 사용하세요.'); }
  if (!isObject(document) || document.schema_name !== 'DoclingDocument') throw new RequestError(422, 'DoclingDocument JSON 형식이 아닙니다.');
  if (!isObject(document.pages) || !Object.keys(document.pages).length) throw new RequestError(422, '표시할 페이지 정보가 없습니다.');
  if (Object.values(document.pages).some(page => !isObject(page) || !Number.isInteger(page.page_no) || page.page_no < 1)) throw new RequestError(422, '페이지 번호를 구분할 수 없어 문서를 열 수 없습니다.');
  for (const collection of ['texts', 'tables', 'pictures']) {
    if (document[collection] !== undefined && !Array.isArray(document[collection])) throw new RequestError(422, '이 문서의 요소 데이터를 현재 화면에서 읽을 수 없습니다.');
  }
  const ruleBytes = readFileSync(rulePath);
  const stages = [...ruleBytes.toString('utf8').matchAll(/^### (\d+)\. (.+)$/gm)].map(match => ({ id: Number(match[1]), name: match[2].trim() })).filter(stage => stage.id >= 2);
  if (stages.length !== 11 || stages.some((stage, index) => stage.id !== index + 2)) throw new Error('규칙의 사용자 검수 단계 2~12를 읽을 수 없습니다.');
  const rawDir = realpathSync(path.dirname(jsonPath));
  const artifactsDir = path.join(rawDir, 'artifacts');
  const assetFiles = new Map();
  const elements = new Map();
  const pages = Object.values(document.pages).sort((a, b) => a.page_no - b.page_no).map(page => {
    if (!isObject(page) || !Number.isInteger(page.page_no) || page.page_no < 1 || elements.has(page.page_no)) throw new RequestError(422, '페이지 번호를 구분할 수 없어 문서를 열 수 없습니다.');
    elements.set(page.page_no, []);
    const candidate = typeof page.image?.uri === 'string' ? path.resolve(rawDir, page.image.uri) : null;
    if (candidate && inside(artifactsDir, candidate) && path.extname(candidate).toLowerCase() === '.png' && existsSync(candidate)) {
      const resolved = realpathSync(candidate);
      if (inside(artifactsDir, resolved)) assetFiles.set(page.page_no, resolved);
    }
    return { number: page.page_no, width: page.size?.width ?? 0, height: page.size?.height ?? 0, imageAvailable: assetFiles.has(page.page_no), imageUrl: `/api/pages/${page.page_no}/image`, textCount: 0, tableCount: 0, pictureCount: 0, previewText: '' };
  });
  const pageMap = new Map(pages.map(page => [page.number, page]));
  for (const collection of ['texts', 'tables', 'pictures']) {
    for (const item of document[collection] ?? []) {
      if (!isObject(item)) continue;
      const seen = new Set();
      for (const prov of Array.isArray(item.prov) ? item.prov : []) {
        if (!isObject(prov)) continue;
        const page = pageMap.get(prov.page_no);
        if (!page) continue;
        const text = typeof item.text === 'string' ? item.text : '';
        elements.get(prov.page_no).push({ ref: typeof item.self_ref === 'string' ? item.self_ref : '', label: typeof item.label === 'string' ? item.label : '', text, bbox: prov.bbox });
        if (seen.has(prov.page_no)) continue;
        seen.add(prov.page_no);
        if (collection === 'texts') {
          page.textCount++;
          if (page.previewText.length < 180 && item.content_layer !== 'furniture') page.previewText += `${text} `;
        } else if (collection === 'tables') page.tableCount++;
        else page.pictureCount++;
      }
    }
  }
  const schemaVersion = typeof document.version === 'string' ? document.version : null;
  const missingImages = pages.filter(page => !page.imageAvailable).map(page => page.number);
  return { pages, pageMap, assetFiles, elements, stages, roleSource: buildRoleSource(document, pageMap), headingHints: Object.fromEntries((document.texts ?? []).map((item, index) => [`#/texts/${index}`, { level: item.level ?? null, marker: item.marker ?? '' }])), readingRoots: { '#/body': document.body?.children ?? [], '#/furniture': document.furniture?.children ?? [] }, suggestionInput: extractPageInput(document), sourceHash: hash(bytes), ruleHash: hash(ruleBytes),
    metadata: { name: typeof document.name === 'string' ? document.name : path.basename(jsonPath), originalFile: typeof document.origin?.filename === 'string' ? document.origin.filename : null, schemaName: document.schema_name, schemaVersion, converterVersion: null, sourceFile: path.relative(workspace, jsonPath).replaceAll('\\', '/'), ruleVersion: 'v0.1', pageCount: pages.length, textCount: document.texts?.length ?? 0, tableCount: document.tables?.length ?? 0, pictureCount: document.pictures?.length ?? 0,
      input: { readable: true, versionConfirmed: schemaVersion === confirmedSchemaVersion, confirmedSchemaVersion, missingImages } } };
}

export function createReviewApp(options = {}) {
  const projectDir = path.resolve(options.projectDir ?? path.join(workspace, 'working-project/ieee-1547'));
  const jsonPath = path.resolve(options.jsonPath ?? path.join(projectDir, 'raw/ieee1547-document.json'));
  const rulePath = path.resolve(options.rulePath ?? path.join(workspace, 'docs/rules/document-review-v0.1.md'));
  const dbPath = path.resolve(options.dbPath ?? path.join(projectDir, 'inspection/review.sqlite'));
  const staticDir = path.resolve(options.staticDir ?? path.resolve(appRoot, process.env.CANDOC_BUILD_DIR ?? 'dist'));
  if (inside(path.join(projectDir, 'raw'), dbPath) || inside(path.dirname(jsonPath), dbPath) || dbPath === jsonPath) throw new Error('검수 DB는 원본 raw 폴더 밖에 저장해야 합니다.');
  let source;
  try { source = loadDocument(jsonPath, rulePath); }
  catch (error) { if (error.status === 422) return unavailableInputApp(error, dbPath, staticDir); throw error; }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY, source_hash TEXT NOT NULL, rule_hash TEXT NOT NULL,
      active_stage INTEGER NOT NULL DEFAULT 2, selected_page INTEGER NOT NULL, page_filter TEXT NOT NULL DEFAULT 'all',
      selected_pages TEXT NOT NULL DEFAULT '[]', panel_visible INTEGER NOT NULL DEFAULT 0, thumbnail_size INTEGER NOT NULL DEFAULT 240,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(source_hash, rule_hash));
    CREATE TABLE IF NOT EXISTS page_decisions (
      review_id INTEGER NOT NULL REFERENCES reviews(id), page_no INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(status IN ('unreviewed','included','excluded','pending')),
      reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', updated_at TEXT,
      PRIMARY KEY(review_id, page_no));
    CREATE TABLE IF NOT EXISTS stage_reviews (
      review_id INTEGER NOT NULL REFERENCES reviews(id), stage_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','needs_review')),
      note TEXT NOT NULL DEFAULT '', completed_at TEXT, PRIMARY KEY(review_id, stage_id));
    CREATE TABLE IF NOT EXISTS review_impacts (
      id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), stage_id INTEGER NOT NULL,
      page_no INTEGER NOT NULL, affected_pages TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);`);
  const reviewColumns = new Set(db.prepare('PRAGMA table_info(reviews)').all().map(column => column.name));
  for (const [name, definition] of [['selected_pages', "TEXT NOT NULL DEFAULT '[]'"], ['panel_visible', 'INTEGER NOT NULL DEFAULT 0'], ['thumbnail_size', 'INTEGER NOT NULL DEFAULT 240']]) {
    if (!reviewColumns.has(name)) db.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${definition}`);
  }
  const now = () => new Date().toISOString();
  const codexSettings = createProjectCodexSettings({ db, cwd: workspace, modelRunner: options.codexModelRunner ?? options.roleModelRunner ?? options.headingModelRunner, fail: (status, message) => { throw new RequestError(status, message); } });
  let review = db.prepare('SELECT * FROM reviews WHERE source_hash = ? AND rule_hash = ?').get(source.sourceHash, source.ruleHash);
  if (!review) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = db.prepare('INSERT INTO reviews(source_hash, rule_hash, selected_page, updated_at) VALUES (?, ?, ?, ?)').run(source.sourceHash, source.ruleHash, source.pages[0].number, now());
      const id = Number(inserted.lastInsertRowid);
      const pageInsert = db.prepare('INSERT INTO page_decisions(review_id, page_no) VALUES (?, ?)');
      for (const page of source.pages) pageInsert.run(id, page.number);
      const stageInsert = db.prepare('INSERT INTO stage_reviews(review_id, stage_id) VALUES (?, ?)');
      for (const stage of source.stages) stageInsert.run(id, stage.id);
      db.exec('COMMIT');
      review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const reviewId = review.id;
  const fail = (status, message) => { throw new RequestError(status, message); };
  let readingStore, headingStore;
  const roleStore = createRoleStore({ db, reviewId, source, now, fail, onChange: pages => { readingStore?.invalidatePages(pages); headingStore?.invalidatePages(pages); } });
  const roleQuestions = createRoleQuestionStore({ db, reviewId, source, roleStore, now, fail });
  const roleAnnotations = createRoleAnnotationStore({ db, reviewId, source, roleStore, now, fail });
  readingStore = createReadingStore({ db, reviewId, source, roleStore, now, fail, onChange: pages => headingStore?.invalidatePages(pages) });
  headingStore = createHeadingStore({ db, reviewId, source, roleStore, readingStore, now, fail });
  const baseline = new Map([jsonPath, rulePath].map(file => [file, statSync(file)]));
  function assertInputUnchanged() {
    for (const [file, previous] of baseline) {
      const current = statSync(file);
      if (current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) {
        if (hash(readFileSync(file)) !== (file === jsonPath ? source.sourceHash : source.ruleHash)) throw new RequestError(409, '입력 문서 또는 규칙이 바뀌었습니다. 서버를 다시 시작하여 새 검수 세션을 여세요.');
        baseline.set(file, current);
      }
    }
  }
  function snapshot() {
    const state = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
    const decisions = db.prepare('SELECT page_no AS page, status, reason, note, evidence, updated_at AS updatedAt FROM page_decisions WHERE review_id = ? ORDER BY page_no').all(reviewId);
    const impacts = db.prepare('SELECT stage_id AS stage, page_no AS page, affected_pages AS affectedPages, created_at AS createdAt FROM review_impacts WHERE review_id = ? AND resolved_at IS NULL ORDER BY id').all(reviewId).map(impact => ({ ...impact, affectedPages: JSON.parse(impact.affectedPages) }));
    const stages = db.prepare('SELECT stage_id AS id, status, note, completed_at AS completedAt FROM stage_reviews WHERE review_id = ? AND stage_id >= 2 ORDER BY stage_id').all(reviewId).map(stage => ({ ...stage, name: source.stages.find(item => item.id === stage.id).name }));
    return { revision: state.revision, activeStage: state.active_stage === 1 ? 0 : state.active_stage, selectedPage: state.selected_page, selectedPages: JSON.parse(state.selected_pages), panelVisible: !!state.panel_visible, thumbnailSize: state.thumbnail_size, filter: state.page_filter, updatedAt: state.updated_at, sourceHash: source.sourceHash, decisions, stages, impacts, roleReviews: roleStore.records(), roleCoverage: roleStore.coverage(), roleUndo: roleStore.undo(), ...readingStore.snapshot(), readingCoverage: readingStore.coverage(), ...headingStore.records(), headingCoverage: headingStore.coverage(), headingUndo: headingStore.undo() };
  }
  function mutate(body, operation) {
    if (!Number.isInteger(body.revision)) throw new RequestError(400, '검수 기록의 revision이 필요합니다.');
    assertInputUnchanged();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT revision FROM reviews WHERE id = ?').get(reviewId);
      if (current.revision !== body.revision) throw new RequestError(409, '다른 화면에서 검수 기록이 변경되었습니다. 최신 기록을 불러온 후 다시 적용하세요.');
      operation();
      db.prepare('UPDATE reviews SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), reviewId);
      db.exec('COMMIT');
      return snapshot();
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const validStage = value => Number.isInteger(value) && source.stages.some(stage => stage.id === value);
  const textField = (body, key) => {
    if (typeof body[key] !== 'string' || body[key].length > 10000) throw new RequestError(400, `${key}는 10,000자 이하의 문자열이어야 합니다.`);
    return body[key].trim();
  };
  function scopeImpact(pageNo) {
    const index = source.pages.findIndex(page => page.number === pageNo);
    const affectedPages = source.pages.slice(Math.max(0, index - 1), index + 2).map(page => page.number);
    const items = affectedPages.flatMap(page => source.elements.get(page));
    const stages = new Set([3, 4, 11, 12]);
    if (items.some(item => item.label === 'section_header' || item.label === 'title')) stages.add(5);
    if (items.some(item => /caption|footnote|table|picture/.test(item.label))) stages.add(6);
    if (items.some(item => /text|paragraph|footnote/.test(item.label))) stages.add(7);
    if (items.some(item => item.label === 'list_item')) stages.add(8);
    if (items.some(item => /table|picture/.test(item.label))) stages.add(9);
    if (items.some(item => item.text)) stages.add(10);
    for (const stage of stages) {
      const status = db.prepare('SELECT status FROM stage_reviews WHERE review_id = ? AND stage_id = ?').get(reviewId, stage).status;
      if (status === 'pending') continue;
      db.prepare("UPDATE stage_reviews SET status = 'needs_review' WHERE review_id = ? AND stage_id = ?").run(reviewId, stage);
      db.prepare('INSERT INTO review_impacts(review_id, stage_id, page_no, affected_pages, created_at) VALUES (?, ?, ?, ?, ?)').run(reviewId, stage, pageNo, JSON.stringify(affectedPages), now());
    }
  }
  function decisionPayload(body, pages) {
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > source.pages.length || new Set(pages).size !== pages.length || pages.some(page => !Number.isInteger(page) || !source.pageMap.has(page))) throw new RequestError(400, '유효한 원본 페이지를 중복 없이 선택하세요.');
    if (!['included', 'excluded', 'pending'].includes(body.status)) throw new RequestError(400, '포함·제외·보류 중 하나를 선택하세요.');
    const reason = textField(body, 'reason'); const note = textField(body, 'note');
    if (body.status !== 'included' && !reason) throw new RequestError(400, '제외 또는 보류 사유가 필요합니다.');
    if (!['page_image', 'json', 'both', 'selection'].includes(body.evidence) || (body.evidence === 'selection' && body.status !== 'included') || (['page_image', 'both'].includes(body.evidence) && pages.some(page => !source.assetFiles.has(page)))) throw new RequestError(400, '사용한 판단 근거를 선택하세요.');
    return { reason, note };
  }
  function applyDecisions(body, pages, reason, note) {
    for (const page of pages) {
      const old = db.prepare('SELECT status FROM page_decisions WHERE review_id = ? AND page_no = ?').get(reviewId, page);
      db.prepare('UPDATE page_decisions SET status = ?, reason = ?, note = ?, evidence = ?, updated_at = ? WHERE review_id = ? AND page_no = ?').run(body.status, reason, note, body.evidence, now(), reviewId, page);
      if (old.status !== body.status) {
        roleStore.invalidatePage(page);
        readingStore.invalidatePages([page]);
        headingStore.invalidatePages([page]);
        scopeImpact(page);
        db.prepare("UPDATE stage_reviews SET status = 'pending', completed_at = NULL WHERE review_id = ? AND stage_id = 2").run(reviewId);
      }
    }
  }
  async function bodyOf(req) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new RequestError(413, '요청이 너무 큽니다.'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
    catch { throw new RequestError(400, '올바른 JSON 요청이 필요합니다.'); }
  }
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  let headingJob = { id: null, status: 'idle', suggestions: [], error: null }, headingController, headingTask;
  let annotationController, annotationTask;
  let suggestionJob = { id: null, status: 'idle', sourceHash: source.sourceHash, ruleHash: source.ruleHash, suggestions: [], error: null };
  let suggestionController;
  let suggestionTask = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    try {
      // Only this loopback app may submit mutations; do not accept cross-site form requests.
      if (req.headers.host !== `127.0.0.1:${server.address().port}` && req.headers.host !== `localhost:${server.address().port}`) throw new RequestError(403, '로컬 검수 주소로 접속하세요.');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'application/json 요청이 필요합니다.');
        if (req.headers.origin && ![`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`].includes(req.headers.origin)) throw new RequestError(403, '같은 검수 화면에서 요청하세요.');
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/project/codex') {
        if (req.method === 'GET') return send(res, 200, codexSettings.snapshot());
        if (req.method === 'PUT') return send(res, 200, codexSettings.save(await bodyOf(req)));
        throw new RequestError(405, '지원하지 않는 설정 요청입니다.');
      }
      if (pathname === '/api/project/codex/check' && req.method === 'POST') {
        if (Object.keys(await bodyOf(req)).length) throw new RequestError(400, '연결 확인 요청은 빈 객체여야 합니다.');
        const value = await codexSettings.check(); return send(res, value.connection.status === 'connected' ? 200 : 503, value);
      }
      if (req.method === 'GET' && pathname === '/api/document') { assertInputUnchanged(); return send(res, 200, { ...source.metadata, sourceHash: source.sourceHash, ruleHash: source.ruleHash, pages: source.pages, storageFile: path.relative(workspace, dbPath).replaceAll('\\', '/') }); }
      if (req.method === 'GET' && pathname === '/api/review') { assertInputUnchanged(); return send(res, 200, snapshot()); }
      if (req.method === 'GET' && ['/api/heading-models', '/api/role-models'].includes(pathname)) {
        try { return send(res, 200, { models: await (pathname === '/api/role-models' ? options.roleModelRunner ?? listHeadingModels : options.headingModelRunner ?? listHeadingModels)({ cwd: workspace }) }); } catch (error) { throw new RequestError(503, error.message); }
      }
      if (pathname === '/api/role-annotations' && req.method === 'GET') { assertInputUnchanged(); return send(res, 200, roleAnnotations.snapshot()); }
      if (pathname === '/api/review/role-annotations' && req.method === 'PUT') {
        const body = await bodyOf(req); return send(res, 200, mutate(body, () => roleAnnotations.create(body)));
      }
      if (pathname === '/api/review/role-annotation-apply' && req.method === 'PUT') {
        const body = await bodyOf(req); return send(res, 200, mutate(body, () => roleAnnotations.saveSuggestion(body)));
      }
      if (pathname === '/api/review/role-annotation-suggestions') {
        assertInputUnchanged();
        if (req.method === 'POST') {
          const rawBody = await bodyOf(req), body = { ...rawBody, ...codexSettings.resolve(rawBody) }, { job, input } = roleAnnotations.createJob(body);
          const controller = new AbortController(); annotationController = controller;
          annotationTask = Promise.resolve().then(async () => {
            try {
              const output = await (options.roleAnnotationRunner ?? runAnnotationSuggestions)({ context: input, cwd: workspace, signal: controller.signal, model: body.model, effort: body.effort });
              if (controller.signal.aborted) { job.status = 'cancelled'; return; }
              assertInputUnchanged();
              job.suggestions = validateAnnotationSuggestions({ suggestions: output.map(group => ({ reason: group.reason, region: group.changes[0]?.after.region, role: group.changes[0]?.after.role, refs: group.changes.map(change => change.ref) })) }, input);
              job.status = 'completed';
            } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = controller.signal.aborted ? null : error.message; }
            finally { roleAnnotations.persistJob(job); }
          });
          return send(res, 202, job);
        }
        if (req.method === 'DELETE') {
          const body = await bodyOf(req), job = roleAnnotations.snapshot().jobs.find(job => job.status === 'running');
          if (!job || job.id !== body.id) throw new RequestError(409, '현재 생성 중인 영역 추천 ID가 아닙니다.');
          annotationController?.abort(); await annotationTask; return send(res, 200, roleAnnotations.snapshot());
        }
        throw new RequestError(405, '지원하지 않는 영역 추천 요청입니다.');
      }
      if (pathname === '/api/review/heading-suggestions/preview' && req.method === 'POST') {
        const body = await bodyOf(req); assertInputUnchanged();
        if (headingJob.status !== 'completed' || body.id !== headingJob.id || body.revision !== snapshot().revision || headingJob.revision !== body.revision || headingJob.sourceHash !== source.sourceHash || headingJob.ruleHash !== source.ruleHash) throw new RequestError(409, '문서/검수 버전이 바뀐 추천입니다. 새 추천을 요청하세요.');
        const group = headingJob.suggestions.find(group => group.id === body.groupId);
        if (!group || !Array.isArray(body.exceptions) || new Set(body.exceptions).size !== body.exceptions.length || body.exceptions.some(ref => !group.changes.some(change => change.ref === ref))) throw new RequestError(400, '추천 묶음과 대상 예외를 확인하세요.');
        const context = headingStore.context(), items = group.changes.filter(change => !body.exceptions.includes(change.ref)).map(change => change.after);
        if (!items.length) throw new RequestError(400, '승인할 추천 대상이 없습니다.');
        try { validateHeadingSuggestions({ suggestions: [{ reason: group.reason, changes: items.map(({ ref,isHeading,level,parentRef,sectionNumber }) => ({ ref,isHeading,level,parentRef,sectionNumber })) }] }, context); } catch (error) { throw new RequestError(400, error.message); }
        return send(res, 200, { items, revision: headingJob.revision });
      }
      if (pathname === '/api/review/heading-suggestions') {
        assertInputUnchanged();
        if (req.method === 'GET') return send(res, 200, { ...headingJob, stale: headingJob.revision !== undefined && headingJob.revision !== snapshot().revision });
        if (req.method === 'POST') {
          const rawBody = await bodyOf(req), body = { ...rawBody, ...codexSettings.resolve(rawBody) };
          if (headingJob.status === 'running') throw new RequestError(409, '제목 추천을 생성 중입니다.');
          if (typeof body.model !== 'string' || !body.model || typeof body.effort !== 'string' || !body.effort || body.revision !== snapshot().revision) throw new RequestError(400, '현재 버전과 모델/Reasoning effort를 선택하세요.');
          const context = headingStore.context(), job = { id: randomUUID(), status: 'running', sourceHash: source.sourceHash, ruleHash: source.ruleHash, revision: body.revision, model: body.model, effort: body.effort, suggestions: [], error: null };
          headingController = new AbortController(); headingJob = job;
          headingTask = Promise.resolve().then(async () => {
            try {
              const output = await (options.headingSuggestionRunner ?? runHeadingSuggestions)({ context, cwd: workspace, signal: headingController.signal, model: body.model, effort: body.effort });
              if (headingController.signal.aborted) { job.status = 'cancelled'; return; }
              assertInputUnchanged();
              job.suggestions = validateHeadingSuggestions({ suggestions: output.map(group => ({ reason: group.reason, changes: group.changes.map(change => { const row = change.after ?? change; return { ref: row.ref, isHeading: row.isHeading, level: row.level, parentRef: row.parentRef, sectionNumber: row.sectionNumber }; }) })) }, context);
              job.status = 'completed';
            } catch (error) { job.status = headingController.signal.aborted ? 'cancelled' : 'failed'; job.error = headingController.signal.aborted ? null : error.message; }
          });
          return send(res, 202, job);
        }
        if (req.method === 'DELETE') { const body = await bodyOf(req); if (body.id !== headingJob.id) throw new RequestError(409, '현재 제목 추천 ID가 아닙니다.'); headingController?.abort(); await headingTask; return send(res, 200, headingJob); }
        throw new RequestError(405, '지원하지 않는 제목 추천 요청입니다.');
      }
      if (req.method === 'GET' && pathname === '/api/heading-review') { assertInputUnchanged(); return send(res, 200, { sourceHash: source.sourceHash, ruleHash: source.ruleHash, ...headingStore.context() }); }
      if (req.method === 'PUT' && pathname === '/api/review/headings') {
        const body = await bodyOf(req);
        return send(res, 200, mutate(body, () => { if (body.action === 'save') headingStore.save(body); else if (body.action === 'restore') headingStore.restore(body.id); else throw new RequestError(400, '제목 저장/복원 작업을 지정하세요.'); }));
      }
      if (req.method === 'GET' && pathname === '/api/reading-review') { assertInputUnchanged(); return send(res, 200, { sourceHash: source.sourceHash, ruleHash: source.ruleHash, ...readingStore.context() }); }
      if (req.method === 'PUT' && ['/api/review/reading-order', '/api/review/page-connections'].includes(pathname)) {
        const body = await bodyOf(req);
        return send(res, 200, mutate(body, () => pathname.endsWith('reading-order') ? readingStore.saveOrder(body) : readingStore.saveBoundary(body)));
      }
      if (pathname === '/api/role-elements' && req.method === 'GET') { assertInputUnchanged(); return send(res, 200, { sourceHash: source.sourceHash, ruleHash: source.ruleHash, items: source.roleSource.items, targets: source.roleSource.targets, groups: source.roleSource.groups }); }
      if (pathname === '/api/review/roles' && req.method === 'PUT') {
        const body = await bodyOf(req);
        return send(res, 200, mutate(body, () => roleStore.save(body)));
      }
      if (pathname === '/api/role-questions' && req.method === 'GET') {
        assertInputUnchanged();
        return send(res, 200, roleQuestions.context());
      }
      if (pathname === '/api/review/role-questions' && req.method === 'PUT') {
        const body = await bodyOf(req);
        return send(res, 200, mutate(body, () => roleQuestions.answer(body)));
      }
      if (pathname === '/api/review/role-page-check' && req.method === 'PUT') {
        const body = await bodyOf(req);
        return send(res, 200, mutate(body, () => roleQuestions.confirmPage(body)));
      }
      if (pathname === '/api/review/role-groups' && req.method === 'PUT') {
        const body = await bodyOf(req);
        return send(res, 200, mutate(body, () => roleStore.batch(body)));
      }
      if (pathname === '/api/review/page-suggestions') {
        assertInputUnchanged();
        if (req.method === 'GET') return send(res, 200, suggestionJob);
        if (req.method === 'POST') {
          const body = await bodyOf(req);
          if (Object.keys(body).length) throw new RequestError(400, '추천 시작 요청은 빈 객체여야 합니다.');
          if (suggestionJob.status === 'running') throw new RequestError(409, '이미 페이지 추천을 실행하고 있습니다.');
          const { model, effort } = codexSettings.resolve();
          const job = { id: randomUUID(), status: 'running', sourceHash: source.sourceHash, ruleHash: source.ruleHash, model: model ?? null, effort: effort ?? null, suggestions: [], error: null };
          const controller = new AbortController();
          suggestionJob = job; suggestionController = controller;
          suggestionTask = Promise.resolve().then(async () => {
            try {
              const suggestions = await (options.suggestionRunner ?? runCodexSuggestions)({ pages: source.suggestionInput, cwd: workspace, signal: controller.signal, selectedModel: model, selectedEffort: effort });
              if (controller.signal.aborted) { job.status = 'cancelled'; return; }
              assertInputUnchanged();
              job.suggestions = validateSuggestions({ suggestions }, source.pages.map(page => page.number));
              job.status = 'completed';
            } catch (error) {
              job.status = controller.signal.aborted ? 'cancelled' : 'failed';
              job.error = controller.signal.aborted ? null : error.message;
            }
          });
          return send(res, 202, job);
        }
        if (req.method === 'DELETE') {
          const body = await bodyOf(req);
          if (Object.keys(body).length !== 1 || typeof body.id !== 'string') throw new RequestError(400, '취소할 추천 요청 ID가 필요합니다.');
          if (body.id !== suggestionJob.id) throw new RequestError(409, '현재 추천 요청과 일치하지 않습니다.');
          if (suggestionJob.status === 'running') { suggestionController.abort(); await suggestionTask; }
          return send(res, 200, suggestionJob);
        }
        throw new RequestError(405, '지원하지 않는 추천 요청입니다.');
      }
      const pageMatch = pathname.match(/^\/api\/pages\/(\d+)(\/image)?$/);
      if (req.method === 'GET' && pageMatch) {
        const number = Number(pageMatch[1]);
        if (!source.pageMap.has(number)) throw new RequestError(404, '없는 원본 페이지입니다.');
        if (!pageMatch[2]) return send(res, 200, { page: number, elements: source.elements.get(number) });
        const file = source.assetFiles.get(number);
        if (!file) throw new RequestError(404, '이 페이지의 원문 이미지가 없습니다.');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); res.end(await readFile(file)); return;
      }
      if (req.method === 'PUT' && pathname === '/api/review/navigation') {
        const body = await bodyOf(req);
        if (!(body.stage === 0 || validStage(body.stage)) || !source.pageMap.has(body.selectedPage) || !['all', 'unreviewed', 'included', 'excluded', 'pending'].includes(body.filter)) throw new RequestError(400, '이동할 화면·페이지·필터가 올바르지 않습니다.');
        if (body.selectedPages !== undefined && (!Array.isArray(body.selectedPages) || new Set(body.selectedPages).size !== body.selectedPages.length || body.selectedPages.some(page => !Number.isInteger(page) || !source.pageMap.has(page)))) throw new RequestError(400, '선택 페이지 목록이 올바르지 않습니다.');
        if (body.panelVisible !== undefined && typeof body.panelVisible !== 'boolean') throw new RequestError(400, '상세 패널 설정이 올바르지 않습니다.');
        if (body.thumbnailSize !== undefined && (!Number.isInteger(body.thumbnailSize) || body.thumbnailSize < 120 || body.thumbnailSize > 360)) throw new RequestError(400, '썸네일 크기는 120~360px 사이여야 합니다.');
        return send(res, 200, mutate(body, () => {
          const current = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
          db.prepare('UPDATE reviews SET active_stage = ?, selected_page = ?, page_filter = ?, selected_pages = ?, panel_visible = ?, thumbnail_size = ? WHERE id = ?').run(body.stage, body.selectedPage, body.filter, body.selectedPages === undefined ? current.selected_pages : JSON.stringify(body.selectedPages), body.panelVisible === undefined ? current.panel_visible : Number(body.panelVisible), body.thumbnailSize ?? current.thumbnail_size, reviewId);
        }));
      }
      if (req.method === 'PUT' && pathname === '/api/review/pages') {
        const body = await bodyOf(req);
        const { reason, note } = decisionPayload(body, body.pages);
        return send(res, 200, mutate(body, () => applyDecisions(body, body.pages, reason, note)));
      }
      const decisionMatch = pathname.match(/^\/api\/review\/pages\/(\d+)$/);
      if (req.method === 'PUT' && decisionMatch) {
        const body = await bodyOf(req); const page = Number(decisionMatch[1]);
        const { reason, note } = decisionPayload(body, [page]);
        return send(res, 200, mutate(body, () => applyDecisions(body, [page], reason, note)));
      }
      const stageMatch = pathname.match(/^\/api\/review\/stages\/(\d+)$/);
      if (req.method === 'PUT' && stageMatch) {
        const body = await bodyOf(req); const stage = Number(stageMatch[1]); const note = textField(body, 'note');
        if (!validStage(stage) || !['complete', 'reopen', 'save_note'].includes(body.action)) throw new RequestError(400, '검수 단계와 기록 작업이 올바르지 않습니다.');
        if (body.includeUnreviewed !== undefined && (typeof body.includeUnreviewed !== 'boolean' || (body.includeUnreviewed && (stage !== 2 || body.action !== 'complete')))) throw new RequestError(400, '나머지 페이지 유지는 페이지 선별 완료에서만 지정할 수 있습니다.');
        return send(res, 200, mutate(body, () => {
          if (body.action === 'complete') {
            if (stage === 3 || stage === 12) { roleStore.assertComplete(); roleQuestions.assertComplete(); }
            if (stage === 4 || stage === 12) readingStore.assertComplete();
            if (stage === 5 || stage === 12) headingStore.assertComplete();
            if (stage === 2 && body.includeUnreviewed) {
              const pending = db.prepare("SELECT count(*) AS count FROM page_decisions WHERE review_id = ? AND status = 'pending'").get(reviewId).count;
              if (pending) throw new RequestError(400, `보류 페이지 ${pending}개를 먼저 확인하세요.`);
              const remaining = db.prepare("SELECT page_no, reason, note, evidence FROM page_decisions WHERE review_id = ? AND status = 'unreviewed' ORDER BY page_no").all(reviewId);
              for (const page of remaining) applyDecisions({ status: 'included', evidence: page.evidence || 'selection' }, [page.page_no], page.reason || '페이지 선별 완료에서 제외하지 않은 페이지를 유지하기로 결정함.', page.note);
            }
            const incomplete = db.prepare("SELECT count(*) AS count FROM page_decisions WHERE review_id = ? AND status IN ('unreviewed','pending')").get(reviewId).count;
            if ((stage === 2 || stage === 12) && incomplete) throw new RequestError(400, `미검수·보류 페이지 ${incomplete}개가 남아 있습니다.`);
            if (stage === 12 && db.prepare("SELECT count(*) AS count FROM stage_reviews WHERE review_id = ? AND stage_id >= 2 AND stage_id < 12 AND status <> 'completed'").get(reviewId).count) throw new RequestError(400, '이전 단계의 미완료·재검토 사항을 먼저 확인하세요.');
            if (stage !== 2 && !note) throw new RequestError(400, '수동 검토 완료의 범위와 근거를 기록하세요.');
            db.prepare("UPDATE stage_reviews SET status = 'completed', note = ?, completed_at = ? WHERE review_id = ? AND stage_id = ?").run(note, now(), reviewId, stage);
            db.prepare('UPDATE review_impacts SET resolved_at = ? WHERE review_id = ? AND stage_id = ? AND resolved_at IS NULL').run(now(), reviewId, stage);
          } else if (body.action === 'reopen') {
            db.prepare("UPDATE stage_reviews SET status = 'pending', note = ?, completed_at = NULL WHERE review_id = ? AND stage_id = ?").run(note, reviewId, stage);
            // Final result cannot remain completed when any contributing stage is reopened.
            if (stage < 12) db.prepare("UPDATE stage_reviews SET status = 'pending', completed_at = NULL WHERE review_id = ? AND stage_id = 12").run(reviewId);
          } else db.prepare('UPDATE stage_reviews SET note = ? WHERE review_id = ? AND stage_id = ?').run(note, reviewId, stage);
        }));
      }
      if (pathname.startsWith('/api/')) throw new RequestError(404, '지원하지 않는 API입니다.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, '지원하지 않는 요청입니다.');
      await serveStatic(req, res, staticDir);
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, { error: error.status ? error.message : '파일 또는 검수 기록을 읽는 중 문제가 발생했습니다.' });
      else res.end();
      if (!error.status) console.error(error);
    }
  });
  return { server, dbPath, source, close: async () => {
    await codexSettings.close();
    annotationController?.abort(); await annotationTask;
    headingController?.abort(); await headingTask;
    suggestionController?.abort();
    await suggestionTask;
    await new Promise((resolve, reject) => server.close(error => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (dbError) { reject(dbError); return; } error ? reject(error) : resolve(); }));
  } };
}
