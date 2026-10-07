// A local protocol simulator: no Codex process, credentials, network, or inference.
import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2];
const state = existsSync(file) ? JSON.parse(readFileSync(file)) : { thread: null, starts: 0, resumes: 0, messages: [], tools: [], prompts: [] };
const persist = () => writeFileSync(file, JSON.stringify(state));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
let counter = 0, turnId, packet, pending = new Map();
function tool(name, args) { const id = `host-${++counter}`; return new Promise(resolve => { pending.set(id, resolve); send({ id, method: 'item/tool/call', params: { threadId: state.thread, turnId, callId: id, tool: name, arguments: args } }); }); }
function complete(text, status = 'completed') { send({ method: 'item/completed', params: { threadId: state.thread, turnId, item: { type: 'agentMessage', phase: 'final_answer', text } } }); send({ method: 'turn/completed', params: { threadId: state.thread, turn: { id: turnId, status } } }); }
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const msg = JSON.parse(line);
  if (!msg.method) { pending.get(msg.id)?.(msg); pending.delete(msg.id); return; }
  if (msg.method === 'initialize') { assert.equal(msg.params.capabilities.experimentalApi, true); return reply(msg.id, {}); }
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return reply(msg.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  if (msg.method === 'model/list') return reply(msg.id, { data: [{ model: 'test-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null });
  if (msg.method === 'config/read') return reply(msg.id, { config: { mcp_servers: { forbidden: {} } } });
  if (['thread/start', 'thread/resume'].includes(msg.method)) {
    assert.equal(msg.params.sandbox, 'read-only'); assert.equal(msg.params.approvalPolicy, 'never');
    for (const key of ['features.apps', 'features.plugins', 'features.multi_agent', 'features.shell_tool', 'features.apply_patch_freeform', 'mcp_servers.forbidden.enabled']) assert.equal(msg.params.config[key], false);
    assert.equal(msg.params.config.web_search, 'disabled');
    if (msg.method === 'thread/start') { assert.equal(msg.params.ephemeral, false); state.thread = 'project-fixture-thread'; state.starts++; state.tools = msg.params.dynamicTools; assert.ok(state.tools.every(row => row.type === 'function')); }
    else { assert.equal(msg.params.threadId, state.thread); assert.equal(msg.params.dynamicTools, undefined); state.resumes++; }
    persist(); return reply(msg.id, { thread: { id: state.thread } });
  }
  if (msg.method === 'turn/interrupt') { reply(msg.id, {}); complete('', 'interrupted'); return; }
  assert.equal(msg.method, 'turn/start'); assert.equal(msg.params.outputSchema, undefined); assert.equal(msg.params.effort, 'medium'); assert.equal(msg.params.input.length, 1); assert.equal(msg.params.input[0].type, 'text');
  packet = JSON.parse(msg.params.input[0].text); state.messages.push(packet.message); state.prompts.push(msg.params.input[0].text.length); persist();
  assert.ok(msg.params.input[0].text.length < 16000, 'the prompt must not contain the whole document');
  turnId = `turn-${state.messages.length}`; reply(msg.id, { turn: { id: turnId } });
  if (packet.message === 'hang') return;
  if (packet.message === 'unknown-tool') { const r = await tool('delete_everything', {}); assert.equal(r.error.code, -32601); complete('합성: 알 수 없는 도구는 거부됐습니다.'); return; }
  if (packet.message === 'chat') { const r = await tool('candoc_query', { operation: 'summary' }); assert.equal(r.result.success, true); complete(`합성 대화 ${state.messages.length}: 이전 요청 ${state.messages[0]} · 현재 단계 ${packet.attachment.stage}`); return; }
  const refs = []; let offset = 0;
  do {
    const response = await tool('candoc_query', { operation: 'pattern', offset, limit: 2 });
    if (!response.result?.success) { complete('합성: 조회 한계로 확인을 보류합니다.'); return; }
    const result = JSON.parse(response.result.contentItems[0].text);
    assert.ok(result.rows.every(row => row.provenance.length && typeof row.orig === 'string'));
    refs.push(...result.rows.filter(row => /^(report\s+header|report|header)$/i.test(row.text.trim())).map(row => row.ref)); offset = result.nextOffset;
  } while (offset !== null);
  const result = await tool('candoc_propose_roles', { reason: '합성 검증: 위치 후보를 조회한 뒤 같은 문구와 분리된 두 줄을 비교했습니다.', region: 'header', role: 'header', refs: packet.message === 'invalid-ref' ? ['#/texts/999999'] : packet.message === 'unread-ref' ? ['#/texts/7'] : refs });
  if (['invalid-ref','unread-ref'].includes(packet.message)) assert.equal(result.result.success, false);
  else assert.equal(result.result.success, true, result.result.contentItems[0].text);
  complete('합성 검증 응답: 반복 머리말 변경안을 만들었습니다. 승인 전에는 저장되지 않습니다.', packet.message === 'fail-after-proposal' ? 'failed' : 'completed');
});
