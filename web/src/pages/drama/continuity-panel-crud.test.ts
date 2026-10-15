import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { appendContinuityHold, appendContinuityExemption, normalizedContinuityValues } from './continuity-ledger-evidence';
import { analyzeContinuityDeletion, applyContinuityDeletion, continuityLedgerEntryId, continuityLedgerFactDescriptions, restoreContinuityDeletion } from './continuity-ledger-mutations';
const sourceText = readFileSync(new URL('./continuity-panel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('panel.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name: string, context: Record<string, any>): (...args: any[]) => any {
 let expression = '';
 function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer)) expression = node.initializer.getText(ast); ts.forEachChild(node, visit); }
 visit(ast); assert.ok(expression);
 const js = ts.transpileModule(`const extracted = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
 return new Function('context', `with(context) { ${js}; return extracted; }`)(context);
}
const shots = [{id:'S',timeline_id:'T',story_order:1,duration_frames:72,start_frame:0,end_frame:72}];
const fixture = () => ({contract_version:2,facts:[{id:'F',allowed_values:['a','b']}],timelines:[{id:'T'}],initial:[{timeline_id:'T',fact_id:'F',value:'a'}],events:[] as any[],requirements:[] as any[],coverage:[] as any[]});
function harness() {
 let sequence=0; const writes:any[]=[], notices:any[]=[];
 const c:any={shots, timelineId:'T',shotId:'S',factId:'F',sourceBlockId:'B',exemptionReason:'Documented review reason',reviewRef:'review',subjectAssembly:true,
 source:{shots,script_scenes:[{id:'scene',blocks:[{id:'B'}]}]},blocksForShot:[{id:'B',sceneId:'scene',sourceBlock:{id:'B'}}],
 activeEditContext:{current:{key:'source',alive:true,editable:true,busy:false}},latestLedger:{current:fixture()},
 appendContinuityHold,appendContinuityExemption,analyzeContinuityDeletion,applyContinuityDeletion,continuityLedgerEntryId,continuityLedgerFactDescriptions,restoreContinuityDeletion,
 id:()=>`new${++sequence}`,sourceDigest:async()=> 'digest',setLedger:(value:any)=>{writes.push(value);c.latestLedger.current=value;},setLastDeletion:(value:any)=>{c.lastDeletion=value;},
 message:{warning:(s:any)=>notices.push(s),error:(s:any)=>notices.push(s)},t:(s:string)=>s,records:(value:any)=>Array.isArray(value)?value:[],stable:JSON.stringify,
 React:{createElement: (...args:any[])=>args},Button:'button', display:{fact:(s:string)=>s,timeline:(s:string)=>s,target:(s:string)=>s,source:(s:string)=>s},
 modal:{confirm:(options:any)=>{c.dialog=options;return {destroy(){}};},info:(options:any)=>{c.blocked=options;return {destroy(){}};}},
 ledger:fixture(),editable:true,legacy:false,changeDraft:undefined,snapshotLoading:false,busy:false,sourceConflict:false,invalidLedgerDraft:false,invalidEventPositions:[],onSave:async()=>true};
 return {c,writes,notices};
}
for (const name of ['addHold','addExemption']) {
 test(`${name}: digest resolves before the single atomic ledger update`,async()=>{
  const {c,writes}=harness();let resolve!:(s:string)=>void;c.sourceDigest=()=>new Promise<string>(r=>resolve=r);
  const pending=handler(name,c)();assert.equal(writes.length,0);resolve('digest');await pending;assert.equal(writes.length,1);
  assert.equal(writes[0].coverage.length,1);assert.equal(writes[0].requirements.length,name==='addHold'?1:0);
 });
 test(`${name}: failed digest or changed source/permission/lifecycle makes no partial write`,async()=>{
  for(const patch of [{key:'new-source'},{editable:false},{alive:false},{busy:true}]){
   const {c,writes,notices}=harness();let resolve!:(s:string)=>void;c.sourceDigest=()=>new Promise<string>(r=>resolve=r);
   const pending=handler(name,c)();Object.assign(c.activeEditContext.current,patch);resolve('digest');await pending;assert.equal(writes.length,0);assert.equal(notices.length,1);
  }
  const {c,writes}=harness();c.sourceDigest=async()=>{throw Error('digest failed');};await handler(name,c)();assert.equal(writes.length,0);
 });
}
test('hold appends linked records without mutating the old ledger, and stale coverage remains untouched',()=>{
 const ledger=fixture(), original=structuredClone(ledger);let n=0;const input={timelineId:'T',shotId:'S',factId:'F',blockId:'B',digest:'d'};
 const next=appendContinuityHold(ledger,shots,input,()=>String(++n),true);assert.deepEqual(ledger,original);assert.equal(next.requirements[0].value,'a');
 assert.throws(()=>appendContinuityHold(next,shots,{...input,digest:'changed'},()=>String(++n),true),/EVENT_COVERAGE_REVIEW_REQUIRED/);assert.equal(next.coverage[0].source_digest,'d');
});
test('exemptions require eight Unicode codepoints; allowed values trim, dedupe, and exclude the unknown sentinel',()=>{
 const input={timelineId:'T',shotId:'S',blockId:'B',digest:'d',reviewRef:'review',reason:'😀'.repeat(7)};
 assert.throws(()=>appendContinuityExemption(fixture(),shots,input,()=> 'id'),/EVENT_FIELDS_REQUIRED/);
 assert.equal(appendContinuityExemption(fixture(),shots,{...input,reason:'😀'.repeat(8)},()=> 'id').coverage.length,1);
 assert.deepEqual(normalizedContinuityValues(' a, b，a\nunknown,  ,b'),['a','b']);
});
function eventHarness(){const h=harness();h.c.latestLedger.current.events=[{id:'E',timeline_id:'T',shot_id:'S',fact_id:'F',local_frame:36,before:'a',after:'b',source_anchor:{block_id:'B'}}];return h;}
test('actual delete confirmation rechecks changed references, owner and permissions before mutating',()=>{
 for(const mutate of [(c:any)=>c.latestLedger.current.requirements.push({id:'shared',event_ids:['E','other']}),(c:any)=>c.activeEditContext.current.key='changed',(c:any)=>c.activeEditContext.current.editable=false]){
  const {c,writes,notices}=eventHarness();handler('removeEntry',c)('events',c.latestLedger.current.events[0]);assert.ok(c.dialog);mutate(c);c.dialog.onOk();assert.equal(writes.length,0);assert.equal(notices.length,1);
 }
});
test('actual delete and undo preserve unrelated edits and remove only the confirmed stable IDs',()=>{
 const {c,writes}=eventHarness();handler('removeEntry',c)('events',c.latestLedger.current.events[0]);c.dialog.onOk();assert.equal(writes.length,1);assert.equal(c.latestLedger.current.events.length,0);assert.ok(c.lastDeletion);
 c.latestLedger.current.facts[0].display_name='Unrelated edit';handler('undoDeletion',c)();assert.equal(c.latestLedger.current.events[0].id,'E');assert.equal(c.latestLedger.current.facts[0].display_name,'Unrelated edit');assert.equal(c.lastDeletion,undefined);
});
test('save rejects readonly, legacy, snapshot-loading and invalid drafts without a request; only receipt success clears undo',async()=>{
 for(const patch of [{editable:false},{legacy:true},{changeDraft:{}},{snapshotLoading:true},{busy:true},{sourceConflict:true},{invalidLedgerDraft:true},{invalidEventPositions:[{}]}]){
  const {c}=harness();let calls=0;Object.assign(c,patch);c.onSave=async()=>{calls++;return true;};await handler('saveLedger',c)();assert.equal(calls,0);
 }
 const {c}=harness();c.lastDeletion={rows:[]};c.onSave=async()=>false;await handler('saveLedger',c)();assert.ok(c.lastDeletion);c.onSave=async()=>true;await handler('saveLedger',c)();assert.equal(c.lastDeletion,undefined);
});

test('saving completes a missing state description so the ledger can satisfy the save contract', async () => {
 const {c,writes}=harness();
 await handler('saveLedger',c)();
 assert.equal(writes.length,1,'the repaired ledger is written before saving');
 assert.deepEqual(writes[0].facts[0].value_descriptions,{a:'a',b:'b'});
});
