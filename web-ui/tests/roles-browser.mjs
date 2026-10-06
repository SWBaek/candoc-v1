import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createReviewApp } from '../server/app.mjs';
import { roleDocument, pixelPng } from './fixtures/role-document.mjs';
import { fixtureProject } from './local-fixture.mjs';

export async function checkRoleUI(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-role-browser-')), dbPath = path.join(directory, 'inspection/review.sqlite');
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true });
  const bytes = JSON.stringify(roleDocument()), jsonPath = path.join(directory, 'raw/ieee1547-document.json');
  await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  let app = createReviewApp({ projectDir: directory, dbPath }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, url = `http://127.0.0.1:${port}`;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await fetch(url + '/api/review')).json();
  const put = async (endpoint, payload) => { const response = await fetch(url + endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await state()).revision, ...payload }) }); assert.equal(response.status, 200); return response.json(); };
  const initialJudgment = { ref: '#/texts/1', status: 'error', region: 'header', role: 'header', parentRef: '#/furniture', reason: '기존 개별 판단 근거', evidence: 'json', followUp: '' };
  try {
    await put('/api/review/pages/1', { status: 'excluded', reason: '검사 범위 밖 표지', note: '', evidence: 'json' });
    await put('/api/review/roles', initialJudgment);
    await page.goto(url); await page.locator('[data-stage-id="3"]').click();
    await expect(page.getByRole('heading', { name: '영역·큰 역할·소속', exact: true })).toBeVisible();
    await expect(page.locator('.role-group-summary')).toContainText('전체 4개 / 범위 내 3개 / 선택 3개');
    await expect(page.getByLabel('#/texts/0 일괄 대상', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('#/texts/0 일괄 대상', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('#/texts/2 일괄 대상', { exact: true })).toBeChecked();
    await page.getByText('전체 원본 페이지 목록 (4페이지)', { exact: true }).click();
    await expect(page.locator('.role-group-summary')).toContainText('1, 2, 3, 4');
    await expect(page.getByLabel('선택 요소 위치')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '영역 검수 완료 기록', exact: true })).toBeDisabled();
    const before = await state();
    await page.getByLabel('#/texts/2 일괄 대상', { exact: true }).uncheck();
    await page.getByLabel('검수 판단', { exact: true }).selectOption('error');
    await page.getByLabel('잠정 영역', { exact: true }).selectOption('header');
    await page.getByLabel('잠정 큰 역할', { exact: true }).selectOption('header');
    await page.getByLabel('잠정 소속', { exact: true }).selectOption('#/furniture');
    await page.getByLabel('판단 근거·사유 · 필수', { exact: true }).fill('정규화 문구와 상단 위치가 같고 기존 본문 소속을 다시 확인함');
    assert.deepEqual((await state()).roleReviews, before.roleReviews, 'draft and exceptions do not save');
    await page.getByRole('button', { name: '2개 요소 일괄 저장', exact: true }).click();
    await expect(page.locator('.saved-status')).toHaveText('저장됨');
    let saved = await state(); assert.deepEqual(saved.roleReviews.map(row => row.ref), ['#/texts/1', '#/texts/9']);
    assert.equal(saved.roleReviews.find(row => row.ref === '#/texts/9').parentRef, '#/furniture');
    assert.ok(!saved.roleReviews.some(row => row.ref === '#/texts/2'));
    await page.reload(); await expect(page.getByRole('button', { name: '직전 일괄 판단 복원', exact: true })).toBeEnabled();
    assert.deepEqual((await state()).roleReviews, saved.roleReviews);
    await page.getByRole('button', { name: '직전 일괄 판단 복원', exact: true }).click();
    await expect.poll(async () => (await state()).roleReviews.length).toBe(1);
    assert.deepEqual((await state()).roleReviews, before.roleReviews);
    await page.getByLabel('판단 근거·사유 · 필수', { exact: true }).fill('취소할 초안');
    await page.getByRole('button', { name: '판단 초안 취소', exact: true }).click();
    await expect(page.getByLabel('판단 근거·사유 · 필수', { exact: true })).toHaveValue('');
    await page.getByLabel('판단 근거·사유 · 필수', { exact: true }).fill('이동 확인할 초안');
    await page.getByRole('button', { name: '개별 요소 검토', exact: true }).click();
    const prompt = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다.', exact: true });
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: '현재 화면 유지', exact: true }).click();
    await expect(page.getByLabel('판단 근거·사유 · 필수', { exact: true })).toHaveValue('이동 확인할 초안');
    await page.getByRole('button', { name: '개별 요소 검토', exact: true }).click(); await prompt.getByRole('button', { name: '초안 취소 후 이동', exact: true }).click();
    await expect(page.getByLabel('판단 근거·사유 · 필수', { exact: true })).toHaveValue('기존 개별 판단 근거');
    await page.getByLabel('영역 검수 원본 페이지', { exact: true }).selectOption('0');
    await expect(page.locator('.role-original')).toContainText('#/texts/8');
    await expect(page.locator('.role-no-image')).toContainText('페이지 정보가 없습니다');
    await page.getByLabel('검수 판단', { exact: true }).selectOption('unjudgeable');
    await page.getByLabel('판단 근거·사유 · 필수', { exact: true }).fill('출처 페이지·좌표가 없어 영역을 결정할 수 없음');
    await expect(page.getByRole('button', { name: '요소 판단 저장', exact: true })).toBeDisabled();
    await page.getByLabel('후속 확인 · 필수', { exact: true }).fill('원본 PDF와 대조해 출처 확인');
    await page.getByRole('button', { name: '요소 판단 저장', exact: true }).click();
    await expect(page.locator('.saved-status')).toHaveText('저장됨');
    await page.reload(); await page.getByRole('button', { name: '개별 요소 검토', exact: true }).click();
    await page.getByLabel('영역 검수 원본 페이지', { exact: true }).selectOption('0');
    await expect(page.getByLabel('후속 확인 · 필수', { exact: true })).toHaveValue('원본 PDF와 대조해 출처 확인');
    await page.getByLabel('영역 검수 원본 페이지', { exact: true }).selectOption('2');
    await page.getByLabel('개별 검토 요소', { exact: true }).selectOption('#/tables/0');
    await expect(page.locator('.role-original-text')).toContainText('A table cell');
    // A real stale-revision conflict preserves the unsaved draft until the user chooses otherwise.
    await page.getByLabel('검수 판단', { exact: true }).selectOption('unjudgeable');
    await page.getByLabel('판단 근거·사유 · 필수', { exact: true }).fill('충돌 시에도 보존할 초안');
    await page.getByLabel('후속 확인 · 필수', { exact: true }).fill('표 내부 역할 확인');
    await put('/api/review/roles', { ...initialJudgment, reason: '다른 화면의 변경' });
    await page.getByRole('button', { name: '요소 판단 저장', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('다른 화면에서');
    await expect(page.getByLabel('판단 근거·사유 · 필수', { exact: true })).toHaveValue('충돌 시에도 보존할 초안');
    assert.ok(!(await state()).roleReviews.some(row => row.ref === '#/tables/0'));
    await page.getByRole('button', { name: '판단 초안 취소', exact: true }).click(); await page.reload();
    await expect(page.getByRole('heading', { name: '영역·큰 역할·소속', exact: true })).toBeVisible();
    const persisted = await state();
    await app.close(); app = createReviewApp({ projectDir: directory, dbPath }); await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
    await page.reload(); await expect(page.getByRole('heading', { name: '영역·큰 역할·소속', exact: true })).toBeVisible(); assert.deepEqual(await state(), persisted);
    await page.getByLabel('반복 후보 선택', { exact: true }).selectOption({ index: 1 });
    await expect(page.locator('.role-group-summary')).toContainText('페이지 번호 후보');
    await expect(page.locator('.role-members')).toContainText('iii');
    assert.equal((await state()).roleReviews.length, persisted.roleReviews.length);
    assert.deepEqual(errors, []); assert.equal(await readFile(jsonPath, 'utf8'), bytes);
    console.log('Stage 3 browser workflow passed: groups first, representative/total/pages, out-of-scope and exception selection, explicit atomic save and restore, individual/unlocated/table inspection, drafts/navigation, real conflict, reload/restart. Synthetic input and isolated DB; no model calls.');
  } finally {
    await page.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-role-browser-')); await rm(directory, { recursive: true, force: true });
  }
}

export async function checkActualRoleLayout(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-real-role-layout-'));
  const app = createReviewApp({ projectDir: fixtureProject, dbPath: path.join(directory, 'review.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${app.server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, isMobile: false, hasTouch: true }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.locator('[data-stage-id="3"]').click(); await expect(page.locator('.role-group-summary')).toBeVisible();
    for (const theme of ['밝은 테마', '어두운 테마']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      for (const width of [1512, 1024, 375, 320]) {
        await page.setViewportSize({ width, height: 982 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `role overflow at ${width}px in ${theme}`);
        const contrast = await page.locator('.role-scope-note').first().evaluate(element => {
          const lum = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const levels = [lum(getComputedStyle(element).color), lum(getComputedStyle(element.closest('.app-shell')).backgroundColor)].sort((a, b) => b - a);
          return { ratio: (levels[0] + .05) / (levels[1] + .05), font: parseFloat(getComputedStyle(element).fontSize) };
        });
        assert.ok(contrast.ratio >= 4.5 && contrast.font >= 12, `${theme} role readability: ${JSON.stringify(contrast)}`);
        for (const control of await page.locator('.role-review button, .role-review select, .role-member input').all()) { const box = await control.boundingBox(); if (box) assert.ok(box.width >= 44 && box.height >= 44, 'role touch target must be 44px'); }
        if (width === 1512 || width === 375) await page.screenshot({ path: `qa/roles-${theme === '밝은 테마' ? 'light' : 'dark'}-${width}.png` });
      }
      await page.setViewportSize({ width: 1512, height: 982 });
    }
    const state = await (await fetch(url + '/api/review')).json(); assert.equal(state.roleReviews.length, 0); assert.ok(state.stages.every(stage => stage.status === 'pending')); assert.deepEqual(errors, []);
    console.log(`Stage 3 actual-input layout passed: ${state.roleCoverage.total} items, groups/no auto decisions, 1512/1024/375/320px, two themes, contrast and 44px touch targets. Isolated DB; no model calls.`);
  } finally { await context.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-real-role-layout-')); await rm(directory, { recursive: true, force: true }); }
}
