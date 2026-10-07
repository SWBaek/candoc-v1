import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { runAnnotationSuggestions } from '../server/role-annotations.mjs';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';
import { fixtureProject, fixtureJson } from './local-fixture.mjs';
import { configureProjectModel } from './project-codex-settings-browser.mjs';

export async function checkActualAnnotationInputUI(browser) {
  const dir=await mkdtemp(path.join(tmpdir(),'candoc-annotation-input-')),bytes=await readFile(fixtureJson);
  const executable=fileURLToPath(new URL('./fixtures/fake-role-annotation-app-server.mjs',import.meta.url));
  const launch=mode=>({executable:process.execPath,args:[executable,mode]}); let requests=0;
  const app=createReviewApp({projectDir:fixtureProject,dbPath:path.join(dir,'review.sqlite'),
    codexModelRunner:args=>runCodexSuggestions({...args,catalogue:true,launch:launch('catalogue-only'),timeoutMs:5000}),
    roleAnnotationRunner:args=>runAnnotationSuggestions({...args,launch:launch(++requests===1?'rpc-size-error':'actual-empty'),timeoutMs:5000})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${app.server.address().port}`;
  const get=async endpoint=>(await(await fetch(url+endpoint)).json()), state=()=>get('/api/review');
  const page=await browser.newPage({viewport:{width:1512,height:982}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    const source=await get('/api/document'),review=await state();
    const response=await fetch(url+'/api/review/role-annotations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:review.revision,sourceHash:source.sourceHash,ruleHash:source.ruleHash,page:17,rect:{left:.14,top:.045,width:.73,height:.04},comment:'같은 머리말을 찾아줘'})}); assert.equal(response.status,200);
    await page.goto(url);await page.locator('[data-stage-id="3"]').click();await page.getByLabel('영역 검수 보기',{exact:true}).selectOption('annotate');await page.getByRole('button',{name:'주석·AI 응답',exact:true}).click();
    await configureProjectModel(page); const before=await state();
    await page.locator('.legacy-annotation-request > summary').click(); const request=page.getByRole('button',{name:'이 주석으로 Agent에 요청',exact:true});await request.click();
    await expect(page.locator('.role-annotation-thread [role="alert"]')).toContainText('turn/start'); await expect(page.locator('.role-annotation-thread [role="alert"]')).toContainText('2,221,003자 / 최대 1,048,576자');
    assert.ok(!(await page.locator('.role-annotation-thread').textContent()).includes('PRIVATE'));assert.deepEqual(await state(),before);
    await page.reload();await page.getByLabel('영역 검수 보기',{exact:true}).selectOption('annotate');await page.getByRole('button',{name:'주석·AI 응답',exact:true}).click();await expect(page.locator('.role-annotation-thread [role="alert"]')).toContainText('1,048,576자');
    await page.locator('.legacy-annotation-request > summary').click(); await request.click();await expect(page.locator('.role-annotation-thread')).toContainText('추천 대상이 없습니다. 검수 완료나 오류 없음 판정은 아닙니다.');
    const context=await get('/api/role-annotations');assert.equal(context.jobs[0].status,'completed');assert.equal(context.jobs[1].status,'failed');assert.equal(context.annotations.length,1);assert.equal(requests,2);assert.deepEqual(await state(),before);assert.deepEqual(errors,[]);assert.deepEqual(await readFile(fixtureJson),bytes);
    await page.screenshot({path:'qa/annotation-input-actual-1512.png'});
    console.log('Actual annotation input browser passed: complete real document packet under engine limit, safe size/RPC error, failed job reload and explicit retry, retained annotation and unchanged judgments; synthetic provider only.');
  } finally {await page.close();await app.close();assert.equal(path.dirname(dir),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('candoc-annotation-input-'));await rm(dir,{recursive:true,force:true});}
}
