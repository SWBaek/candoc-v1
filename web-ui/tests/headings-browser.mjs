import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createReviewApp } from '../server/app.mjs';
import { startProcess } from './reading-browser.mjs';
import { fixtureProject } from './local-fixture.mjs';
import { headingDocument, pixelPng, judgment, headingPayload, nonHeading } from './fixtures/heading-document.mjs';
import { seedReading } from './fixtures/reading-document.mjs';

export async function checkHeadingUI(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-heading-browser-')), dbPath = path.join(directory, 'inspection/review.sqlite'), jsonPath = path.join(directory, 'raw/ieee1547-document.json'), bytes = JSON.stringify(headingDocument());
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true }); await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  let server = await startProcess(directory, dbPath), url = server.url;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await fetch(url + '/api/review')).json();
  const put = async (endpoint, body) => { const response = await fetch(url + endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await state()).revision, ...body }) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return { status: response.status, data }; };
  const row = ref => page.locator(`[data-heading-ref="${ref}"]`), save = () => page.getByRole('button', { name: /제목·개요 \d+개 명시적 저장/ });
  const prompt = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다.', exact: true });
  try {
    await put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' }); let c = await (await fetch(url + '/api/heading-review')).json();
    for (const item of c.allTexts) { const role = item.ref === '#/texts/4' ? 'header' : item.ref === '#/texts/3' ? 'body' : 'title'; await put('/api/review/roles', { ref: item.ref, ...judgment, role, region: role === 'header' ? 'header' : 'body', parentRef: '#/body' }); }
    await seedReading(put, await (await fetch(url + '/api/reading-review')).json()); c = await (await fetch(url + '/api/heading-review')).json();
    await put('/api/review/headings', { action: 'save', items: c.allTexts.filter(item => item.candidate || item.ref === '#/texts/4').map(item => item.ref === '#/texts/4' ? nonHeading(item) : headingPayload(item, item.ref === '#/texts/2' ? { level: 2, parentRef: '#/texts/1' } : {})), pages: [] });
    await page.goto(url); await page.locator('[data-stage-id="5"]').click(); await expect(page.getByRole('tree')).toHaveCount(1); await expect(page.getByRole('treeitem')).toHaveCount(4);
    await expect(row('#/texts/4')).toHaveCount(0); await page.getByText('활성 항목 판단·상세', { exact: true }).click(); await page.getByRole('button', { name: '행 편집 · F2', exact: true }).click(); await expect(row('#/texts/0')).toBeFocused(); await page.getByText('선택 항목 일괄 판단 · 대상/예외', { exact: true }).click(); await page.locator('.heading-completion > summary').click(); await expect(page.getByRole('button', { name: '제목·개요 완료 기록', exact: true })).toBeDisabled();
    const initial = await state(); await row('#/texts/1').focus(); await page.keyboard.press('Tab'); await expect(page.getByLabel('제안 상위 제목', { exact: true })).toHaveValue('#/texts/0'); await expect(row('#/texts/1')).toHaveAttribute('aria-level', '2'); await expect(row('#/texts/2')).toHaveAttribute('aria-level', '3');
    await page.locator('.heading-scope summary').click();
    await expect(page.locator('.heading-scope')).not.toContainText('#/texts/5');
    assert.deepEqual((await state()).headingReviews, initial.headingReviews, 'Tab modifies the draft only');
    await row('#/texts/1').focus(); await page.keyboard.press('Shift+Tab'); await expect(row('#/texts/1')).toHaveAttribute('aria-level', '1'); await expect(row('#/texts/2')).toHaveAttribute('aria-level', '2');
    await page.getByRole('button', { name: '초안 실행취소', exact: true }).click(); await expect(row('#/texts/2')).toHaveAttribute('aria-level', '3'); await page.getByRole('button', { name: '전체 초안 취소', exact: true }).click(); await expect(row('#/texts/2')).toHaveAttribute('aria-level', '2');
    await row('#/texts/1').focus(); await page.keyboard.press('ArrowRight'); await expect(row('#/texts/2')).toBeFocused(); await expect(row('#/texts/2')).toHaveAttribute('aria-selected', 'true'); await expect(page.getByLabel('제목 근거·사유', { exact: true })).toHaveValue(judgment.reason);
    await page.getByRole('button', { name: '#/texts/1 접기', exact: true }).click(); await expect(row('#/texts/2')).toHaveCount(0); await expect(page.locator('.heading-selection')).toContainText('숨겨진 선택 1개'); await expect(page.getByRole('button', { name: /선택 판단 \d+개 초안 적용/ })).toBeDisabled();
    await page.getByLabel('제목 트리 검색', { exact: true }).fill('Gamma'); await expect(page.getByRole('treeitem')).toHaveCount(2); await expect(row('#/texts/1')).toContainText('상위 맥락'); await expect(row('#/texts/2')).toBeVisible();
    await page.getByLabel('제목 트리 검색', { exact: true }).focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: '검색 해제·전체 펼치기', exact: true })).toBeFocused(); assert.deepEqual((await state()).headingReviews, initial.headingReviews);
    await page.getByRole('button', { name: '검색 해제·전체 펼치기', exact: true }).click(); await row('#/texts/0').click(); await page.getByText('선택 원문·bbox·JSON 대조', { exact: true }).click(); await expect(page.locator('.heading-source img')).toHaveAttribute('src', '/api/pages/1/image'); await expect(page.locator('.heading-source pre')).toContainText('charspan'); await expect(page.locator('.heading-source .reading-box')).toHaveCount(1);
    await page.getByRole('button', { name: '선택 원본 확대', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('src', '/api/pages/1/image'); await page.keyboard.press('Escape');
    await page.getByLabel('#/texts/5 제목 선택', { exact: true }).check();
    await expect(page.getByLabel('제목 원본 출처 페이지', { exact: true })).toHaveValue('2');
    await expect(page.locator('.heading-source img')).toHaveAttribute('src', '/api/pages/2/image');
    await expect(page.locator('.heading-source .reading-box')).toHaveCount(1);
    await page.getByLabel('#/texts/2 제목 선택', { exact: true }).check();
    await expect(page.locator('.heading-source img')).toHaveAttribute('src', '/api/pages/1/image');
    await expect(page.locator('.heading-source .reading-box')).toHaveCount(1);
    await page.locator('.heading-tools > summary').click(); await page.getByRole('button', { name: '보이는 항목 선택', exact: true }).click(); await page.getByText(/실제 대상 4개 · 예외 선택/).click(); await page.getByLabel('#/texts/5 일괄 대상', { exact: true }).uncheck(); await expect(page.locator('.heading-selection')).toContainText('예외 1개');
    await page.getByLabel('일괄 제목 판단', { exact: true }).selectOption('unjudgeable'); await page.getByLabel('일괄 제목 사유', { exact: true }).fill('선택 제목의 계층과 표현을 원문에 추가 대조'); await page.getByLabel('일괄 제목 후속 확인', { exact: true }).fill('원본 PDF의 전체 제목 계층 확인');
    await page.getByRole('button', { name: '선택 판단 3개 초안 적용', exact: true }).click(); assert.deepEqual((await state()).headingReviews, initial.headingReviews);
    await page.getByLabel('제목 트리 검색', { exact: true }).fill('Gamma'); await expect(save()).toBeDisabled(); await expect(page.getByRole('button', { name: '선택 판단 3개 초안 적용', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '검색 해제·전체 펼치기', exact: true }).click();
    await save().click(); await expect(page.locator('.saved-status')).toHaveText('저장됨'); let saved = await state(); assert.equal(saved.headingReviews.filter(row => row.status === 'unjudgeable').length, 3); assert.equal(saved.headingReviews.find(row => row.ref === '#/texts/4').status, 'normal');
    await page.reload(); await expect(page.getByRole('treeitem')).toHaveCount(4); assert.deepEqual((await state()).headingReviews, saved.headingReviews);
    await page.locator('.heading-tools > summary').click(); await page.getByRole('button', { name: '직전 저장 복원', exact: true }).click(); await expect.poll(async () => (await state()).headingReviews.filter(row => row.status === 'unjudgeable').length).toBe(0); await expect(row('#/texts/0')).toContainText('재검토');
    await row('#/texts/0').click(); await page.getByText('활성 항목 판단·상세', { exact: true }).click(); await page.getByLabel('제목 근거·사유', { exact: true }).fill('충돌 중에도 보존할 초안'); await put('/api/review/stages/6', { action: 'save_note', note: '다른 창의 격리 기록' }); await save().click(); await expect(page.getByRole('alert')).toContainText('다른 화면에서'); await expect(page.getByLabel('제목 근거·사유', { exact: true })).toHaveValue('충돌 중에도 보존할 초안');
    await page.locator('[data-stage-id="4"]').click(); await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: '현재 화면 유지', exact: true }).click(); await expect(page.getByLabel('제목 근거·사유', { exact: true })).toHaveValue('충돌 중에도 보존할 초안'); await page.getByRole('button', { name: '전체 초안 취소', exact: true }).click(); await page.reload();
    // Reconfirm the restored scope explicitly, then use page ranges with one
    // exception. No 138-card workflow and no implicit completion.
    await seedReading(put, await (await fetch(url + '/api/reading-review')).json()); saved = await state(); await put('/api/review/headings', { action: 'save', items: saved.headingReviews.map(row => ({ ...row, status: 'unjudgeable', followUp: '복원 이후 원문 확인', reason: '복원 범위의 제목 여부와 계층 대조' })), pages: [] });
    await page.reload(); await page.getByLabel('검수 보기', { exact: true }).selectOption('pages'); await page.locator('.heading-completion > summary').click(); await expect(page.locator('.heading-ranges')).toContainText('실제 적용 3페이지'); await page.getByText('전체 구간 목록 · 예외 제외/기존 판단 대조', { exact: true }).click(); await page.getByLabel('원본 3페이지 개요 대상', { exact: true }).uncheck(); await expect(page.locator('.heading-ranges')).toContainText('예외 1 · 실제 적용 2페이지');
    await page.getByLabel('개요 검수 판단', { exact: true }).selectOption('unjudgeable'); await page.getByLabel('개요 범위·사유', { exact: true }).fill('전체 텍스트와 제목 누락/문서 구분을 구간별 대조'); await page.getByLabel('개요 후속 확인', { exact: true }).fill('원문에 없는 제목은 추정하지 않고 추가 확인'); await page.getByLabel('구간 전체 텍스트와 후보 누락 확인', { exact: true }).check();
    await page.getByText('구간 전체 원본 텍스트·출처 대조', { exact: true }).click(); await expect(page.locator('.heading-range-source pre')).toContainText('Long prose'); await expect(page.locator('.heading-range-source pre')).toContainText('charspan');
    await page.getByRole('button', { name: '구간 2페이지 개요 초안 적용', exact: true }).click(); assert.equal((await state()).outlinePages.length, 0); await save().click(); await expect.poll(async () => (await state()).outlinePages.length).toBe(2); assert.deepEqual((await state()).outlinePages[0].range.exceptions, [3]); await expect(page.getByRole('button', { name: '제목·개요 완료 기록', exact: true })).toBeDisabled();
    const rangeRevision = (await state()).revision; await page.getByRole('button', { name: '구간 2페이지 개요 초안 적용', exact: true }).click(); await expect(save()).toBeEnabled(); await save().click(); await expect.poll(async () => (await state()).revision).toBe(rangeRevision + 1); assert.deepEqual((await state()).outlinePages.map(row => row.page), [1, 2], 'unchanged range explicitly reconfirms all targets and preserves the exception');
    await page.getByLabel('개요 구간 시작', { exact: true }).fill('3'); await page.getByRole('button', { name: '구간 1페이지 개요 초안 적용', exact: true }).click(); await save().click(); await expect.poll(async () => (await state()).outlinePages.length).toBe(3); await page.locator('#stage-note').fill('전체 유지 후보와 구간, 판단 불가/후속 확인을 기록함'); await page.getByRole('button', { name: '제목·개요 완료 기록', exact: true }).click(); await expect(page.locator('[data-stage-id="5"]')).toHaveClass(/step-completed/);
    saved = await state(); const oldPid = server.pid; await page.goto('about:blank'); await server.stop(); server = await startProcess(directory, dbPath); url = server.url; assert.notEqual(server.pid, oldPid); assert.deepEqual(await state(), saved); await page.goto(url); await expect(page.locator('[data-stage-id="5"]')).toHaveClass(/step-completed/); await expect(page.getByRole('treeitem')).toHaveCount(4);
    await page.getByText('전체 텍스트에서 후보 밖 항목 찾기', { exact: true }).click(); await page.getByLabel('원본 텍스트 후보 추가', { exact: true }).selectOption('#/texts/3'); await expect(row('#/texts/3')).toHaveAttribute('aria-selected', 'true'); await expect(page.getByRole('treeitem')).toHaveCount(2); assert.deepEqual(await state(), saved, 'adding an outside candidate is navigation until explicit judgment/save'); await page.getByLabel('제목 여부', { exact: true }).selectOption('no'); await page.getByLabel('제목 검수 판단', { exact: true }).selectOption('normal'); await page.getByLabel('제목 근거·사유', { exact: true }).fill('후보 밖 긴 본문을 원문에서 비제목으로 확인'); await save().click(); await expect.poll(async () => (await state()).headingReviews.some(row => row.ref === '#/texts/3' && row.isHeading === false)).toBe(true); await page.reload(); await expect(page.getByRole('treeitem')).toHaveCount(4);
    assert.deepEqual(errors, []); assert.equal(await readFile(jsonPath, 'utf8'), bytes);
    console.log('Stage 5 synthetic browser passed: whole TOC, Tab/ShiftTab subtree/parent/depth, arrows/collapse, native Tab, search ancestors/hidden selections, batch exception disclosure, undo/cancel/saved restore, PNG+bbox/all prov, real conflict/navigation guard, grouped ranges/exceptions/completion and actual child-process restart. Isolated DB/build/ports; no model calls.');
  } finally { await page.close(); await server.stop(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-heading-browser-')); await rm(directory, { recursive: true, force: true }); }
}

export async function checkActualHeadingLayout(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-real-heading-layout-')), app = createReviewApp({ projectDir: fixtureProject, dbPath: path.join(directory, 'review.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${app.server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, hasTouch: true }), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.locator('[data-stage-id="5"]').click(); await expect(page.getByRole('tree')).toBeVisible(); const data = await (await fetch(url + '/api/heading-review')).json();
    await expect(page.locator('.heading-tools-content')).not.toBeVisible(); await expect(page.locator('#stage-note')).not.toBeVisible();
    const visibleActions = await page.locator('.heading-primary-tools button, .heading-save-bar button').evaluateAll(elements => elements.filter(element => element.checkVisibility()).length); assert.equal(visibleActions, 5, 'initial outline exposes only previous/next, edit, undo and save');
    const firstTreeTop = (await page.getByRole('tree').boundingBox()).y; assert.ok(firstTreeTop < 400, `outline starts at ${firstTreeTop}px`);
    await page.locator('.heading-tools > summary').click(); await expect(page.getByRole('button', { name: '보이는 항목 선택', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('.heading-tools > summary')).toBeFocused(); await expect(page.locator('.heading-tools-content')).not.toBeVisible();
    await page.locator('.heading-tools > summary').press('Enter'); await expect(page.locator('.heading-tools-content')).toBeVisible(); await page.getByLabel('제목 트리 검색', { exact: true }).click(); await expect(page.locator('.heading-tools-content')).not.toBeVisible();
    assert.equal(await page.getByRole('treeitem').count(), data.allTexts.filter(item => item.classifiedHeading).length); assert.equal(new Set(data.candidates.map(item => item.ref)).size, data.candidates.length);
    const roles = await (await fetch(url + '/api/role-elements')).json(); for (const item of data.allTexts) assert.deepEqual(item.provenance, roles.items.find(row => row.ref === item.ref).provenance);
    for (const theme of ['밝은 테마', '어두운 테마']) { await page.getByRole('button', { name: theme, exact: true }).click();
      for (const width of [1920, 1512, 1366, 1024, 375, 320]) { await page.setViewportSize({ width, height: 982 });
        for (const mode of ['전체 제목 트리', '문서 구간·누락 확인']) { await page.getByLabel('검수 보기', { exact: true }).selectOption(mode === '전체 제목 트리' ? 'tree' : 'pages'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} overflow ${width} ${theme}`);
          assert.ok((await page.getByLabel('검수 보기', { exact: true }).boundingBox()).width >= 150, `readable view selector at ${width}px`);
          if (mode === '전체 제목 트리') { await page.evaluate(() => scrollTo(0, 0)); assert.ok((await page.getByRole('tree').boundingBox()).y < 500, `first-screen outline at ${width}px`); }
          const controls = page.locator('.heading-review button, .heading-review select, .heading-review input, .heading-review summary'); for (const index of [...new Set([0, 1, 2, 3, 4, 5, 6, 7, await controls.count() - 1])]) { const control = controls.nth(index); if (await control.isVisible()) { const box = await control.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, `touch target ${width}: ${await control.evaluate(e => e.outerHTML.slice(0, 100))}`); } }
          const contrast = await page.locator('.heading-change-count, .role-scope-note').first().evaluate(element => { const lum = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); const levels = [lum(getComputedStyle(element).color), lum(getComputedStyle(element.closest('.app-shell')).backgroundColor)].sort((a, b) => b - a); return (levels[0] + .05) / (levels[1] + .05); }); assert.ok(contrast >= 4.5);
          if ([1512, 375].includes(width)) await page.screenshot({ path: `qa/simple-headings-${mode === '전체 제목 트리' ? 'tree' : 'ranges'}-${theme === '밝은 테마' ? 'light' : 'dark'}-${width}.png` });
        }
      }
      await page.setViewportSize({ width: 1512, height: 982 });
    }
    await page.getByRole('button', { name: '밝은 테마', exact: true }).click(); await page.getByLabel('검수 보기', { exact: true }).selectOption('tree');
    const target = data.allTexts.find(item => item.text.startsWith('6.4.2.3.1 General'));
    assert.ok(target && target.classifiedHeading);
    await page.getByLabel('제목 트리 검색', { exact: true }).fill('6.4.2.3');
    await page.locator(`[data-heading-ref="${target.ref}"]`).click();
    await expect(page.locator(`[data-heading-ref="${target.ref}"] .heading-row-state`)).toContainText('깊이 확인');
    await page.screenshot({ path: 'qa/simple-headings-reference-light-1512.png' });
    await page.getByText('활성 항목 판단·상세', { exact: true }).click(); await page.getByText('선택 원문·bbox·JSON 대조', { exact: true }).click();
    await expect(page.locator('.heading-source img')).toHaveAttribute('src', '/api/pages/49/image'); await expect(page.locator('.heading-source .reading-box')).toHaveCount(target.provenance.filter(p => p.page === 49 && p.rect).length);
    await page.locator('.heading-source img').evaluate(img => img.decode()); await page.locator('.heading-source .role-image-wrap').scrollIntoViewIfNeeded(); await page.screenshot({ path: 'qa/simple-headings-reference-source-light-1512.png' });
    const state = await (await fetch(url + '/api/review')).json(); assert.equal(state.headingReviews.length, 0); assert.equal(state.outlinePages.length, 0); assert.ok(state.stages.every(row => row.status === 'pending')); assert.deepEqual(errors, []);
    console.log(`Stage 5 actual fixture layout passed: ${data.candidates.length} candidate rows/${data.allTexts.length} texts/all prov, whole TOC and range mode, two themes, 1920/1512/1366/1024/375/320px, contrast and representative 44px controls, no automatic judgments. Isolated DB.`);
  } finally { await context.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-real-heading-layout-')); await rm(directory, { recursive: true, force: true }); }
}
