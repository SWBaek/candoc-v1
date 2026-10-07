// Optional installed-Codex protocol verification. All Responses requests are
// forced to a local synthetic SSE provider. No model or review DB is used.
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';
import { projectAgentTools, projectAgentInstructions } from '../server/project-agent.mjs';
let requests = 0, calls = 0, threadId;
const directory = await mkdtemp(path.join(tmpdir(), 'candoc-agent-protocol-')), home = path.join(directory, 'codex-home'), cwd = path.join(directory, 'workspace');
await mkdir(home); await mkdir(cwd);
const stub = http.createServer(async (req, res) => {
  const parts = []; for await (const part of req) parts.push(part); const body = JSON.parse(Buffer.concat(parts).toString()); requests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  const item = requests % 2 === 1 ? { type: 'function_call', id: `fc_${requests}`, call_id: `call_${requests}`, name: 'candoc_query', arguments: '{"operation":"summary"}' } : { type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local synthetic response. No model inference.', annotations: [] }] };
  const response = { id: `resp_${requests}`, object: 'response', status: 'in_progress', model: body.model, output: [] };
  event('response.created', { response }); event('response.output_item.added', { output_index: 0, item }); event('response.output_item.done', { output_index: 0, item }); event('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${stub.address().port}/v1`, executable = process.env.CANDOC_CODEX_EXECUTABLE ?? (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe') : 'codex');
const launch = { executable, args: ['app-server', '--listen', 'stdio://', '-c', 'model_provider="candoc_validation"', '-c', `model_providers.candoc_validation={name="Local synthetic stub",base_url="${base}",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`], env: { ...process.env, CODEX_HOME: home } };
for (const key of ['CODEX_CI', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_VERSION']) delete launch.env[key];
try {
  for (let i = 0; i < 2; i++) {
    const result = await runCodexSuggestions({ cwd, launch, timeoutMs: 15000, selectedEffort: 'low', taskInstructions: projectAgentInstructions, taskPrompt: 'Local synthetic provider only. No external inference.', conversation: {
      threadId, tools: projectAgentTools, onThread(id) { if (threadId) assert.equal(id, threadId); threadId = id; },
      callTool(name, args) { assert.equal(name, 'candoc_query'); assert.deepEqual(args, { operation: 'summary' }); calls++; return { name: 'Local synthetic fixture', partial: true }; }
    } }); assert.match(result, /No model inference/);
  }
  assert.equal(calls, 2); assert.equal(requests, 4);
  console.log(JSON.stringify({ sameThreadResumed: true, hostToolCalls: calls, localRequests: requests, externalInference: false, recommendationQualityVerified: false }));
} finally {
  await new Promise(resolve => stub.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-agent-protocol-')); await rm(directory, { recursive: true, force: true });
}
