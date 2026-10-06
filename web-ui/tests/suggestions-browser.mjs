import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { fixtureProject } from './local-fixture.mjs';

export async function checkSuggestionUI(browser) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-suggestion-browser-'));
  const dbPath = path.join(directory, 'review.sqlite');
  let mode = 'waiting', resolveRun;
  const runner = ({ pages, signal }) => {
    assert.equal(pages.length, 138);
    assert.ok(pages.find(page => page.page === 13).items.some(item => item.ref === '#/tables/4' && item.cells.length));
    if (mode === 'failed') throw new Error('테스트: Codex 연결 실패');
    if (mode === 'empty') return [];
    if (mode === 'success') return [{ pages: [1], reason: '표지' }, { pages: [13, 14, 15], reason: '목차' }];
    if (mode === 'long') return [{ pages: [1], reason: '발행 안내.'.repeat(60) }, { pages: [13, 14, 15], reason: '목차' }];
    return new Promise((resolve, reject) => { resolveRun = resolve; signal.addEventListener('abort', () => reject(new Error('취소')), { once: true }); });
  };
  let app = createReviewApp({ projectDir: fixtureProject, dbPath, suggestionRunner: runner });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, url = `http://127.0.0.1:${port}`;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await fetch(url + '/api/review')).json();
  const request = page.getByRole('button', { name: 'AI 제외 추천', exact: true });
  const region = page.getByRole('region', { name: 'AI 페이지 제외 추천' });
  const openPanel = () => page.getByRole('button', { name: 'AI 응답 열기', exact: true }).click();
  const closePanel = () => page.getByRole('button', { name: 'AI 응답 닫기', exact: true }).click();
  try {
    await page.goto(url); await expect(request).toBeEnabled();
    const initial = await state();
    await expect(region).toHaveCount(0);
    const firstPageY = (await page.locator('.page-sheet').first().boundingBox()).y;
    await openPanel(); await expect(region).toContainText('페이지 선별을 함께 시작');
    await expect(page.getByRole('button', { name: 'AI 응답 닫기', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(region).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'AI 응답 열기', exact: true })).toBeFocused();
    assert.deepEqual(await state(), initial);
    await request.click(); await expect(region).toContainText('전체 페이지를 살펴보고'); await expect(request).toBeDisabled();
    await closePanel(); await expect(region).toHaveCount(0); await expect(request).toBeDisabled();
    await openPanel(); await expect(region).toContainText('전체 페이지를 살펴보고');
    await page.getByRole('button', { name: '추천 취소', exact: true }).click();
    await expect(region).toContainText('추천을 취소했습니다.');
    assert.deepEqual(await state(), initial);
    mode = 'failed'; await request.click(); await expect(region.getByRole('alert')).toContainText('연결 실패');
    assert.deepEqual(await state(), initial);
    mode = 'empty'; await request.click(); await expect(region).toContainText('추천하지 않았습니다.');
    mode = 'waiting'; await request.click(); await expect(region).toContainText('전체 페이지를 살펴보고');
    await page.reload(); await expect(region).toContainText('전체 페이지를 살펴보고');
    await closePanel();
    resolveRun([{ pages: [1], reason: '표지' }, { pages: [13, 14, 15], reason: '목차' }]);
    await expect(page.locator('.ai-page-hint')).toHaveCount(4); await openPanel();
    await expect(region).toContainText('4페이지 제외 후보'); await expect(page.locator('.ai-page-hint')).toHaveCount(4);
    assert.equal((await page.locator('.page-sheet').first().boundingBox()).y, firstPageY, 'responses must not push pages down');
    const panelBox = await page.locator('.ai-response-panel').boundingBox(), galleryBox = await page.locator('.page-gallery').boundingBox();
    assert.ok(panelBox.x >= galleryBox.x + galleryBox.width, 'AI response belongs to the right of the gallery');
    assert.deepEqual(await state(), initial);
    await page.reload(); await expect(region).toContainText('4페이지 제외 후보');
    await page.getByRole('button', { name: '원본 2페이지 · 미검수', exact: true }).click();
    await expect(page.getByRole('button', { name: '원본 2페이지 · 미검수', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('원본 페이지 번호 검색').fill('138');
    await page.getByRole('button', { name: '추천 원본 13, 14, 15페이지 선택', exact: true }).click();
    await expect(page.getByLabel('원본 페이지 번호 검색')).toHaveValue('');
    await expect(page.getByLabel('원본 13페이지 선택')).toBeChecked();
    assert.deepEqual((await state()).selectedPages, [2, 13, 14, 15]);
    assert.deepEqual((await state()).decisions, initial.decisions);
    await page.getByLabel('원본 2페이지 선택').click();
    await expect(page.getByLabel('원본 2페이지 선택')).not.toBeChecked();
    await page.getByLabel('원본 14페이지 선택').click();
    await expect(page.getByLabel('원본 14페이지 선택')).not.toBeChecked();
    await page.getByRole('button', { name: '일괄 제외', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '선택한 2페이지 제외' });
    await expect(dialog.getByLabel('공통 판단 사유')).toHaveValue('목차');
    await expect(dialog.getByLabel('사용한 근거')).toHaveValue('json');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.deepEqual((await state()).decisions, initial.decisions);
    await page.getByRole('button', { name: '일괄 제외', exact: true }).click();
    await dialog.getByRole('button', { name: '2페이지 제외 저장', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    assert.equal((await state()).decisions.find(item => item.page === 14).status, 'unreviewed');
    assert.ok((await state()).decisions.filter(item => [13, 15].includes(item.page)).every(item => item.status === 'excluded' && item.reason === '목차' && item.evidence === 'json'));
    await page.reload(); await expect(region).toContainText('4페이지 제외 후보');
    await expect(page.getByRole('button', { name: '원본 13페이지 · 제외', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '상세 패널 열기', exact: true }).click();
    await expect(region).toHaveCount(0); await expect(page.locator('.decision-panel')).toBeVisible();
    await openPanel(); await expect(page.locator('.decision-panel')).toHaveCount(0); await expect(region).toContainText('4페이지 제외 후보');
    await closePanel(); await expect(page.locator('.decision-panel')).toHaveCount(0);
    await page.reload(); await expect(region).toHaveCount(0); await expect(page.locator('.decision-panel')).toHaveCount(0); await openPanel();
    for (const theme of ['밝은 테마', '어두운 테마']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      for (const width of [1512, 1024, 375, 320]) {
        await page.setViewportSize({ width, height: 982 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `AI recommendation overflow at ${width}px`);
        await expect(region).toBeVisible();
        if (width < 970) {
          await expect(page.getByRole('dialog', { name: 'AI 응답 패널', exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'AI 응답 닫기', exact: true }).focus(); await page.keyboard.press('Shift+Tab');
          await expect(page.getByRole('button', { name: '다시 추천', exact: true })).toBeFocused();
          await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'AI 응답 닫기', exact: true })).toBeFocused();
        }
      }
      const contrast = await region.locator('.ai-suggestion-row p').first().evaluate(element => {
        const lum = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const levels = [lum(getComputedStyle(element).color), lum(getComputedStyle(element.closest('.ai-response-panel')).backgroundColor)].sort((a, b) => b - a);
        return (levels[0] + .05) / (levels[1] + .05);
      });
      assert.ok(contrast >= 4.5, `AI reasons contrast in ${theme}: ${contrast}`);
      await page.setViewportSize({ width: 1512, height: 982 });
      await page.screenshot({ path: path.join(root, `qa/ai-suggestions-${theme === '밝은 테마' ? 'light' : 'dark'}.png`) });
    }
    mode = 'long'; await request.click(); await expect(region).toContainText('발행 안내.'.repeat(60));
    assert.ok(await region.evaluate(element => element.scrollHeight > element.clientHeight), 'long responses scroll inside the panel');
    const scrollY = await page.evaluate(() => window.scrollY);
    await region.hover(); await page.mouse.wheel(0, 700);
    await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    assert.equal(await page.evaluate(() => window.scrollY), scrollY, 'scrolling AI responses must keep the gallery position');
    mode = 'success'; await request.click(); await expect(region.locator('.ai-suggestion-row p').first()).toHaveText('표지');
    await page.setViewportSize({ width: 375, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.context().newCDPSession(page).then(session => session.send('Emulation.setTouchEmulationEnabled', { enabled: true }));
    for (const button of await page.locator('.ai-response-panel button').all()) {
      const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, 'AI panel controls must meet touch target size');
    }
    await page.screenshot({ path: path.join(root, 'qa/ai-suggestions-mobile.png') });
    await region.getByRole('button', { name: '추천 원본 1페이지 선택', exact: true }).click();
    await expect(region).toHaveCount(0); await expect(page.getByLabel('원본 1페이지 선택')).toBeChecked();
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    await openPanel();
    const persisted = await state();
    await app.close(); app = createReviewApp({ projectDir: fixtureProject, dbPath, suggestionRunner: runner });
    await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
    await page.reload(); await expect(request).toBeEnabled();
    await expect(page.locator('.ai-page-hint')).toHaveCount(0);
    assert.deepEqual(await state(), persisted);
    assert.deepEqual(errors, []);
    console.log('AI sidebar browser checks passed: isolated DB, close/reopen during generation, keyboard focus, detail switching, no vertical displacement, running/reload/cancel/error/empty, additive and partial selection, explicit apply/cancel, JSON evidence, reload/restart persistence, 1512/1024/375/320px, touch targets and both themes. Model output was simulated.');
  } finally {
    await page.close(); await app.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-suggestion-browser-'));
    await rm(directory, { recursive: true, force: true });
  }
}
