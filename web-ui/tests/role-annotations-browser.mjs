import { configureProjectModel } from './project-codex-settings-browser.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startProcess } from './reading-browser.mjs';
import { createReviewApp } from '../server/app.mjs';
import { fixtureProject } from './local-fixture.mjs';
import { roleAnnotationDocument } from './fixtures/role-annotation-document.mjs';
import { pixelPng } from './fixtures/role-document.mjs';

async function dragBox(page, rect) {
  const image = page.locator('.role-annotation-canvas > img'); await image.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '영역 표시', exact: true }).click();
  const bounds = await image.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width * rect.left, bounds.y + bounds.height * rect.top); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * (rect.left + rect.width), bounds.y + bounds.height * (rect.top + rect.height), { steps: 5 }); await page.mouse.up();
  await expect(page.getByLabel('이 영역에 대한 코멘트', { exact: true })).toBeVisible();
}
export async function checkRoleAnnotationsUI(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-annotation-browser-')), dbPath = path.join(directory, 'inspection/review.sqlite');
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true });
  const bytes = JSON.stringify(roleAnnotationDocument()), jsonPath = path.join(directory, 'raw/ieee1547-document.json');
  await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  const optionsModule = new URL('./fixtures/role-annotation-options.mjs', import.meta.url).href;
  let server = await startProcess(directory, dbPath, optionsModule), url = server.url;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = async () => (await (await fetch(url + '/api/review')).json());
  const annotations = async () => (await (await fetch(url + '/api/role-annotations')).json());
  const put = async (endpoint, body) => { const response = await fetch(url + endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await state()).revision, ...body }) }); assert.equal(response.status, 200); return response.json(); };
  const open = async () => { await page.getByLabel('영역 검수 보기', { exact: true }).selectOption('annotate'); await expect(page.locator('.role-annotation-canvas > img')).toBeVisible(); };
  const rect = { left: .08, top: .04, width: .76, height: .09 };
  try {
    await put('/api/review/pages/1', { status: 'excluded', reason: '제외 표지', note: '', evidence: 'json' });
    const known = { ref: '#/texts/7', status: 'normal', region: 'footnote', role: 'footnote', parentRef: '', reason: '기존 각주 확인', evidence: 'json', followUp: '' }; await put('/api/review/roles', known);
    await page.goto(url); await page.locator('[data-stage-id="3"]').click(); await open();
    await page.getByLabel('주석 원본 페이지', { exact: true }).selectOption('4'); await dragBox(page, rect);
    const input = page.getByLabel('이 영역에 대한 코멘트', { exact: true }); await input.fill('같은 영역의 문구와 분리된 두 줄을 머리말로 처리해줘');
    const beforeSettings = await state();
    await page.getByRole('button', { name: '설정', exact: true }).click(); await expect(page.getByRole('dialog', { name: '프로젝트 설정', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await expect(input).toHaveValue('같은 영역의 문구와 분리된 두 줄을 머리말로 처리해줘'); await expect(page.getByLabel('표시한 주석 영역', { exact: true })).toHaveCount(1); assert.deepEqual(await state(), beforeSettings);
    await expect(page.locator('.role-annotation-comment')).toContainText('대응 JSON 텍스트 3개');
    await page.locator('[data-stage-id="4"]').click(); const prompt = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다.', exact: true });
    await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: '현재 화면 유지', exact: true }).click(); await expect(input).toHaveValue('같은 영역의 문구와 분리된 두 줄을 머리말로 처리해줘');
    const before = await state(); await page.getByRole('button', { name: '주석 저장', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '주석에 연결된 AI 응답', exact: true }); await expect(panel).toBeVisible();
    assert.deepEqual((await state()).roleReviews, before.roleReviews);
    assert.deepEqual((await annotations()).annotations[0].matches.map(row => row.ref), ['#/texts/9', '#/texts/10', '#/texts/11']);
    await configureProjectModel(page);
    await panel.getByRole('button', { name: '이 주석으로 Agent에 요청', exact: true }).click(); await expect(page.getByLabel('영역 추천 묶음', { exact: true })).toBeVisible(); assert.deepEqual((await state()).roleReviews, before.roleReviews);
    await panel.getByText('대상·변경 전후·예외 확인', { exact: true }).click();
    await page.getByLabel('#/texts/2 영역 추천 대상', { exact: true }).uncheck();
    const target = panel.locator('.role-annotation-target').filter({ has: page.getByLabel('#/texts/1 영역 추천 대상', { exact: true }) }); await target.getByRole('button', { name: '원본 위치', exact: true }).click();
    await expect(page.getByLabel('주석 원본 페이지', { exact: true })).toHaveValue('2'); await expect(page.getByLabel('추천 대상 원본 위치', { exact: true })).toHaveCount(1); await expect(page.getByText('활성 원본 · #/texts/1', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '선택한 4개 판단 저장', exact: true }).click();
    const saved = await state(); assert.deepEqual(saved.roleUndo.refs, ['#/texts/1', '#/texts/9', '#/texts/10', '#/texts/11']); assert.deepEqual(saved.roleReviews.find(row => row.ref === '#/texts/7'), before.roleReviews[0]);
    await page.reload(); await open(); await page.getByRole('button', { name: '주석·AI 응답', exact: true }).click(); await expect(page.locator('.role-annotation-message')).toContainText('분리된 두 줄'); await expect(page.locator('.role-annotation-thread')).toContainText('검수 버전이 바뀐 추천');
    await expect(page.getByRole('button', { name: '선택한 5개 판단 저장', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '직전 일괄 판단 복원', exact: true }).click(); await expect.poll(async () => (await state()).roleReviews).toEqual(before.roleReviews);
    const persisted = await annotations(), oldPid = server.pid; await server.stop(); server = await startProcess(directory, dbPath, optionsModule); url = server.url; assert.notEqual(server.pid, oldPid); await page.goto(url); await open(); assert.deepEqual(await annotations(), persisted);
    await page.getByLabel('주석 원본 페이지', { exact: true }).selectOption('4'); await dragBox(page, rect); await input.fill('충돌이 나도 보존할 영역 코멘트'); await put('/api/review/roles', { ...known, reason: '다른 화면에서 변경' }); await page.getByRole('button', { name: '주석 저장', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('다른 화면에서'); await expect(input).toHaveValue('충돌이 나도 보존할 영역 코멘트'); await expect(page.getByLabel('표시한 주석 영역', { exact: true })).toHaveCount(1);
    await page.locator('.role-annotation-comment').getByRole('button', { name: '취소', exact: true }).click(); await page.reload(); await open();
    await page.getByRole('button', { name: '영역 표시', exact: true }).click();
    await page.getByLabel('원본 영역 표시', { exact: true }).press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Enter');
    await expect(input).toBeFocused(); await input.fill('키보드 영역 선택'); await input.press('Tab'); await expect(page.locator('.role-annotation-comment').getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await page.locator('.role-annotation-comment').getByRole('button', { name: '취소', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 982 }); await page.getByRole('button', { name: '주석·AI 응답', exact: true }).click(); await expect(page.locator('.role-annotation-panel')).toBeVisible();
    const projectLink = page.locator('.role-annotation-panel .project-codex-link'); await projectLink.click(); await expect(page.getByRole('dialog', { name: '프로젝트 설정', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('.role-annotation-panel')).toBeVisible(); await expect(projectLink).toBeFocused();
    await page.locator('.role-annotation-panel').getByRole('button', { name: '닫기', exact: true }).focus(); await page.keyboard.press('Shift+Tab'); assert.ok(await page.locator('.role-annotation-panel').evaluate(panel => panel.contains(document.activeElement))); await page.keyboard.press('Escape'); await expect(page.locator('.role-annotation-panel')).toHaveCount(0); await expect(page.getByRole('button', { name: '주석·AI 응답', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '영역 표시', exact: true }).click();
    const touchBounds = await page.locator('.role-annotation-canvas > img').boundingBox(), cdp = await page.context().newCDPSession(page);
    const touch = (x, y) => [{ x: touchBounds.x + touchBounds.width * x, y: touchBounds.y + touchBounds.height * y }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(.08, .04) }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(.84, .13) }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    await expect(input).toBeVisible(); await input.fill('터치로 표시한 영역'); await page.locator('.role-annotation-comment').getByRole('button', { name: '취소', exact: true }).click();
    assert.deepEqual(errors, []); assert.equal(await readFile(jsonPath, 'utf8'), bytes);
    console.log('Stage 3 annotation UI passed: drag/bbox split refs, anchored comment, navigation/draft protection, local model/effort, recommendation vs save, scope/exceptions/active source, reload/real child restart/undo, stale rejection/conflict draft, mobile drawer/Escape/focus. Synthetic app-server only.');
  } finally { await page.close(); await server.stop(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-annotation-browser-')); await rm(directory, { recursive: true, force: true }); }
}

export async function checkActualAnnotationLayout(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-actual-annotation-')), app = createReviewApp({ projectDir: fixtureProject, dbPath: path.join(directory, 'review.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${app.server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url); await page.locator('[data-stage-id="3"]').click(); await page.getByLabel('영역 검수 보기', { exact: true }).selectOption('annotate'); await page.getByLabel('주석 원본 페이지', { exact: true }).selectOption('17');
    for (const theme of ['밝은 테마', '어두운 테마']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      for (const width of [1512, 1024, 375, 320]) {
        await page.setViewportSize({ width, height: 982 }); await dragBox(page, { left: .14, top: .045, width: .73, height: .04 });
        await page.getByLabel('이 영역에 대한 코멘트', { exact: true }).fill('같은 반복 머리말을 찾아줘');
        await expect(page.locator('.role-annotation-comment')).toContainText('대응 JSON 텍스트 2개');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `annotation overflow ${theme}/${width}`);
        const input = await page.getByLabel('이 영역에 대한 코멘트', { exact: true }).boundingBox(); assert.ok(input.width >= 200);
        const contrast = await page.locator('.role-annotation-comment').evaluate(box => {
          const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const fg = luminance(getComputedStyle(box.querySelector('textarea')).color), bg = luminance(getComputedStyle(box).backgroundColor); return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
        }); assert.ok(contrast >= 4.5, `annotation contrast ${theme}/${width}: ${contrast}`);
        for (const name of ['취소', '주석 저장']) { const box = await page.locator('.role-annotation-comment').getByRole('button', { name, exact: true }).boundingBox(); assert.ok(box.width >= 44 && box.height >= 44); }
        if ([1512, 375].includes(width)) await page.screenshot({ path: `qa/role-annotations-${theme === '밝은 테마' ? 'light' : 'dark'}-${width}.png` });
        await page.locator('.role-annotation-comment').getByRole('button', { name: '취소', exact: true }).click();
      }
      await page.setViewportSize({ width: 1512, height: 982 });
    }
    await page.getByRole('button', { name: '밝은 테마', exact: true }).click(); await dragBox(page, { left: .14, top: .045, width: .73, height: .04 }); await page.getByLabel('이 영역에 대한 코멘트', { exact: true }).fill('같은 반복 머리말을 찾아줘'); await page.getByRole('button', { name: '주석 저장', exact: true }).click();
    await expect(page.locator('.role-annotation-panel')).toBeVisible(); await expect(page.locator('.role-annotation-thread')).toContainText('Agent에는 좌표·bbox·JSON 텍스트를 전달');
    await page.screenshot({ path: 'qa/role-annotations-sidebar-light-1512.png' });
    await page.getByRole('button', { name: '어두운 테마', exact: true }).click(); await page.setViewportSize({ width: 375, height: 982 }); await expect(page.getByRole('dialog', { name: '주석에 연결된 AI 응답', exact: true })).toBeVisible(); await page.screenshot({ path: 'qa/role-annotations-sidebar-dark-375.png' });
    assert.deepEqual(errors, []); const state = await (await fetch(url + '/api/review')).json(); assert.equal(state.roleReviews.length, 0); assert.ok(state.stages.every(row => row.status === 'pending'));
    console.log('Stage 3 actual annotation layout passed: actual split header page 17, bbox-only matching, anchored comments, 1512/1024/375/320 in two themes, 44px actions/no overflow. Isolated DB; no models.');
  } finally { await page.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-actual-annotation-')); await rm(directory, { recursive: true, force: true }); }
}
