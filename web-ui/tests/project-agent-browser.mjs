import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';
import { startProcess } from './reading-browser.mjs';
import { roleAnnotationDocument } from './fixtures/role-annotation-document.mjs';
import { pixelPng } from './fixtures/role-document.mjs';
import { fixtureProject, fixtureJson } from './local-fixture.mjs';

const modelRunner = async () => [{ model: 'test-model', displayName: 'Synthetic local fixture', efforts: ['medium'], defaultEffort: 'medium' }];
async function configure(page) { await page.getByRole('button', { name: '설정', exact: true }).click(); const modal = page.getByRole('dialog', { name: '프로젝트 설정', exact: true }); await modal.getByRole('button', { name: '연결 확인', exact: true }).click(); await expect(page.getByLabel('프로젝트 모델', { exact: true })).toHaveValue('test-model'); await modal.getByRole('button', { name: '설정 저장', exact: true }).click(); }
export async function checkProjectAgentUI(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-project-agent-browser-')), dbPath = path.join(directory, 'inspection/review.sqlite'), file = path.join(directory, 'inspection/project-fixture-thread.json');
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true });
  const bytes = JSON.stringify(roleAnnotationDocument()), jsonPath = path.join(directory, 'raw/ieee1547-document.json'); await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  let server = await startProcess(directory, dbPath, new URL('./fixtures/project-agent-options.mjs', import.meta.url).href), url = server.url;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = []; page.on('pageerror', e => errors.push(e.message));
  const get = async endpoint => (await (await fetch(url + endpoint)).json()), state = () => get('/api/review');
  const put = async (endpoint, body) => { const response = await fetch(url + endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await state()).revision, ...body }) }); assert.equal(response.status, 200); return response.json(); };
  const panel = page.getByRole('complementary', { name: '프로젝트 검수 Agent', exact: true }), input = page.getByLabel('프로젝트 Agent 메시지', { exact: true });
  try {
    await page.goto(url); await configure(page); await page.locator('[data-stage-id="3"]').click(); await page.getByLabel('영역 검수 보기', { exact: true }).selectOption('annotate'); await page.getByLabel('주석 원본 페이지', { exact: true }).selectOption('4');
    const image = page.locator('.role-annotation-canvas > img'); await image.scrollIntoViewIfNeeded(); await page.getByRole('button', { name: '영역 표시', exact: true }).click(); const bounds = await image.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * .08, bounds.y + bounds.height * .04); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .84, bounds.y + bounds.height * .13, { steps: 5 }); await page.mouse.up();
    await page.getByLabel('이 영역에 대한 코멘트', { exact: true }).fill('반복 머리말을 제안해'); await page.getByRole('button', { name: '주석 저장', exact: true }).click();
    await page.getByRole('button', { name: '프로젝트 Agent에 영역 첨부', exact: true }).click(); await expect(panel).toBeVisible(); await expect(input).toHaveValue('반복 머리말을 제안해'); await expect(panel).toContainText('4페이지 · 표시 영역 첨부');
    const before = await state(); await panel.getByRole('button', { name: '보내기', exact: true }).click(); await expect(panel.getByLabel('Agent 변경안', { exact: true })).toBeVisible(); assert.deepEqual(await state(), before);
    const group = panel.getByLabel('Agent 변경안', { exact: true }); await group.locator('summary').click(); await group.getByLabel('#/texts/11 Agent 대상', { exact: true }).uncheck(); await expect(group).toContainText('선택 5개 · 예외 1개');
    await group.locator('.project-agent-target').filter({ has: page.getByLabel('#/texts/1 Agent 대상', { exact: true }) }).getByRole('button', { name: '원본 위치', exact: true }).click();
    await expect(panel.getByLabel('Agent 원본 출처 페이지', { exact: true })).toHaveValue('2'); await expect(panel.getByAltText('Agent 대조 원본 2페이지', { exact: true })).toBeVisible(); await expect(panel.getByLabel('Agent 선택 요소 위치', { exact: true })).toHaveCount(1);
    await expect(page.getByLabel('주석 원본 페이지', { exact: true })).toHaveValue('2'); await expect(page.getByLabel('추천 대상 원본 위치', { exact: true })).toHaveCount(1);
    assert.deepEqual((await state()).roleReviews, before.roleReviews); assert.equal((await get('/api/project/agent')).turns[0].stale, false, 'locating is not a review change');
    await group.getByRole('button', { name: '선택한 5개 승인', exact: true }).click(); assert.deepEqual((await state()).roleReviews, before.roleReviews);
    await page.getByLabel('영역 검수 보기', { exact: true }).selectOption('questions'); await page.getByRole('button', { name: '보류', exact: true }).click(); await expect(group.getByRole('button', { name: '판단 저장', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '응답 취소', exact: true }).click(); await expect(group.getByRole('button', { name: '판단 저장', exact: true })).toBeEnabled();
    await group.getByRole('button', { name: '판단 저장', exact: true }).click(); await expect(group).toContainText('사용자 확인 후 5개 판단 저장'); const saved = await state(); assert.equal(saved.roleReviews.length, 5); assert.ok(!saved.roleReviews.some(row => row.ref === '#/texts/11'));
    await page.reload(); await expect(panel).toBeVisible(); await expect(panel).toContainText('사용자 확인 후 5개 판단 저장'); assert.deepEqual(await state(), saved);
    await page.locator('[data-stage-id="5"]').click(); await input.fill('chat'); await panel.getByRole('button', { name: '보내기', exact: true }).click(); await expect(panel).toContainText('현재 단계 5');
    await server.stop(); server = await startProcess(directory, dbPath, new URL('./fixtures/project-agent-options.mjs', import.meta.url).href); url = server.url; await page.goto(url); await page.getByRole('button', { name: '프로젝트 Agent 열기', exact: true }).click(); await expect(panel).toContainText('현재 단계 5');
    await input.fill('chat'); await panel.getByRole('button', { name: '보내기', exact: true }).click(); await expect(panel).toContainText('합성 대화 3'); const protocol = JSON.parse(await readFile(file)); assert.equal(protocol.starts, 1); assert.equal(protocol.resumes, 2);
    await page.locator('[data-stage-id="3"]').click(); await page.getByLabel('영역 검수 보기', { exact: true }).selectOption('annotate'); await page.getByRole('button', { name: '직전 일괄 판단 복원', exact: true }).click(); await expect.poll(async () => (await state()).roleReviews.length).toBe(0);
    await input.fill('hang'); await panel.getByRole('button', { name: '보내기', exact: true }).click(); await expect.poll(async () => JSON.parse(await readFile(file)).messages.at(-1)).toBe('hang');
    await server.stop(); server = await startProcess(directory, dbPath, new URL('./fixtures/project-agent-options.mjs', import.meta.url).href); url = server.url;
    const recovered = await get('/api/project/agent'); assert.equal(recovered.turns.at(-1).status, 'interrupted'); assert.equal(recovered.running, null); assert.equal(JSON.parse(await readFile(file)).messages.length, 4, 'restart must not retry inference'); assert.equal((await state()).roleReviews.length, 0);
    await page.goto(url); await page.getByRole('button', { name: '프로젝트 Agent 열기', exact: true }).click(); await expect(panel).toContainText('응답이 중단되었습니다.');
    for (const theme of ['light', 'dark']) for (const width of [1512, 1024, 375, 320]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; localStorage.setItem('candoc-theme', theme); }, theme); await page.setViewportSize({ width, height: 982 }); await expect(page.getByLabel('프로젝트 Agent 메시지', { exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `agent overflow ${theme}/${width}`);
      for (const target of [input, page.getByRole('button', { name: '프로젝트 Agent 닫기', exact: true })]) { const box = await target.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, `${theme}/${width} ${JSON.stringify(box)}`); }
      const contrast = await page.locator('.project-agent-panel').evaluate(node => { const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a,v,i) => a+v*[.2126,.7152,.0722][i],0); const fg = luminance(getComputedStyle(node.querySelector('small')).color), bg = luminance(getComputedStyle(node).backgroundColor); return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05); }); assert.ok(contrast >= 4.5);
      await page.screenshot({ path: `qa/project-agent-${theme}-${width}.png` });
    }
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '프로젝트 검수 Agent', exact: true })).toHaveCount(0); await page.getByRole('button', { name: '프로젝트 Agent 열기', exact: true }).click(); const drawer = page.getByRole('dialog', { name: '프로젝트 검수 Agent', exact: true }); await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '프로젝트 Agent 닫기', exact: true }).focus(); await page.keyboard.press('Shift+Tab'); assert.ok(await drawer.evaluate(node => node.contains(document.activeElement))); await page.keyboard.press('Escape');
    assert.deepEqual(errors, []); assert.equal(await readFile(jsonPath, 'utf8'), bytes);
    console.log('Project Agent UI passed: dragged region attachment, paginated queries, approval/save separation, exceptions, original bbox, unsaved protection, stage continuity, reload and real child-process restart/thread resume, restore, themes/viewports and drawer focus. Synthetic model only.');
  } finally { await page.close(); await server.stop(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-project-agent-browser-')); await rm(directory, { recursive: true, force: true }); }
}

export async function checkActualProjectAgentLayout(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-project-agent-actual-')), bytes = await readFile(fixtureJson), file = path.join(directory, 'fixture-thread.json');
  const app = createReviewApp({ projectDir: fixtureProject, dbPath: path.join(directory, 'review.sqlite'), codexModelRunner: modelRunner, projectAgentRunner: args => runCodexSuggestions({ ...args, launch: { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-project-agent-app-server.mjs', import.meta.url)), file] }, timeoutMs: 15000 }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${app.server.address().port}`, page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  try {
    const doc = await (await fetch(url + '/api/document')).json(), state = await (await fetch(url + '/api/review')).json();
    const response = await fetch(url + '/api/review/role-annotations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, page: 17, rect: { left: .14, top: .045, width: .73, height: .04 }, comment: '선택 영역을 기준으로 머리말을 함께 검토해줘' }) }); assert.equal(response.status, 200);
    await page.goto(url); await configure(page); await page.locator('[data-stage-id="3"]').click(); await page.getByLabel('영역 검수 보기', { exact: true }).selectOption('annotate'); await page.getByRole('button', { name: '주석·AI 응답', exact: true }).click(); await page.getByRole('button', { name: '프로젝트 Agent에 영역 첨부', exact: true }).click();
    await page.getByLabel('프로젝트 Agent 메시지', { exact: true }).fill('chat'); await page.getByRole('button', { name: '보내기', exact: true }).click(); await expect(page.locator('.project-agent-answer')).toBeVisible();
    await expect(page.getByLabel('주석 원본 페이지', { exact: true })).toHaveValue('17'); await expect(page.locator('.project-agent-composer')).toContainText('원본 17페이지'); await page.screenshot({ path: 'qa/project-agent-actual-chat-1512.png' });
    await page.getByRole('button', { name: '첨부 원본', exact: true }).click(); await expect(page.getByAltText('Agent 대조 원본 17페이지', { exact: true })).toBeVisible();
    for (const theme of ['light', 'dark']) for (const width of [1512, 1024, 375, 320]) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await page.setViewportSize({ width, height: 982 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: `qa/project-agent-actual-${theme}-${width}.png` }); }
    assert.deepEqual(await readFile(fixtureJson), bytes); console.log('Actual project Agent layouts passed: original IEEE PNG/bbox/JSON, shared conversation and attachment, two themes/1512/1024/375/320; synthetic answer, no real inference.');
  } finally { await page.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-project-agent-actual-')); await rm(directory, { recursive: true, force: true }); }
}
