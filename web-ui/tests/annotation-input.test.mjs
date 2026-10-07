import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { annotationRecommendationInput, runAnnotationSuggestions } from '../server/role-annotations.mjs';
import { codexMaxInputChars, inputCharacterCount, runCodexSuggestions } from '../server/codex-suggestions.mjs';
import { buildRoleSource } from '../server/role-review.mjs';
import { originalRole } from '../server/role-questions.mjs';
import { roleAnnotationDocument } from './fixtures/role-annotation-document.mjs';
import { fixtureJson } from './local-fixture.mjs';
import { harness } from './role-harness.mjs';
function context(document, reviewed = false) {
  const pages = Object.values(document.pages).map(p => ({number:p.page_no,width:p.size?.width??100,height:p.size?.height??100}));
  const items = buildRoleSource(document,new Map(pages.map(p=>[p.number,p]))).items.filter(i=>i.ref.startsWith('#/texts/') && i.provenance.some(p=>p.rect));
  return {pages:pages.map(p=>({page_no:p.number,width:p.width,height:p.height})),items,annotation:{page:17,rect:{left:.1,top:.04,width:.8,height:.06},comment:'전체 머리말을 확인해줘',matches:[{ref:items[0].ref,locations:[{provIndex:0,overlap:1}]}]},retainedPages:pages.map(p=>p.number),records:reviewed?items.map(item=>({ref:item.ref,...originalRole(item),parentRef:item.parentRef,status:'normal',needsReview:true,reason:'기존 검수 근거'.repeat(1000),evidence:'json',updatedAt:'old'})):[]};
}
function decode(packet) {
  return packet.items.map(row=>{
    const item=Object.fromEntries(packet.itemColumns.map((key,index)=>[key,row[index]]));
    item.provenance=item.provenance.map(p=>({...p,bbox:Array.isArray(p.bbox)?Object.fromEntries(packet.bboxColumns.map((key,index)=>[key,p.bbox[index]])):p.bbox}));
    item.orig ??= item.text;
    return item;
  });
}
const fake = fileURLToPath(new URL('./fixtures/fake-role-annotation-app-server.mjs',import.meta.url));
test('actual document old input exceeds the Codex character limit; compact complete input works with every item already reviewed', async ()=>{
  const bytes=readFileSync(fixtureJson), document=JSON.parse(bytes), before=JSON.stringify(document);
  for(const reviewed of [false,true]){
    const c=context(document,reviewed), old=JSON.stringify({annotation:c.annotation,retainedPages:c.retainedPages,items:c.items,records:c.records}), packet=annotationRecommendationInput(c);
    assert.ok(inputCharacterCount(old)>codexMaxInputChars);
    assert.ok(inputCharacterCount(JSON.stringify(packet))<codexMaxInputChars-10000,'room for annotation and instructions');
    assert.equal(packet.items.length,c.items.length);
    const decoded=decode(packet);
    for(const [index,item] of c.items.entries()){
      const actual=decoded[index]; for(const key of ['ref','text','orig','label','layer','parentRef']) assert.deepEqual(actual[key],item[key]);
      assert.deepEqual(actual.provenance,item.provenance.map(({page,rect,...raw})=>raw));
    }
    assert.deepEqual(packet.pages,c.pages);
    assert.deepEqual(await runAnnotationSuggestions({context:c,cwd:process.cwd(),model:'test-model',effort:'medium',launch:{executable:process.execPath,args:[fake,'actual-empty']},timeoutMs:5000}),[]);
  }
  assert.equal(JSON.stringify(document),before); assert.deepEqual(readFileSync(fixtureJson),bytes);
});
test('wire encoding preserves different orig, mixed-page/all prov/charspan, unknown bbox/prov extensions and current role fields', ()=>{
  const c=context(roleAnnotationDocument(),true);c.retainedPages=c.retainedPages.filter(p=>p!==1);
  c.items[0].orig='원본과 다른 text 😀';c.items[0].provenance[0].custom={value:'원본 출처'};c.items[0].provenance[0].bbox.extension='unknown bbox field';
  const before=structuredClone(c),packet=annotationRecommendationInput(c),decoded=decode(packet);
  assert.deepEqual(c,before); assert.equal(decoded[0].orig,c.items[0].orig);
  assert.deepEqual(decoded[0].provenance,c.items[0].provenance.map(({page,rect,...raw})=>raw));
  for(const [i,item]of c.items.entries())assert.deepEqual(decoded[i].review,[c.records[i].region,c.records[i].role,c.records[i].parentRef,c.records[i].status,true]);
  assert.ok(!JSON.stringify(packet).includes('기존 검수 근거'));
});
test('Unicode scalar count is exact at the limit; oversize input fails before spawning or writing review state',async t=>{
  assert.equal(inputCharacterCount('😀한A'),3);
  const h=await harness(t),before=await h.state();
  const huge='😀'.repeat(codexMaxInputChars+1);
  await assert.rejects(runCodexSuggestions({taskPrompt:huge,maxInputBytes:8*1024*1024,launch:{executable:'must-not-spawn',args:[]}}),/1,048,577자.*1,048,576자/);
  // A UTF-16 length above the limit is still exactly the allowed scalar count.
  await assert.rejects(runCodexSuggestions({taskPrompt:'😀'.repeat(codexMaxInputChars),maxInputBytes:8*1024*1024,launch:{executable:'must-not-spawn',args:[]}}),/실행 파일/);
  assert.deepEqual(await h.state(),before);
});
test('RPC diagnostics identify method and safe size metadata without echoing server message/data',async()=>{
  const launch=mode=>({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/fake-app-server.mjs',import.meta.url)),mode]});
  for(const mode of ['rpc-size-error','rpc-invalid']){
    await assert.rejects(runCodexSuggestions({pages:[{page:1,items:[]}],cwd:process.cwd(),launch:launch(mode),timeoutMs:5000}),error=>{
      assert.match(error.message,/turn\/start.*-32602/);assert.ok(!error.message.includes('PRIVATE'));assert.ok(!error.message.includes('secret'));
      if(mode==='rpc-size-error')assert.match(error.message,/2,221,003자.*1,048,576자/);
      return true;
    });
  }
});
