import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { fixtureProject } from './local-fixture.mjs';
import { readingDocument, pixelPng, seedReadingRoles } from './fixtures/reading-document.mjs';

// Only children created here are controlled. They always use a synthetic
// fixture, an isolated DB, a dynamic port and the explicitly isolated build.
async function startProcess(projectDir, dbPath) {
  assert.ok(process.env.CANDOC_BUILD_DIR && process.env.CANDOC_BUILD_DIR !== 'dist');
  const moduleUrl = new URL('../server/app.mjs', import.meta.url).href;
  const code = `import { createReviewApp } from ${JSON.stringify(moduleUrl)}; const app = createReviewApp({projectDir:process.argv[1],dbPath:process.argv[2]}); app.server.listen(0,'127.0.0.1',()=>console.log('TEST_URL=http://127.0.0.1:'+app.server.address().port)); process.on('SIGTERM',async()=>{await app.close();process.exit(0)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, projectDir, dbPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('isolated server startup timed out')); }, 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`isolated server exit ${code}: ${output}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  return { url, pid: child.pid, stop: async () => { if (child.exitCode !== null) return; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); } };
}

export async function checkReadingUI(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-reading-browser-')), dbPath = path.join(directory, 'inspection/review.sqlite');
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true });
  const bytes = JSON.stringify(readingDocument()), jsonPath = path.join(directory, 'raw/ieee1547-document.json');
  await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  let server = await startProcess(directory, dbPath), url = server.url;
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await fetch(url + '/api/review')).json();
  const put = async (endpoint, body) => { const response = await fetch(url + endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await state()).revision, ...body }) }); return { status: response.status, data: await response.json() }; };
  const up = page.getByRole('button', { name: '#/texts/0@0 위로 이동', exact: true });
  const saveOrder = page.getByRole('button', { name: '영역 순서 판단 저장', exact: true });
  const cancel = page.getByRole('button', { name: '순서·연결 초안 취소', exact: true });
  const reason = page.locator('#reading-reason'), status = page.locator('#reading-status');
  const prompt = page.getByRole('dialog', { name: '저장하지 않은 변경이 있습니다.', exact: true });
  try {
    assert.equal((await put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' })).status, 200);
    await seedReadingRoles(put, (await (await fetch(url + '/api/reading-review')).json()).items);
    await page.goto(url); await page.locator('[data-stage-id="4"]').click();
    await expect(page.locator('.reading-order-list li')).toHaveCount(2);
    await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/1');
    await expect(page.getByRole('button', { name: '읽기 순서·연결 완료 기록', exact: true })).toBeDisabled();
    const before = await state();
    await up.press('Enter'); await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/0');
    assert.deepEqual((await state()).orderReviews, before.orderReviews);
    await page.getByRole('button', { name: '원본 순서로 초안 복원', exact: true }).click();
    await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/1');
    await up.click(); await cancel.click(); await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/1');
    await up.click(); await status.selectOption('error'); await reason.fill('다단 읽기 순서를 원문 위치와 대조한 변경안'); await saveOrder.click();
    await expect(page.locator('.saved-status')).toHaveText('저장됨');
    let saved = await state(); assert.deepEqual(saved.orderReviews[0].order, ['#/texts/0@0', '#/texts/1@0']);
    await page.reload(); await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/0'); await expect(reason).toHaveValue('다단 읽기 순서를 원문 위치와 대조한 변경안');
    await page.getByRole('button', { name: '원본 순서로 초안 복원', exact: true }).click();
    await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/1');
    assert.deepEqual((await state()).orderReviews, saved.orderReviews);
    await cancel.click(); await expect(page.locator('.reading-order-list li').first()).toContainText('#/texts/0');
    await page.getByRole('button', { name: '원본 순서로 초안 복원', exact: true }).click(); await status.selectOption('normal'); await reason.fill('원본 순서로 복원하여 원문 대조'); await saveOrder.click();
    await expect(page.locator('.saved-status')).toHaveText('저장됨');
    await reason.fill('이동 시 보존할 초안'); await page.getByRole('button', { name: '페이지 경계 연결', exact: true }).click(); await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: '현재 화면 유지', exact: true }).click(); await expect(reason).toHaveValue('이동 시 보존할 초안');
    await page.getByRole('button', { name: '페이지 경계 연결', exact: true }).click(); await prompt.getByRole('button', { name: '초안 취소 후 이동', exact: true }).click();
    await expect(page.locator('.reading-page-pair img')).toHaveCount(2);
    await page.getByRole('button', { name: '연결 항목 추가', exact: true }).click();
    await page.getByLabel('연결 1 앞 출처', { exact: true }).selectOption('#/texts/0@0');
    await page.getByLabel('연결 1 뒤 출처', { exact: true }).selectOption('#/texts/2@0');
    await page.getByLabel('연결 1 관계', { exact: true }).selectOption('continuation');
    await page.getByRole('button', { name: '연결 항목 추가', exact: true }).click();
    await page.getByLabel('연결 2 앞 출처', { exact: true }).selectOption('#/tables/0@0');
    await page.getByLabel('연결 2 뒤 출처', { exact: true }).selectOption('#/tables/1@0');
    await page.getByLabel('연결 2 내용 유형', { exact: true }).selectOption('table'); await page.getByLabel('연결 2 관계', { exact: true }).selectOption('continuation');
    await status.selectOption('normal'); await reason.fill('양쪽 문단과 표의 이어짐을 각각 대조'); await page.getByRole('button', { name: '페이지 연결 판단 저장', exact: true }).click(); await expect(page.locator('.saved-status')).toHaveText('저장됨');
    saved = await state(); assert.equal(saved.boundaryReviews[0].links.length, 2);
    await page.getByRole('checkbox', { name: '양쪽 경계를 확인했고 연결할 항목 없음', exact: true }).check(); await cancel.click(); await expect(page.locator('.reading-link')).toHaveCount(2);
    await page.reload(); await page.getByRole('button', { name: '페이지 경계 연결', exact: true }).click(); await expect(page.locator('.reading-link')).toHaveCount(2);
    const oldPid = server.pid; await page.goto('about:blank'); await server.stop(); server = await startProcess(directory, dbPath); url = server.url; assert.notEqual(server.pid, oldPid);
    assert.deepEqual(await state(), saved); await page.goto(url); await page.getByRole('button', { name: '페이지 경계 연결', exact: true }).click(); await expect(page.locator('.reading-link')).toHaveCount(2);
    await expect(reason).toHaveValue('양쪽 문단과 표의 이어짐을 각각 대조');
    // Out-of-date revision must preserve the draft and both stored links.
    await reason.fill('충돌 중 보존할 연결 초안'); await put('/api/review/stages/6', { action: 'save_note', note: '다른 창 변경' });
    await page.getByRole('button', { name: '페이지 연결 판단 저장', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('다른 화면에서'); await expect(reason).toHaveValue('충돌 중 보존할 연결 초안'); assert.deepEqual((await state()).boundaryReviews, saved.boundaryReviews);
    await cancel.click(); await page.reload(); await page.getByRole('button', { name: '페이지 경계 연결', exact: true }).click();
    await page.getByLabel('유지 페이지 경계 선택', { exact: true }).selectOption('2:3'); await page.getByRole('checkbox', { name: '양쪽 경계를 확인했고 연결할 항목 없음', exact: true }).check(); await status.selectOption('normal'); await reason.fill('연결 없음 원문 대조');
    await page.getByRole('button', { name: '페이지 연결 판단 저장', exact: true }).click(); await expect(page.locator('.saved-status')).toHaveText('저장됨'); assert.equal((await state()).boundaryReviews.find(r => r.id === '2:3').noConnection, true);
    await put('/api/review/pages/2', { status: 'excluded', reason: '중간 페이지 제외', note: '', evidence: 'json' }); await page.reload(); await page.getByRole('button', { name: '페이지 경계 연결', exact: true }).click();
    await expect(page.getByLabel('유지 페이지 경계 선택', { exact: true })).toHaveValue('1:3'); await expect(page.locator('.reading-review')).toContainText('사이에서 제외한 원본 페이지: 2'); assert.equal((await state()).boundaryReviews.some(r => r.id === '1:3'), false);
    await page.goto('about:blank'); await server.stop();
    const diagnosticProject = path.join(directory, 'diagnostic'); await mkdir(path.join(diagnosticProject, 'raw/artifacts'), { recursive: true });
    const broken = readingDocument(); broken.groups[0].children.push({ $ref: '#/groups/0' }, { $ref: '#/texts/999' }); broken.body.children.push({ $ref: '#/texts/0' }); broken.body.children = broken.body.children.filter(child => child.$ref !== '#/texts/2');
    await writeFile(path.join(diagnosticProject, 'raw/ieee1547-document.json'), JSON.stringify(broken)); await writeFile(path.join(diagnosticProject, 'raw/artifacts/page.png'), pixelPng);
    server = await startProcess(diagnosticProject, path.join(diagnosticProject, 'review.sqlite')); url = server.url;
    await put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' }); const diagnosticData = await (await fetch(url + '/api/reading-review')).json(); await seedReadingRoles(put, diagnosticData.items);
    await page.goto(url); await page.locator('[data-stage-id="4"]').click(); await page.locator('.reading-diagnostics summary').press('Enter');
    for (const label of ['순환 참조', '중복 트리 참조', '없는 참조', '루트에서 도달 불가']) await expect(page.locator('.reading-diagnostics')).toContainText(label);
    await expect(page.locator('#reading-status option[value="normal"]')).toBeDisabled(); await expect(page.getByRole('button', { name: '표시 목록으로 초안 되돌림', exact: true })).toBeVisible();
    await expect(page.locator('.reading-review')).toContainText('누락 순서를 추정하지 않으며 정상 확정을 제한합니다');
    assert.equal(diagnosticData.scopes.flatMap(s => s.entries).length, 9);
    await page.screenshot({ path: 'qa/reading-tree-diagnostics.png' });
    assert.deepEqual(errors, []); assert.equal(await readFile(jsonPath, 'utf8'), bytes);
    console.log('Stage 4 browser workflow passed: column order, keyboard, original draft restore/cancel, save/reload, multi-links/explicit none, navigation guard, real revision conflict, actual child-process restart, excluded gaps and all four tree diagnostics/normal gate. Isolated fixture/DB/build, no model calls.');
  } finally { await page.close(); await server.stop(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-reading-browser-')); await rm(directory, { recursive: true, force: true }); }
}

export async function checkActualReadingLayout(browser) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-real-reading-layout-'));
  const app = createReviewApp({ projectDir: fixtureProject, dbPath: path.join(directory, 'review.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${app.server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, hasTouch: true }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.locator('[data-stage-id="4"]').click(); await expect(page.locator('.reading-order-list')).toBeVisible();
    const data = await (await fetch(url + '/api/reading-review')).json();
    const roleData = await (await fetch(url + '/api/role-elements')).json();
    assert.deepEqual(data.items, roleData.items);
    assert.equal(data.scopes.flatMap(s => s.entries).length, data.items.filter(i => !i.ref.startsWith('#/groups/')).reduce((n, i) => n + Math.max(1, i.provenance.length), 0));
    await expect(page.locator('#reading-status option[value="normal"]')).toBeDisabled();
    for (const theme of ['밝은 테마', '어두운 테마']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      for (const width of [1512, 1024, 375, 320]) {
        await page.setViewportSize({ width, height: 982 });
        for (const mode of ['영역 안 읽기 순서', '페이지 경계 연결']) {
          await page.getByRole('button', { name: mode, exact: true }).click();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} overflow ${width} ${theme}`);
          for (const control of await page.locator('.reading-review button, .reading-review select, .reading-review input, .reading-review summary').all()) { const box = await control.boundingBox(); if (box) assert.ok(box.width >= 44 && box.height >= 44, `reading touch target ${await control.textContent()}`); }
          const contrast = await page.locator('.role-scope-note').first().evaluate(element => {
            const lum = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const levels = [lum(getComputedStyle(element).color), lum(getComputedStyle(element.closest('.app-shell')).backgroundColor)].sort((a, b) => b - a);
            return { ratio: (levels[0] + .05) / (levels[1] + .05), font: parseFloat(getComputedStyle(element).fontSize) };
          });
          assert.ok(contrast.ratio >= 4.5 && contrast.font >= 12);
          if (mode === '영역 안 읽기 순서' && [1512, 375].includes(width)) await page.screenshot({ path: `qa/reading-${theme === '밝은 테마' ? 'light' : 'dark'}-${width}.png` });
        }
      }
      await page.setViewportSize({ width: 1512, height: 982 });
    }
    const state = await (await fetch(url + '/api/review')).json(); assert.equal(state.orderReviews.length, 0); assert.equal(state.boundaryReviews.length, 0); assert.equal(state.roleReviews.length, 0); assert.ok(state.stages.every(s => s.status === 'pending')); assert.deepEqual(errors, []);
    console.log(`Stage 4 actual-input layout passed: ${data.scopes.length} regions/${data.boundaries.length} boundaries/all provenance preserved, two modes/themes, 1512/1024/375/320px, contrast, 44px touch. Isolated DB; no auto judgments or model calls.`);
  } finally { await context.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-real-reading-layout-')); await rm(directory, { recursive: true, force: true }); }
}
