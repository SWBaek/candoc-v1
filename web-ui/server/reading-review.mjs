import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function inspectReadingTree(source) {
  const nodes = new Map(source.roleSource.items.map(item => [item.ref, item]));
  for (const [ref, children] of Object.entries(source.readingRoots ?? {})) nodes.set(ref, { children });
  const childRefs = ref => (nodes.get(ref)?.children ?? []).map(child => typeof child === 'string' ? child : child?.$ref);
  const descendants = roots => {
    const found = new Set(), pending = [...roots];
    while (pending.length) { const ref = pending.pop(); if (!nodes.has(ref) || found.has(ref)) continue; found.add(ref); pending.push(...childRefs(ref)); }
    return [...found].filter(ref => !['#/body', '#/furniture'].includes(ref));
  };
  const diagnostics = [], visited = new Map(), treeOrder = new Map(), reached = new Set();
  function visit(ref, path, reachable) {
    const parentRef = path.at(-1) ?? '', fullPath = [...path, ref ?? '(missing $ref)'];
    if (!nodes.has(ref)) { diagnostics.push({ kind: 'missing', ref: ref ?? '', parentRef, path: fullPath, affectedRefs: descendants([parentRef]) }); return; }
    if (path.includes(ref)) { diagnostics.push({ kind: 'cycle', ref, parentRef, path: fullPath, affectedRefs: descendants([...path.slice(path.indexOf(ref)), ref]) }); return; }
    if (visited.has(ref)) { const firstPath = visited.get(ref); diagnostics.push({ kind: 'duplicate', ref, parentRef, path: fullPath, firstPath, affectedRefs: descendants([ref, parentRef, firstPath.at(-2)]) }); return; }
    visited.set(ref, fullPath);
    if (reachable) { reached.add(ref); if (!ref.startsWith('#/groups/') && !['#/body', '#/furniture'].includes(ref)) treeOrder.set(ref, treeOrder.size); }
    for (const child of childRefs(ref)) visit(child, fullPath, reachable);
  }
  visit('#/body', [], true); visit('#/furniture', [], true);
  for (const item of source.roleSource.items) if (!reached.has(item.ref)) diagnostics.push({ kind: 'unreachable', ref: item.ref, parentRef: item.parentRef, path: [], affectedRefs: descendants([item.ref]) });
  // Also diagnose malformed components disconnected from either root, without
  // assigning them any source sequence index.
  for (const item of source.roleSource.items) if (!visited.has(item.ref)) visit(item.ref, [], false);
  const affected = new Set(diagnostics.flatMap(diagnostic => diagnostic.affectedRefs));
  for (const ref of affected) treeOrder.delete(ref);
  return { treeOrder, diagnostics };
}

export function createReadingStore({ db, reviewId, source, roleStore, now, fail, onChange = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS order_reviews (
    review_id INTEGER NOT NULL REFERENCES reviews(id), scope_id TEXT NOT NULL, page_no INTEGER NOT NULL,
    payload TEXT NOT NULL, dependency_hash TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(review_id, scope_id));
    CREATE TABLE IF NOT EXISTS boundary_reviews (
    review_id INTEGER NOT NULL REFERENCES reviews(id), boundary_id TEXT NOT NULL, left_page INTEGER NOT NULL, right_page INTEGER NOT NULL,
    payload TEXT NOT NULL, dependency_hash TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(review_id, boundary_id));`);
  const items = source.roleSource.items.filter(item => !item.ref.startsWith('#/groups/'));
  const itemMap = new Map(source.roleSource.items.map(item => [item.ref, item]));
  const { treeOrder, diagnostics } = inspectReadingTree(source);
  const occurrences = items.flatMap(item => item.provenance.length ? item.provenance.map((prov, index) => ({ id: `${item.ref}@${index}`, ref: item.ref, page: source.pageMap.has(prov.page) ? prov.page : 0, provIndex: index, rect: prov.rect, sourceIndex: treeOrder.get(item.ref) ?? null })) : [{ id: `${item.ref}@unlocated`, ref: item.ref, page: 0, provIndex: null, rect: null, sourceIndex: treeOrder.get(item.ref) ?? null }]);
  const occurrenceMap = new Map(occurrences.map(item => [item.id, item]));
  const rows = table => db.prepare(`SELECT * FROM ${table} WHERE review_id = ? ORDER BY updated_at, rowid`).all(reviewId).map(row => ({ id: row.scope_id ?? row.boundary_id, ...JSON.parse(row.payload), dependencyHash: row.dependency_hash, needsReview: !!row.needs_review, updatedAt: row.updated_at }));
  function context() {
    const decisions = db.prepare('SELECT page_no AS page, status, updated_at AS updatedAt FROM page_decisions WHERE review_id = ? ORDER BY page_no').all(reviewId);
    const kept = decisions.filter(row => row.status !== 'excluded'), excluded = new Set(decisions.filter(row => row.status === 'excluded').map(row => row.page));
    const roleMap = new Map(roleStore.records().map(row => [row.ref, row]));
    const active = occurrences.filter(item => !excluded.has(item.page));
    const byKey = new Map();
    for (const occurrence of active) {
      const item = itemMap.get(occurrence.ref), role = roleMap.get(item.ref);
      const region = role?.region ?? 'unknown', parentRef = role?.parentRef || item.parentRef;
      // A region can span several column containers. Keep those memberships as
      // evidence, while allowing review of their combined reading sequence.
      const key = JSON.stringify([occurrence.page, region]);
      let scope = byKey.get(key);
      if (!scope) { scope = { page: occurrence.page, region, parentRef, entries: [] }; byKey.set(key, scope); }
      scope.entries.push(occurrence);
      if (scope.parentRef !== parentRef) scope.parentRef = '여러 소속';
    }
    function dependency(entries, pages) {
      const pendingRefs = [...new Set(entries.filter(occurrence => { const row = roleMap.get(occurrence.ref); return !row || row.needsReview || !['normal', 'error'].includes(row.status) || row.region === 'unknown' || row.role === 'unknown'; }).map(item => item.ref))];
      return { dependencyHash: digest([entries.map(item => { const row = roleMap.get(item.ref); return [item.id, row ? [row.status, row.region, row.role, row.parentRef, row.needsReview] : null]; }), pages.map(page => [page, decisions.find(row => row.page === page)?.status])]), pendingRefs };
    }
    const scopes = [...byKey.values()].map(scope => {
      scope.entries.sort((a, b) => (a.sourceIndex ?? Number.MAX_SAFE_INTEGER) - (b.sourceIndex ?? Number.MAX_SAFE_INTEGER) || (a.provIndex ?? 0) - (b.provIndex ?? 0));
      const originalOrder = scope.entries.map(item => item.id);
      return { ...scope, originalOrder, diagnostics: diagnostics.filter(diagnostic => scope.entries.some(item => diagnostic.affectedRefs.includes(item.ref))), id: digest([scope.page, scope.region, scope.parentRef, [...originalOrder].sort()]).slice(0, 24), sourceOrderKnown: scope.entries.every(item => item.sourceIndex !== null), ...dependency(scope.entries, scope.page ? [scope.page] : []) };
    }).sort((a, b) => a.page - b.page || a.region.localeCompare(b.region) || a.parentRef.localeCompare(b.parentRef));
    const boundaries = kept.slice(0, -1).map((left, index) => {
      const right = kept[index + 1];
      const skippedPages = decisions.filter(row => row.page > left.page && row.page < right.page).map(row => row.page);
      const leftEntries = active.filter(item => item.page === left.page), rightEntries = active.filter(item => item.page === right.page);
      return { id: `${left.page}:${right.page}`, leftPage: left.page, rightPage: right.page, skippedPages, leftEntries, rightEntries, ...dependency([...leftEntries, ...rightEntries], [left.page, right.page, ...skippedPages]) };
    });
    return { scopes, boundaries, items: source.roleSource.items, diagnostics, unsettledPages: kept.filter(row => ['unreviewed', 'pending'].includes(row.status)).map(row => row.page) };
  }
  function snapshot() {
    const current = context();
    const decorate = (records, scopes) => records.map(row => ({ ...row, needsReview: row.needsReview || !scopes.some(scope => scope.id === row.id && scope.dependencyHash === row.dependencyHash) }));
    return { orderReviews: decorate(rows('order_reviews'), current.scopes), boundaryReviews: decorate(rows('boundary_reviews'), current.boundaries) };
  }
  function coverage() {
    const current = context(), saved = snapshot();
    const result = { scopes: current.scopes.length, boundaries: current.boundaries.length, reviewed: 0, unreviewed: 0, needsReview: 0, suspected: 0, dependencyPending: 0, unsettledPages: current.unsettledPages };
    for (const [targets, records] of [[current.scopes, saved.orderReviews], [current.boundaries, saved.boundaryReviews]]) for (const target of targets) {
      const row = records.find(row => row.id === target.id);
      if (target.pendingRefs.length && (!row || row.status !== 'unjudgeable')) result.dependencyPending++;
      if (!row) result.unreviewed++;
      else if (row.needsReview) result.needsReview++;
      else { result.reviewed++; if (row.status === 'suspected') result.suspected++; }
    }
    return result;
  }
  function common(body, target) {
    if (!target) fail(400, '현재 유지 범위의 순서 또는 페이지 경계를 선택하세요.');
    if (!['normal', 'error', 'suspected', 'unjudgeable'].includes(body.status)) fail(400, '검수 판단을 선택하세요.');
    for (const key of ['reason', 'followUp']) if (typeof body[key] !== 'string' || body[key].length > 10000) fail(400, `${key}는 10,000자 이하 문자열이어야 합니다.`);
    if (!body.reason.trim()) fail(400, '순서·연결 판단의 근거와 사유가 필요합니다.');
    if (['suspected', 'unjudgeable'].includes(body.status) && !body.followUp.trim()) fail(400, '의심·판단 불가의 후속 확인이 필요합니다.');
    if (['normal', 'error'].includes(body.status) && target.pendingRefs.length) fail(400, '관련 영역·큰 역할·소속 판단을 먼저 확인하세요. 독립 검토는 의심·판단 불가로 남길 수 있습니다.');
    const pages = target.page !== undefined ? [target.page] : [target.leftPage, target.rightPage];
    if (!['json', 'page_image', 'both'].includes(body.evidence) || (body.evidence !== 'json' && pages.some(page => !source.assetFiles.has(page)))) fail(400, '사용 가능한 대조 근거를 선택하세요.');
    return { status: body.status, reason: body.reason.trim(), evidence: body.evidence, followUp: body.followUp.trim() };
  }
  function markStages(pages) {
    for (let id = 4; id <= 12; id++) {
      const stage = db.prepare('SELECT status FROM stage_reviews WHERE review_id = ? AND stage_id = ?').get(reviewId, id);
      if (!stage || stage.status === 'pending') continue;
      db.prepare("UPDATE stage_reviews SET status = 'needs_review' WHERE review_id = ? AND stage_id = ?").run(reviewId, id);
      db.prepare('INSERT INTO review_impacts(review_id, stage_id, page_no, affected_pages, created_at) VALUES (?, ?, ?, ?, ?)').run(reviewId, id, pages[0] ?? 0, JSON.stringify(pages.filter(Boolean)), now());
    }
  }
  function saveOrder(body) {
    const previous = rows('order_reviews').find(row => row.id === body.id);
    const scope = context().scopes.find(scope => scope.id === body.id), payload = common(body, scope);
    if (!Array.isArray(body.order) || body.order.length !== scope.originalOrder.length || new Set(body.order).size !== body.order.length || body.order.some(id => !scope.originalOrder.includes(id))) fail(400, '현재 영역의 모든 출처를 중복·누락 없이 순서안에 포함하세요.');
    if (body.status === 'normal' && (!scope.sourceOrderKnown || JSON.stringify(body.order) !== JSON.stringify(scope.originalOrder))) fail(400, '원본 순서가 없거나 변경한 순서안은 정상으로 저장할 수 없습니다.');
    if (['normal', 'error'].includes(body.status) && scope.page === 0) fail(400, '출처 없는 항목의 순서는 확정할 수 없습니다.');
    payload.order = body.order;
    db.prepare(`INSERT INTO order_reviews(review_id, scope_id, page_no, payload, dependency_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id, scope_id) DO UPDATE SET payload=excluded.payload, dependency_hash=excluded.dependency_hash, needs_review=0, updated_at=excluded.updated_at`).run(reviewId, scope.id, scope.page, JSON.stringify(payload), scope.dependencyHash, now());
    markStages([scope.page]);
    if (!previous || previous.status !== payload.status || JSON.stringify(previous.order) !== JSON.stringify(payload.order)) onChange([scope.page]);
  }
  function saveBoundary(body) {
    const previous = rows('boundary_reviews').find(row => row.id === body.id);
    const boundary = context().boundaries.find(boundary => boundary.id === body.id), payload = common(body, boundary);
    if (!Array.isArray(body.links) || body.links.length > boundary.leftEntries.length * Math.max(1, boundary.rightEntries.length) || typeof body.noConnection !== 'boolean' || (body.noConnection && body.links.length) || (!body.links.length && !body.noConnection && body.status !== 'unjudgeable')) fail(400, '연결 대상 또는 명시적인 연결 없음을 기록하세요.');
    const pairs = new Set();
    for (const link of body.links) {
      if (!link || !boundary.leftEntries.some(item => item.id === link.from) || !boundary.rightEntries.some(item => item.id === link.to) || !['paragraph', 'table', 'footnote', 'other'].includes(link.kind) || !['continuation', 'separate', 'related', 'unknown'].includes(link.relation)) fail(400, '현재 경계 양쪽의 유효한 출처·연결 유형이 필요합니다.');
      const pair = JSON.stringify([link.from, link.to]); if (pairs.has(pair)) fail(400, '같은 출처 연결을 중복 기록할 수 없습니다.'); pairs.add(pair);
      if (['normal', 'error'].includes(body.status) && link.relation === 'unknown') fail(400, '미확정 연결은 의심·판단 불가로 기록하세요.');
      if (body.status === 'normal' && link.relation === 'continuation') {
        const from = occurrenceMap.get(link.from), to = occurrenceMap.get(link.to), roleMap = new Map(roleStore.records().map(row => [row.ref, row]));
        if (roleMap.get(from.ref)?.region !== roleMap.get(to.ref)?.region) fail(400, '서로 다른 영역의 이어짐을 정상으로 확정할 수 없습니다.');
        if (link.kind === 'table' && ![from, to].every(item => item.ref.startsWith('#/tables/'))) fail(400, '표 이어짐에는 양쪽 표 요소가 필요합니다.');
        if (link.kind === 'paragraph' && ![from, to].every(item => item.ref.startsWith('#/texts/'))) fail(400, '문단 이어짐에는 양쪽 텍스트가 필요합니다.');
        if (link.kind === 'footnote' && ![from, to].every(item => roleMap.get(item.ref)?.role === 'footnote')) fail(400, '각주 이어짐에는 양쪽 각주 역할 확인이 필요합니다.');
      }
    }
    payload.links = body.links.map(({ from, to, kind, relation }) => ({ from, to, kind, relation })); payload.noConnection = body.noConnection;
    db.prepare(`INSERT INTO boundary_reviews(review_id, boundary_id, left_page, right_page, payload, dependency_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id, boundary_id) DO UPDATE SET payload=excluded.payload, dependency_hash=excluded.dependency_hash, needs_review=0, updated_at=excluded.updated_at`).run(reviewId, boundary.id, boundary.leftPage, boundary.rightPage, JSON.stringify(payload), boundary.dependencyHash, now());
    markStages([boundary.leftPage, boundary.rightPage]);
    if (!previous || previous.status !== payload.status || previous.noConnection !== payload.noConnection || JSON.stringify(previous.links) !== JSON.stringify(payload.links)) onChange([boundary.leftPage, boundary.rightPage]);
  }
  function invalidatePages(pages) {
    for (const page of pages.length ? pages : [0]) {
      db.prepare('UPDATE order_reviews SET needs_review = 1 WHERE review_id = ? AND page_no = ?').run(reviewId, page);
      db.prepare('UPDATE boundary_reviews SET needs_review = 1 WHERE review_id = ? AND (left_page = ? OR right_page = ?)').run(reviewId, page, page);
    }
  }
  function assertComplete() {
    roleStore.assertComplete(); const c = coverage();
    if (c.unsettledPages.length || c.unreviewed || c.needsReview || c.suspected || c.dependencyPending) fail(400, `순서·연결 검수의 미검수 ${c.unreviewed}·재검토 ${c.needsReview}·의심 ${c.suspected}·영역 미확정 ${c.dependencyPending}개가 남아 있습니다.`);
  }
  return { context, snapshot, coverage, saveOrder, saveBoundary, invalidatePages, assertComplete };
}
