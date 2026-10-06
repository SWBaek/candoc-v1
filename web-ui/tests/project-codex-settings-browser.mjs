import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';
import { fixtureProject } from './local-fixture.mjs';
import { startProcess } from './reading-browser.mjs';

export async function configureProjectModel(page, effort = 'medium') {
  await page.getByRole('button', { name: '프로젝트 모델 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '프로젝트 설정', exact: true });
  await dialog.getByRole('button', { name: '연결 확인', exact: true }).click();
  await expect(page.getByLabel('프로젝트 모델', { exact: true })).toHaveValue('test-model');
  await page.getByLabel('프로젝트 Reasoning effort', { exact: true }).selectOption(effort);
  await dialog.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export async function checkProjectCodexSettingsUI(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-project-settings-')), dbPath = path.join(directory, 'review.sqlite');
  const launch = { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-role-annotation-app-server.mjs', import.meta.url)), 'catalogue-only'] };
  let failed = false, checks = 0, runs = [];
  const options = { projectDir: fixtureProject, dbPath, codexModelRunner: async args => {
    checks++; if (failed) throw Error('Synthetic connection unavailable');
    const models = await runCodexSuggestions({ ...args, catalogue: true, launch, timeoutMs: 5000 });
    return [...models, { model: 'alternate', displayName: 'Alternate synthetic model', efforts: ['high'], defaultEffort: 'high', isDefault: false }];
  }, suggestionRunner: async args => { runs.push([args.selectedModel, args.selectedEffort]); return []; } };
  let app = createReviewApp(options); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let url = `http://127.0.0.1:${app.server.address().port}`, child;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await (await fetch(url + '/api/review')).json());
  const settings = async () => (await (await fetch(url + '/api/project/codex')).json());
  const menu = page.getByRole('button', { name: '설정', exact: true }), dialog = page.getByRole('dialog', { name: '프로젝트 설정', exact: true });
  const model = page.getByLabel('프로젝트 모델', { exact: true }), effort = page.getByLabel('프로젝트 Reasoning effort', { exact: true });
  try {
    await page.goto(url); await expect(menu).toBeVisible(); const before = await state(); assert.equal(checks, 0);
    await menu.click(); await expect(dialog).toContainText('Codex 연결 미확인'); await expect(model).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '설정 닫기', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '설정 닫기', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(menu).toBeFocused();
    await menu.click(); await dialog.getByRole('button', { name: '연결 확인', exact: true }).click();
    await expect(dialog).toContainText('Codex 연결 확인됨'); await expect(model).toHaveValue('test-model'); await expect(effort).toHaveValue('medium');
    await model.selectOption('alternate'); await expect(effort).toHaveValue('high'); await expect(effort.locator('option')).toHaveCount(2);
    await dialog.getByRole('button', { name: '취소', exact: true }).click(); assert.equal((await settings()).settings.version, 0); assert.deepEqual(await state(), before);
    await menu.click(); await dialog.getByRole('button', { name: '연결 확인', exact: true }).click(); await effort.selectOption('low');
    await dialog.getByRole('button', { name: '설정 저장', exact: true }).click(); await expect(dialog).toHaveCount(0); const saved = (await settings()).settings;
    assert.equal(saved.effort, 'low'); assert.deepEqual(await state(), before); assert.equal(runs.length, 0);
    await page.reload(); await menu.click(); await expect(effort).toHaveValue('low');
    // Conflict: another settings client saves while this dialog retains its draft.
    await effort.selectOption('medium');
    assert.equal((await fetch(url + '/api/project/codex', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model', effort: 'medium', version: saved.version }) })).status, 200);
    await dialog.getByRole('button', { name: '설정 저장', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('다른 화면'); await expect(effort).toHaveValue('medium');
    await dialog.getByRole('button', { name: '최신 설정 확인', exact: true }).click(); await expect(effort).toHaveValue('medium');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await page.getByRole('button', { name: 'AI 제외 추천', exact: true }).click(); await expect(page.getByRole('region', { name: 'AI 페이지 제외 추천' })).toContainText('제외할 페이지를 추천하지 않았습니다'); assert.deepEqual(runs, [['test-model', 'medium']]);
    await page.getByRole('button', { name: 'AI 응답 닫기', exact: true }).click();
    // Probe failure is not a disconnected project's destructive reset.
    failed = true; await menu.click(); await dialog.getByRole('button', { name: '연결 확인', exact: true }).click();
    await expect(dialog).toContainText('Codex 연결 실패'); await expect(dialog.getByRole('alert')).toContainText('Synthetic connection unavailable'); await expect(dialog.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled(); assert.equal((await settings()).settings.model, 'test-model');
    failed = false; await dialog.getByRole('button', { name: '연결 확인', exact: true }).click(); await expect(effort).toHaveValue('medium');
    for (const theme of ['light', 'dark']) {
      if (await dialog.count()) await dialog.getByRole('button', { name: '취소', exact: true }).click();
      await page.getByRole('button', { name: theme === 'light' ? '밝은 테마' : '어두운 테마', exact: true }).click();
      for (const width of [1512, 1024, 375, 320]) {
        await page.setViewportSize({ width, height: 982 }); await expect(menu).toBeVisible(); await menu.click();
        await expect(dialog).toContainText('Codex 연결 확인됨'); await expect(effort).toHaveValue('medium');
        const metrics = await dialog.evaluate(node => {
          const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
          const note = node.querySelector('.project-settings-note'), style = getComputedStyle(note), background = getComputedStyle(node).backgroundColor, values = [luminance(style.color), luminance(background)].sort((a,b) => b-a);
          return { overflow: document.documentElement.scrollWidth > innerWidth, contrast: (values[0]+.05)/(values[1]+.05), sizes: [...node.querySelectorAll('button,select')].map(n => { const r=n.getBoundingClientRect(); return [r.width,r.height]; }) };
        });
        assert.equal(metrics.overflow, false); assert.ok(metrics.contrast >= 4.5); assert.ok(metrics.sizes.every(([w,h]) => w >= 44 && h >= 44));
        await page.screenshot({ path: `qa/project-codex-settings-${theme}-${width}.png` }); await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
      }
    }
    assert.deepEqual(await state(), before);
    // Actual process replacement, controlling only this own temporary DB server.
    await app.close(); app = null;
    child = await startProcess(fixtureProject, dbPath, new URL('./fixtures/role-annotation-options.mjs', import.meta.url).href); url = child.url;
    await page.goto(url); await menu.click(); await expect(dialog).toContainText('Codex 연결 미확인'); await expect(model).toHaveValue('test-model'); await expect(effort).toHaveValue('medium');
    await dialog.getByRole('button', { name: '연결 확인', exact: true }).click(); await expect(dialog).toContainText('Codex 연결 확인됨'); assert.deepEqual(await state(), before); assert.deepEqual(errors, []);
    console.log('Project Codex settings browser passed: catalogue-only probe, shared page request, save/cancel/reload/child restart, conflict drafts, failure recovery, focus containment/return, 8 actual-document layout/contrast/44px captures; independent DB, no actual model.');
  } finally { await page.close(); if (app) await app.close(); await child?.stop(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-project-settings-')); await rm(directory, { recursive: true, force: true }); }
}
