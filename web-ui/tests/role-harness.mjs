import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createReviewApp } from '../server/app.mjs';
import { roleDocument, pixelPng } from './fixtures/role-document.mjs';
export async function harness(t, document = roleDocument()) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'candoc-roles-')), dbPath = path.join(projectDir, 'inspection/review.sqlite');
  await mkdir(path.join(projectDir, 'raw/artifacts'), { recursive: true });
  const jsonPath = path.join(projectDir, 'raw/ieee1547-document.json'), bytes = JSON.stringify(document);
  await writeFile(jsonPath, bytes); await writeFile(path.join(projectDir, 'raw/artifacts/page.png'), pixelPng);
  let app, url;
  async function start() { app = createReviewApp({ projectDir, dbPath }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.server.address().port}`; }
  await start();
  const call = async (endpoint, body) => { const response = await fetch(url + endpoint, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); return { status: response.status, data: await response.json() }; };
  t.after(async () => { await app.close(); assert.equal(await readFile(jsonPath, 'utf8'), bytes); assert.equal(path.dirname(projectDir), path.resolve(tmpdir())); assert.ok(path.basename(projectDir).startsWith('candoc-roles-')); await rm(projectDir, { recursive: true, force: true }); });
  const state = async () => (await call('/api/review')).data;
  const put = async (endpoint, body) => call(endpoint, { revision: (await state()).revision, ...body });
  return { call, state, put, dbPath, get app() { return app; }, restart: async () => { await app.close(); await start(); } };
}
