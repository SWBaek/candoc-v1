// Protocol fixture, not an AI model. It checks the client contract before returning data.
import readline from 'node:readline';
import assert from 'node:assert/strict';
const mode = process.argv[2] ?? 'success';
let initialized = false, ready = false, outstanding;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, value) => send({ id, result: value });
function complete() {
  const params = { threadId: 'thread-test', turnId: 'turn-test' };
  if (mode !== 'no-final') send({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', phase: 'final_answer', text: mode === 'bad-json' ? 'not JSON' : JSON.stringify(mode === 'heading' ? { suggestions: [{ reason: '부모와 하위 제목의 수준을 함께 대조', changes: [{ ref: '#/texts/1', isHeading: true, level: 2, parentRef: '#/texts/0', sectionNumber: '2' }, { ref: '#/texts/2', isHeading: true, level: 3, parentRef: '#/texts/1', sectionNumber: '3' }] }] } : { suggestions: [{ pages: [1, 3], reason: '표지와 목차' }] }) } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: mode === 'failed-turn' ? 'failed' : 'completed' } } });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (!msg.method) { assert.equal(msg.id, outstanding); assert.equal(msg.error.code, -32601); complete(); return; }
  if (msg.method === 'initialize') { assert.ok(!initialized); initialized = true; result(msg.id, {}); return; }
  if (msg.method === 'initialized') { ready = true; return; }
  assert.ok(ready, 'handshake must finish before any RPC');
  if (msg.method === 'account/read') { result(msg.id, { account: mode === 'unauthenticated' ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true }); return; }
  if (msg.method === 'model/list') { result(msg.id, { data: [{ model: 'test-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }], nextCursor: null }); return; }
  if (msg.method === 'config/read') { result(msg.id, { config: { mcp_servers: { fixture: {} } } }); return; }
  if (msg.method === 'thread/start') {
    assert.equal(msg.params.sandbox, 'read-only'); assert.equal(msg.params.approvalPolicy, 'never'); assert.equal(msg.params.ephemeral, true);
    assert.equal(msg.params.config['mcp_servers.fixture.enabled'], false);
    assert.equal(msg.params.config['features.apps'], false); assert.equal(msg.params.config['features.plugins'], false);
    result(msg.id, { thread: { id: 'thread-test' } }); return;
  }
  if (msg.method === 'turn/interrupt') { result(msg.id, {}); return; }
  assert.equal(msg.method, 'turn/start');
  assert.ok(msg.params.outputSchema.properties.suggestions); if (mode === 'heading') assert.equal(msg.params.effort, 'medium');
  if (mode === 'rpc-size-error' || mode === 'rpc-invalid') return send({id:msg.id,error:{code:-32602,message:'PRIVATE prompt and account details must not leak',data:mode==='rpc-size-error'?{input_error_code:'input_too_large',max_chars:1048576,actual_chars:2221003}:{secret:'must not leak'}}});
  result(msg.id, { turn: { id: 'turn-test' } });
  send({ method: 'turn/started', params: { threadId: 'thread-test', turn: { id: 'turn-test' } } });
  send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test', item: { type: 'agentMessage', phase: 'commentary', text: '{"suggestions":[{"pages":[999],"reason":"중간 답변"}]}' } } });
  if (mode === 'hang') return;
  if (mode === 'exit') { process.exit(0); }
  if (mode === 'tool-request') { outstanding = 900; send({ method: 'item/tool/call', id: outstanding, params: { name: 'write_file' } }); return; }
  complete();
});
