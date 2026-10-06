import { createHash, randomUUID } from 'node:crypto';
import { inspectReadingTree } from './reading-review.mjs';
import { validateHeadingForest } from './heading-tree.mjs';
export const documentParts = ['cover', 'contents', 'preface', 'body', 'appendix', 'references', 'other', 'mixed', 'unknown'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const structural = row => row ? [row.isHeading, row.level, row.parentRef, row.sectionNumber, row.part, row.position] : [false, null, '', '', '', null];
const semantic = row => row ? [row.status, ...structural(row)] : null;
const normalized = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function createHeadingStore({ db, reviewId, source, roleStore, readingStore, now, fail }) {
  db.exec(`CREATE TABLE IF NOT EXISTS heading_reviews(review_id INTEGER NOT NULL REFERENCES reviews(id), element_ref TEXT NOT NULL, payload TEXT NOT NULL, dependency_hash TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(review_id,element_ref));
    CREATE TABLE IF NOT EXISTS outline_pages(review_id INTEGER NOT NULL REFERENCES reviews(id), page_no INTEGER NOT NULL, payload TEXT NOT NULL, dependency_hash TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(review_id,page_no));
    CREATE TABLE IF NOT EXISTS heading_batches(id TEXT PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), refs TEXT NOT NULL, pages TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, restored INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`);
  const texts = source.roleSource.items.filter(item => item.ref.startsWith('#/texts/'));
  const textMap = new Map(texts.map(item => [item.ref, item]));
  const tree = inspectReadingTree(source);
  const rawRows = (table, key) => db.prepare(`SELECT * FROM ${table} WHERE review_id = ? ORDER BY rowid`).all(reviewId).map(row => ({ [key]: row.element_ref ?? row.page_no, ...JSON.parse(row.payload), dependencyHash: row.dependency_hash, needsReview: !!row.needs_review, updatedAt: row.updated_at }));
  const rawHeadings = () => rawRows('heading_reviews', 'ref');
  const rawPages = () => rawRows('outline_pages', 'page');
  function context(overrides = []) {
    const decisions = db.prepare('SELECT page_no AS page,status FROM page_decisions WHERE review_id = ? ORDER BY page_no').all(reviewId);
    const excluded = new Set(decisions.filter(row => row.status === 'excluded').map(row => row.page));
    const retained = item => !item.pages.length || item.pages.some(page => !excluded.has(page));
    const roles = new Map(roleStore.records().map(row => [row.ref, row]));
    const records = new Map(rawHeadings().map(row => [row.ref, row]));
    for (const row of overrides) records.set(row.ref, { ...row, needsReview: false });
    const reading = readingStore.context(), savedReading = readingStore.snapshot();
    const occurrences = reading.scopes.flatMap(scope => scope.entries).sort((a, b) => (a.page || Number.MAX_SAFE_INTEGER) - (b.page || Number.MAX_SAFE_INTEGER) || (a.sourceIndex ?? Number.MAX_SAFE_INTEGER) - (b.sourceIndex ?? Number.MAX_SAFE_INTEGER) || (a.provIndex ?? 0) - (b.provIndex ?? 0));
    const readingStates = new Map();
    for (const scope of reading.scopes) {
      const row = savedReading.orderReviews.find(row => row.id === scope.id), ids = row?.order ?? scope.originalOrder;
      const slots = occurrences.map((entry, index) => scope.originalOrder.includes(entry.id) ? index : -1).filter(index => index >= 0), entries = new Map(scope.entries.map(entry => [entry.id, entry]));
      if (ids.length === slots.length && ids.every(id => entries.has(id))) slots.forEach((slot, index) => { occurrences[slot] = entries.get(ids[index]); });
      for (const entry of scope.entries) readingStates.set(entry.id, !row || row.needsReview || !['normal', 'error'].includes(row.status) ? 'unconfirmed' : scope.sourceOrderKnown && JSON.stringify(ids) === JSON.stringify(scope.originalOrder) ? 'original' : 'proposal');
    }
    const rank = new Map(); occurrences.forEach(entry => { if (!rank.has(entry.ref)) rank.set(entry.ref, rank.size); });
    const activeTexts = texts.filter(retained);
    function dependencies(items, heading = false) {
      const pages = [...new Set(items.flatMap(item => item.pages.filter(page => !excluded.has(page))))];
      const refs = new Set(items.map(item => item.ref));
      const orders = reading.scopes.filter(scope => scope.entries.some(entry => refs.has(entry.ref)));
      const boundaries = heading ? reading.boundaries.filter(boundary => pages.includes(boundary.leftPage) || pages.includes(boundary.rightPage)) : [];
      const pending = items.filter(item => { const row = roles.get(item.ref); return !row || row.needsReview || !['normal', 'error'].includes(row.status) || row.region === 'unknown' || row.role === 'unknown'; }).map(item => `role:${item.ref}`);
      if (heading) for (const [targets, rows, name] of [[orders, savedReading.orderReviews, 'order'], [boundaries, savedReading.boundaryReviews, 'connection']]) for (const target of targets) {
        const row = rows.find(row => row.id === target.id); if (!row || row.needsReview || !['normal', 'error'].includes(row.status)) pending.push(`${name}:${target.id}`);
      }
      const roleFields = items.map(item => { const row = roles.get(item.ref); return [item.ref, row ? [row.status, row.region, row.role, row.parentRef] : null]; });
      // Reading freshness is a gate, not part of the signature: changing a title
      // invalidates reading without making its own freshly saved record stale.
      const readingFields = heading ? [orders.map(target => [target.id, savedReading.orderReviews.find(row => row.id === target.id)?.order ?? null]), boundaries.map(target => { const row = savedReading.boundaryReviews.find(row => row.id === target.id); return [target.id, row?.links ?? null, row?.noConnection ?? null]; })] : [];
      return { pending, hash: digest([roleFields, pages.map(page => [page, decisions.find(row => row.page === page)?.status]), readingFields]) };
    }
    const allTexts = activeTexts.map(item => {
      const role = roles.get(item.ref), hints = [];
      if (['section_header', 'title'].includes(item.label)) hints.push('원본 제목 라벨');
      if (role?.role === 'title') hints.push('3단계 제목 역할');
      const numberHint = item.text.match(/^\s*((?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)*\.?|Annex\s+[A-Z]))\s+/i)?.[1] ?? '';
      if (numberHint) hints.push('절 번호 형태');
      if (item.text.trim() && item.text.trim().length <= 180 && !item.ref.startsWith('#/groups/')) hints.push('짧은 텍스트');
      if (records.has(item.ref)) hints.push('명시적으로 검토한 항목');
      const row = records.get(item.ref), dependency = dependencies([item], !!row?.isHeading);
      const parent = row?.parentRef ? records.get(row.parentRef) : null;
      if (row?.parentRef && (!parent || parent.needsReview || !['normal', 'error'].includes(parent.status))) dependency.pending.push(`parent:${row.parentRef}`);
      const dependencyHash = digest([dependency.hash, row?.parentRef ? [row.parentRef, semantic(parent)] : null]);
      const ownOccurrences = occurrences.filter(entry => entry.ref === item.ref);
      const running = !!role && !role.needsReview && ['normal', 'error'].includes(role.status) && ['header', 'footer', 'page_number'].includes(role.role);
      return { ...item, hints, numberHint, originalLevel: source.headingHints?.[item.ref]?.level ?? null, marker: source.headingHints?.[item.ref]?.marker ?? '', sourceIndex: tree.treeOrder.get(item.ref) ?? null, readingIndex: rank.get(item.ref) ?? null, readingOccurrences: ownOccurrences.map(entry => ({ id: entry.id, page: entry.page, state: readingStates.get(entry.id) })), running, pending: dependency.pending, dependencyHash, candidate: !!hints.length };
    });
    allTexts.sort((a, b) => (a.readingIndex ?? Number.MAX_SAFE_INTEGER) - (b.readingIndex ?? Number.MAX_SAFE_INTEGER));
    const candidates = allTexts.filter(item => item.candidate);
    const pageScopes = decisions.filter(row => row.status !== 'excluded').map(decision => {
      const items = source.roleSource.items.filter(item => item.pages.includes(decision.page));
      const dependency = dependencies(items, true);
      const refs = candidates.filter(item => item.pages.includes(decision.page)).map(item => item.ref);
      const pending = [...dependency.pending, ...refs.filter(ref => { const row = records.get(ref), item = allTexts.find(item => item.ref === ref); return !row || row.needsReview || row.status === 'suspected' || !overrides.some(row => row.ref === ref) && row.dependencyHash !== item.dependencyHash; }).map(ref => `heading:${ref}`)];
      return { page: decision.page, refs, pending, dependencyHash: digest([dependency.hash, refs.map(ref => [ref, semantic(records.get(ref))])]) };
    });
    const diagnoses = [];
    for (const item of candidates) if (item.sourceIndex === null) diagnoses.push({ kind: 'source_order', refs: [item.ref], message: '원본 트리 순서 미확정' });
    for (const field of ['text', 'number']) {
      const groups = new Map();
      for (const item of candidates) { const row = records.get(item.ref), value = field === 'text' ? normalized(item.text) : row?.sectionNumber || item.numberHint; if (!value) continue; const key = `${row?.part || 'unknown'}:${value}`; groups.set(key, [...(groups.get(key) ?? []), item.ref]); }
      for (const refs of groups.values()) if (refs.length > 1) diagnoses.push({ kind: `duplicate_${field}`, refs, message: field === 'text' ? '중복 문구 후보 · 반복 머리말/목차/실제 제목 대조 필요' : '중복 절 번호 후보 · 원문 대조 필요' });
    }
    for (const row of records.values()) if (textMap.has(row.ref) && retained(textMap.get(row.ref)) && row.isHeading && row.parentRef) {
      const parent = records.get(row.parentRef);
      if (!parent?.isHeading || !textMap.has(parent.ref) || !retained(textMap.get(parent.ref)) || parent.level + 1 !== row.level || parent.part !== row.part) diagnoses.push({ kind: 'hierarchy', refs: [row.ref, row.parentRef], message: '상위 제목/수준/문서 구분을 재확인하세요' });
    }
    return { candidates, allTexts, pageScopes, diagnoses, unsettledPages: decisions.filter(row => ['unreviewed', 'pending'].includes(row.status)).map(row => row.page) };
  }
  function records() {
    const c = context();
    return { headingReviews: rawHeadings().map(row => ({ ...row, needsReview: row.needsReview || !c.allTexts.some(item => item.ref === row.ref && item.dependencyHash === row.dependencyHash) })), outlinePages: rawPages().map(row => ({ ...row, needsReview: row.needsReview || !c.pageScopes.some(page => page.page === row.page && page.dependencyHash === row.dependencyHash) })) };
  }
  function coverage() {
    const c = context(), saved = records(), result = { candidates: c.candidates.length, pages: c.pageScopes.length, reviewed: 0, unreviewed: 0, needsReview: 0, suspected: 0, dependencyPending: 0, unsettledPages: c.unsettledPages };
    for (const [targets, rows, key] of [[c.candidates, saved.headingReviews, 'ref'], [c.pageScopes, saved.outlinePages, 'page']]) for (const target of targets) {
      const row = rows.find(row => row[key] === target[key]);
      if (!row) result.unreviewed++; else if (row.needsReview) result.needsReview++; else { result.reviewed++; if (row.status === 'suspected') result.suspected++; }
      if (target.pending.length && row?.status !== 'unjudgeable') result.dependencyPending++;
    }
    return result;
  }
  function common(body, pages) {
    if (!['normal', 'error', 'suspected', 'unjudgeable'].includes(body.status)) fail(400, '검수 판단을 선택하세요.');
    for (const key of ['reason', 'followUp']) if (typeof body[key] !== 'string' || body[key].length > 10000) fail(400, `${key}는 10,000자 이하 문자열이어야 합니다.`);
    if (!body.reason.trim() || ['suspected', 'unjudgeable'].includes(body.status) && !body.followUp.trim()) fail(400, '판단 사유와 필요한 후속 확인을 기록하세요.');
    if (!['json', 'page_image', 'both'].includes(body.evidence) || body.evidence !== 'json' && (!pages.length || pages.some(page => !source.assetFiles.has(page)))) fail(400, '사용 가능한 대조 근거를 선택하세요.');
    return { status: body.status, reason: body.reason.trim(), followUp: body.followUp.trim(), evidence: body.evidence };
  }
  function markStages(ids, pages) {
    for (const id of ids) { const stage = db.prepare('SELECT status FROM stage_reviews WHERE review_id=? AND stage_id=?').get(reviewId, id); if (stage.status === 'pending') continue; db.prepare("UPDATE stage_reviews SET status='needs_review' WHERE review_id=? AND stage_id=?").run(reviewId, id); db.prepare('INSERT INTO review_impacts(review_id,stage_id,page_no,affected_pages,created_at) VALUES (?,?,?,?,?)').run(reviewId, id, pages[0] ?? 0, JSON.stringify(pages), now()); }
  }
  function invalidatePages(pages) {
    const affected = new Set(texts.filter(item => pages.length ? item.pages.some(page => pages.includes(page)) : !item.pages.length).map(item => item.ref));
    const rows = rawHeadings(); let added = true;
    while (added) { added = false; for (const row of rows) if (affected.has(row.parentRef) && !affected.has(row.ref)) { affected.add(row.ref); added = true; } }
    for (const ref of affected) db.prepare('UPDATE heading_reviews SET needs_review=1 WHERE review_id=? AND element_ref=?').run(reviewId, ref);
    const affectedPages = [...new Set([...pages, ...texts.filter(item => affected.has(item.ref)).flatMap(item => item.pages)])];
    for (const page of affectedPages) db.prepare('UPDATE outline_pages SET needs_review=1 WHERE review_id=? AND page_no=?').run(reviewId, page);
    markStages([5, 11, 12], affectedPages);
  }
  function save(body) {
    if (!Array.isArray(body.items) || !Array.isArray(body.pages) || !body.items.length && !body.pages.length || new Set(body.items.map(row => row?.ref)).size !== body.items.length || new Set(body.pages.map(row => row?.page)).size !== body.pages.length) fail(400, '저장할 제목/페이지 대상을 중복 없이 명시하세요.');
    const c = context(), before = { headings: rawHeadings().filter(row => body.items.some(item => item.ref === row.ref)), pages: rawPages().filter(row => body.pages.some(item => item.page === row.page)) };
    const sanitized = body.items.map(row => {
      const item = c.allTexts.find(item => item.ref === row?.ref); if (!item) fail(400, '현재 유지 범위의 원본 텍스트를 선택하세요.');
      const payload = common(row, item.pages);
      if (![true, false, null].includes(row.isHeading) || typeof row.parentRef !== 'string' || typeof row.sectionNumber !== 'string' || row.sectionNumber.length > 100 || !Number.isFinite(row.position) || row.position < 0 || row.position > texts.length * 100) fail(400, '제목 여부·위치·절 번호·부모를 명시하세요.');
      if (row.isHeading === true && (!Number.isInteger(row.level) || row.level < 1 || row.level > 9 || !documentParts.filter(part => !['mixed', 'unknown'].includes(part)).includes(row.part))) fail(400, '제목의 수준 1~9와 문서 구분을 선택하세요.');
      if (row.isHeading !== true && (row.level !== null || row.parentRef || row.sectionNumber || row.part)) fail(400, '비제목/미확정 항목에 제목 구조를 남길 수 없습니다.');
      if (['normal', 'error'].includes(row.status) && row.isHeading === null) fail(400, '제목 여부를 먼저 판단하세요.');
      if (row.status === 'normal' && row.isHeading && item.sourceIndex === null) fail(400, '원본 순서 미확정 제목의 계층을 정상 확정할 수 없습니다.');
      const role = roleStore.records().find(role => role.ref === row.ref);
      if (row.status === 'normal' && (row.isHeading ? role?.role !== 'title' || ['header', 'footer'].includes(role?.region) : role?.role === 'title')) fail(400, '제목 여부와 관련 역할 판단의 차이를 오류/의심으로 검토하세요.');
      return { ref: row.ref, ...payload, isHeading: row.isHeading, level: row.level, parentRef: row.parentRef, sectionNumber: row.sectionNumber.trim(), part: row.part, position: row.position };
    });
    const combined = new Map(rawHeadings().map(row => [row.ref, row])); for (const row of sanitized) combined.set(row.ref, row);
    for (const row of sanitized) {
      const seen = new Set([row.ref]); let parentRef = row.parentRef;
      while (parentRef) { if (seen.has(parentRef)) fail(400, '제목 계층 순환/자기 참조를 허용하지 않습니다.'); seen.add(parentRef); const parent = combined.get(parentRef); if (!parent || !c.allTexts.some(item => item.ref === parentRef) || !parent.isHeading) fail(400, '현재 범위의 제목 부모를 선택하세요.'); parentRef = parent.parentRef; }
      if (['normal', 'error'].includes(row.status) && row.isHeading) {
        const parent = row.parentRef ? combined.get(row.parentRef) : null;
        if (parent && (!['normal', 'error'].includes(parent.status) || parent.needsReview && !sanitized.some(item => item.ref === parent.ref) || parent.level + 1 !== row.level || parent.part !== row.part) || !parent && row.level !== 1) fail(400, '제목 수준과 상위 제목·문서 구분을 함께 확인하세요.');
      }
    }
    const changedParents = new Set(sanitized.filter(row => JSON.stringify(semantic(row)) !== JSON.stringify(semantic(before.headings.find(old => old.ref === row.ref)))).map(row => row.ref));
    let expanded = true;
    while (expanded) { expanded = false; for (const row of combined.values()) if (changedParents.has(row.parentRef) && !changedParents.has(row.ref)) { changedParents.add(row.ref); expanded = true; } }
    const proposed = [...combined.values()].filter(row => c.allTexts.some(item => item.ref === row.ref)).map(row => ({ ...row, needsReview: !!row.needsReview || changedParents.has(row.ref) && !sanitized.some(item => item.ref === row.ref) }));
    validateHeadingForest(proposed, fail);
    const effective = context(sanitized);
    for (const row of sanitized) { const target = effective.allTexts.find(item => item.ref === row.ref); if (['normal', 'error'].includes(row.status) && target.pending.length) fail(400, '관련 영역·역할·읽기 순서를 먼저 확인하세요. 독립 검토는 의심/판단 불가로 기록하세요.'); }
    if (body.range) {
      const { from, to, exceptions } = body.range;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || !Array.isArray(exceptions) || new Set(exceptions).size !== exceptions.length || exceptions.some(page => !Number.isInteger(page) || page < from || page > to || !c.pageScopes.some(row => row.page === page))) fail(400, '개요 구간과 제외할 예외를 명시하세요.');
      const expected = c.pageScopes.filter(row => row.page >= from && row.page <= to && !exceptions.includes(row.page)).map(row => row.page);
      if (!expected.length || JSON.stringify(expected.sort((a, b) => a - b)) !== JSON.stringify(body.pages.map(row => row.page).sort((a, b) => a - b))) fail(400, '명시한 구간/예외와 실제 개요 저장 대상이 다릅니다.');
    }
    const groups = new Map();
    for (const row of body.pages) if (row.range) { const key = JSON.stringify(row.range); groups.set(key, [...(groups.get(key) ?? []), row.page]); }
    for (const [key, pages] of groups) {
      const { from, to, exceptions } = JSON.parse(key);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || !Array.isArray(exceptions) || new Set(exceptions).size !== exceptions.length || exceptions.some(page => !Number.isInteger(page) || page < from || page > to || !c.pageScopes.some(row => row.page === page))) fail(400, '개요 구간/예외가 올바르지 않습니다.');
      const expected = c.pageScopes.filter(row => row.page >= from && row.page <= to && !exceptions.includes(row.page)).map(row => row.page);
      if (JSON.stringify(expected.sort((a, b) => a - b)) !== JSON.stringify(pages.sort((a, b) => a - b))) fail(400, '개요 묶음의 명시 범위와 저장 대상이 다릅니다.');
    }
    const sanitizedPages = body.pages.map(row => {
      const target = effective.pageScopes.find(page => page.page === row?.page); if (!target) fail(400, '현재 유지 페이지 개요를 선택하세요.');
      const payload = common(row, [row.page]);
      if (!documentParts.includes(row.part) || row.checkedAllText !== true || !Array.isArray(row.issues) || new Set(row.issues).size !== row.issues.length || row.issues.some(issue => !['missing', 'duplicate', 'hierarchy', 'part'].includes(issue))) fail(400, '문서 구분과 전체 텍스트/누락·중복 확인 범위를 명시하세요.');
      if (row.status === 'normal' && (row.issues.length || row.part === 'unknown')) fail(400, '미확인 구분/발견 항목을 정상으로 확정할 수 없습니다.');
      if (['normal', 'error'].includes(row.status) && target.pending.length) fail(400, '현재 페이지의 후보와 영역/순서 확인이 남아 있습니다.');
      if (row.status === 'normal' && row.part !== 'mixed' && [...combined.values()].some(heading => target.refs.includes(heading.ref) && heading.isHeading && heading.part !== row.part)) fail(400, '페이지 구분과 제목의 문서 구분을 대조하세요.');
      return { page: row.page, ...payload, part: row.part, checkedAllText: true, issues: row.issues, scopePages: body.pages.filter(item => JSON.stringify(item.range) === JSON.stringify(row.range)).map(item => item.page), range: body.range ?? row.range ?? null, dependencyHash: target.dependencyHash };
    });
    const roles = new Map(roleStore.records().map(row => [row.ref, row]));
    const structurePages = [...new Set(sanitized.filter(row => { const old = before.headings.find(old => old.ref === row.ref); return old ? JSON.stringify(structural(row)) !== JSON.stringify(structural(old)) && (row.isHeading || old.isHeading) : row.isHeading !== null && row.isHeading !== (roles.get(row.ref)?.role === 'title'); }).flatMap(row => textMap.get(row.ref).pages))];
    const touchedPages = [...new Set([...sanitized.flatMap(row => textMap.get(row.ref).pages), ...sanitizedPages.map(row => row.page)])];
    // Descendants not included in the explicit transaction retain their source
    // and prior judgment, but cannot silently retain a confirmed hierarchy.
    const changed = new Set(sanitized.filter(row => JSON.stringify(semantic(row)) !== JSON.stringify(semantic(before.headings.find(old => old.ref === row.ref)))).map(row => row.ref));
    let added = true;
    while (added) { added = false; for (const row of rawHeadings()) if (changed.has(row.parentRef) && !changed.has(row.ref)) { changed.add(row.ref); added = true; } }
    for (const ref of changed) if (!sanitized.some(row => row.ref === ref)) db.prepare('UPDATE heading_reviews SET needs_review=1 WHERE review_id=? AND element_ref=?').run(reviewId, ref);
    for (const page of [...new Set(texts.filter(item => changed.has(item.ref)).flatMap(item => item.pages))]) db.prepare('UPDATE outline_pages SET needs_review=1 WHERE review_id=? AND page_no=?').run(reviewId, page);
    for (const row of sanitized) { const { ref, ...payload } = row, target = effective.allTexts.find(item => item.ref === ref); db.prepare(`INSERT INTO heading_reviews VALUES (?,?,?,?,0,?) ON CONFLICT(review_id,element_ref) DO UPDATE SET payload=excluded.payload,dependency_hash=excluded.dependency_hash,needs_review=0,updated_at=excluded.updated_at`).run(reviewId, ref, JSON.stringify(payload), target.dependencyHash, now()); }
    // Refresh page fingerprints after heading freshness is committed in this
    // same transaction; missing candidate coverage cannot be manufactured.
    const afterContext = context();
    for (const row of sanitizedPages) { const { page, dependencyHash, ...payload } = row; db.prepare(`INSERT INTO outline_pages VALUES (?,?,?,?,0,?) ON CONFLICT(review_id,page_no) DO UPDATE SET payload=excluded.payload,dependency_hash=excluded.dependency_hash,needs_review=0,updated_at=excluded.updated_at`).run(reviewId, page, JSON.stringify(payload), afterContext.pageScopes.find(target => target.page === page).dependencyHash, now()); }
    if (structurePages.length) { readingStore.invalidatePages(structurePages); markStages([4], structurePages); }
    if (changed.size || sanitizedPages.some(row => { const old = before.pages.find(old => old.page === row.page); return !old || JSON.stringify([row.status, row.part, row.issues]) !== JSON.stringify([old.status, old.part, old.issues]); })) markStages([5, 6, 7, 8, 9, 10, 11, 12], touchedPages);
    const after = { headings: rawHeadings().filter(row => sanitized.some(item => item.ref === row.ref)), pages: rawPages().filter(row => sanitizedPages.some(item => item.page === row.page)) };
    db.prepare('INSERT INTO heading_batches VALUES (?,?,?,?,?,?,0,?)').run(randomUUID(), reviewId, JSON.stringify(sanitized.map(row => row.ref)), JSON.stringify(sanitizedPages.map(row => row.page)), JSON.stringify(before), JSON.stringify(after), now());
  }
  function restore(id) {
    const batch = db.prepare('SELECT * FROM heading_batches WHERE review_id=? AND id=? AND restored=0').get(reviewId, id); if (!batch) fail(400, '복원할 제목 저장이 없습니다.');
    const refs = JSON.parse(batch.refs), pages = JSON.parse(batch.pages), after = JSON.parse(batch.after_json), c = context();
    if (refs.some(ref => !c.allTexts.some(item => item.ref === ref)) || pages.some(page => !c.pageScopes.some(item => item.page === page)) || JSON.stringify({ headings: rawHeadings().filter(row => refs.includes(row.ref)), pages: rawPages().filter(row => pages.includes(row.page)) }) !== JSON.stringify(after)) fail(409, '이후 판단/범위 변경으로 직전 저장을 복원할 수 없습니다.');
    const previous = JSON.parse(batch.before_json), affectedPages = [...new Set([...pages, ...refs.flatMap(ref => textMap.get(ref).pages)])];
    const changed = new Set(refs.filter(ref => JSON.stringify(semantic(previous.headings.find(row => row.ref === ref))) !== JSON.stringify(semantic(after.headings.find(row => row.ref === ref)))));
    let expanded = true;
    while (expanded) { expanded = false; for (const row of rawHeadings()) if (changed.has(row.parentRef) && !changed.has(row.ref)) { changed.add(row.ref); expanded = true; } }
    for (const ref of changed) if (!refs.includes(ref)) db.prepare('UPDATE heading_reviews SET needs_review=1 WHERE review_id=? AND element_ref=?').run(reviewId, ref);
    for (const page of [...new Set(texts.filter(item => changed.has(item.ref)).flatMap(item => item.pages))]) db.prepare('UPDATE outline_pages SET needs_review=1 WHERE review_id=? AND page_no=?').run(reviewId, page);
    for (const [table, key, ids, rows] of [['heading_reviews', 'element_ref', refs, previous.headings], ['outline_pages', 'page_no', pages, previous.pages]]) for (const id of ids) {
      db.prepare(`DELETE FROM ${table} WHERE review_id=? AND ${key}=?`).run(reviewId, id); const old = rows.find(row => (row.ref ?? row.page) === id); if (!old) continue;
      const { ref, page, dependencyHash, needsReview, updatedAt, ...payload } = old; db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,1,?)`).run(reviewId, id, JSON.stringify(payload), dependencyHash, updatedAt);
    }
    db.prepare('UPDATE heading_batches SET restored=1 WHERE id=?').run(id);
    const structuralPages = [...new Set(refs.filter(ref => JSON.stringify(structural(previous.headings.find(row => row.ref === ref))) !== JSON.stringify(structural(after.headings.find(row => row.ref === ref))) && (previous.headings.find(row => row.ref === ref)?.isHeading || after.headings.find(row => row.ref === ref)?.isHeading)).flatMap(ref => textMap.get(ref).pages))];
    if (structuralPages.length) { readingStore.invalidatePages(structuralPages); markStages([4], structuralPages); } markStages([5, 6, 7, 8, 9, 10, 11, 12], affectedPages);
  }
  function undo() { const row = db.prepare('SELECT id,refs,pages,created_at FROM heading_batches WHERE review_id=? AND restored=0 ORDER BY rowid DESC LIMIT 1').get(reviewId); return row ? { id: row.id, refs: JSON.parse(row.refs), pages: JSON.parse(row.pages), createdAt: row.created_at } : null; }
  function assertComplete() { roleStore.assertComplete(); readingStore.assertComplete(); const c = coverage(); if (c.unsettledPages.length || c.unreviewed || c.needsReview || c.suspected || c.dependencyPending) fail(400, `제목·개요 미검수 ${c.unreviewed}·재검토 ${c.needsReview}·의심 ${c.suspected}·의존 미확정 ${c.dependencyPending}개를 확인하세요.`); }
  return { context, records, coverage, save, restore, undo, invalidatePages, assertComplete };
}
