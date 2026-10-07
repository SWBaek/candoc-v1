// Synthetic protocol fixture. Never invokes a model or the real Codex binary.
import readline from 'node:readline';
import assert from 'node:assert/strict';
const mode = process.argv[2] ?? 'success';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, value) => send({ id, result: value });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  if (msg.method === 'initialize') return result(msg.id, {});
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return result(msg.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  if (msg.method === 'model/list') return result(msg.id, { data: [{ model: 'test-model', displayName: 'Synthetic local model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null });
  assert.notEqual(mode, 'catalogue-only', 'connection verification must not start a model turn or read task configuration');
  if (msg.method === 'config/read') return result(msg.id, { config: { mcp_servers: { fixture: {} } } });
  if (msg.method === 'thread/start') {
    assert.equal(msg.params.sandbox, 'read-only'); assert.equal(msg.params.ephemeral, true); assert.equal(msg.params.approvalPolicy, 'never');
    for (const key of ['features.apps', 'features.plugins', 'features.multi_agent', 'mcp_servers.fixture.enabled']) assert.equal(msg.params.config[key], false);
    return result(msg.id, { thread: { id: 'annotation-thread' } });
  }
  if (msg.method === 'turn/interrupt') return result(msg.id, {});
  assert.equal(msg.method, 'turn/start'); assert.equal(msg.params.input.length, 1, 'no image is sent'); assert.equal(msg.params.input[0].type, 'text'); assert.equal(msg.params.effort, 'medium');
  const text = msg.params.input[0].text;
  const actualChars = [...text].length;
  if (mode === 'rpc-size-error') return send({id:msg.id,error:{code:-32602,message:'Synthetic PRIVATE upstream detail',data:{input_error_code:'input_too_large',max_chars:1048576,actual_chars:2221003}}});
  if (actualChars > 1048576) return send({id:msg.id,error:{code:-32602,message:'Input exceeds the maximum length of 1048576 characters.',data:{input_error_code:'input_too_large',max_chars:1048576,actual_chars:actualChars}}});
  const packet = JSON.parse(text.slice(text.indexOf('자료:\n') + 4));
  assert.equal(packet.format, 'candoc-role-annotation-v1');
  const context = { ...packet, items: packet.items.map(row => {
    const item = Object.fromEntries(packet.itemColumns.map((key,index) => [key,row[index]]));
    item.provenance = item.provenance.map(prov => ({ ...prov, bbox: Array.isArray(prov.bbox) ? Object.fromEntries(packet.bboxColumns.map((key,index)=>[key,prov.bbox[index]])) : prov.bbox }));
    if (item.orig === null) item.orig = item.text;
    return item;
  }) };
  assert.ok(context.annotation.rect); assert.ok(context.annotation.matches.length); assert.ok(context.items.every(item => item.provenance.length));
  if (mode !== 'actual-empty') assert.ok(context.items.find(item => item.ref === '#/texts/9').provenance.some(prov => prov.charspan?.[0] === 2));
  result(msg.id, { turn: { id: 'annotation-turn' } });
  if (mode === 'hang') return;
  const refs = context.items.filter(item => /^(report\s+header|report|header)$/i.test(item.text.trim())).map(item => item.ref);
  if (mode === 'invalid') refs.push('#/texts/999999');
  const params = { threadId: 'annotation-thread', turnId: 'annotation-turn' };
  if (mode === 'actual-empty') { assert.ok(context.pages.every(page=>Number.isFinite(page.width)&&Number.isFinite(page.height))); send({method:'item/completed',params:{...params,item:{type:'agentMessage',phase:'final_answer',text:'{"suggestions":[]}'}}}); send({method:'turn/completed',params:{threadId:'annotation-thread',turn:{id:'annotation-turn',status:'completed'}}}); return; }
  send({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ suggestions: [{ reason: '합성 검증 응답: 같은 상단 문구와 분리된 두 줄을 JSON 위치로 대조함', region: 'header', role: 'header', refs }] }) } } });
  send({ method: 'turn/completed', params: { threadId: 'annotation-thread', turn: { id: 'annotation-turn', status: 'completed' } } });
});
