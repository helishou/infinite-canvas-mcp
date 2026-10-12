import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { browserTaskRecoveryAction } from '@/components/canvas/browser-task-recovery-view';
function execute(scope:Record<string,unknown>) {
    const source=readFileSync(new URL('./canvas-browser-task.ts',import.meta.url),'utf8');
    const tree=ts.createSourceFile('file.ts',source,ts.ScriptTarget.Latest,true);
    const node=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='execute')!;
    const code=ts.transpileModule(`return (${node.getText(tree)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    return new Function(...Object.keys(scope),code)(...Object.values(scope));
}
const task:any={id:'original',input:{mode:'video',model:'m'},result:{}};
const owner={key:'owner',assertCurrent:()=>{}};
const signal=new AbortController().signal;
function setup(cached:any=null){
 const calls:string[]=[];
 const scope:any={videoProviderFingerprint:async()=> 'fingerprint',recordOf:(v:any)=>v||{},taskConfig:()=>({}),useConfigStore:{getState:()=>({config:{}})},referenceImages:()=>[],readBrowserResult:async()=>cached,saveBrowserResult:async(_:string,_id:string,value:any)=>{cached=value;calls.push('cache');},createVideoGenerationTask:async()=>{calls.push('create');return {id:'external',provider:'openai',model:'m'};},pollVideoGenerationTask:async()=>{calls.push('poll');return {status:'completed',result:{blob:new Blob(['video'])}};},storeGeneratedVideo:async()=>{calls.push('archive');return {storageKey:'saved'};},mediaHandle:(media:any)=>({storageKey:media.storageKey}),BrowserSubmissionUnknown:class extends Error{},BrowserProviderTerminalFailure:class extends Error{},uploadMediaFile:async()=>{calls.push('upload');return {storageKey:'image'};},requestGeneration:async()=>{calls.push('create-image');return [{dataUrl:'data:image/png;base64,AA=='}];}};
 return {scope,calls};
}
test('submitting checkpoint must persist before any external request',async()=>{
 const state=setup();await assert.rejects(execute(state.scope)(task,signal,owner,undefined,async()=>{throw new Error('checkpoint offline');}),/checkpoint offline/);
 assert.equal(state.calls.includes('create'),false);
});
test('unconfirmed submission without receipt never generates again',async()=>{
 const state=setup();await assert.rejects(execute(state.scope)(task,signal,owner,{version:1,phase:'submitting',cacheOwner:'owner'},async()=>{}));assert.deepEqual(state.calls,[]);
});
test('external task recovery polls original task and does not submit',async()=>{
 const state=setup();const ids:string[]=[];state.scope.pollVideoGenerationTask=async(_:unknown,task:any)=>{ids.push(task.id);return {status:'completed',result:{url:'existing'}};};
 const output=await execute(state.scope)(task,signal,owner,{version:1,phase:'external_task',cacheOwner:'owner',externalTask:{id:'original-provider',model:'m',provider:'openai'}},async()=>{});
 assert.deepEqual(ids,['original-provider']);assert.equal(state.calls.includes('create'),false);assert.deepEqual(output,{media:[{storageKey:'saved'}]});
});
test('local external receipt survives lost backend checkpoint and resumes original provider ID',async()=>{
 const state=setup({externalTask:{id:'original-provider',model:'m',provider:'openai'}});await execute(state.scope)(task,signal,owner,{version:1,phase:'submitting',cacheOwner:'owner'},async()=>{});assert.equal(state.calls.includes('create'),false);assert.ok(state.calls.includes('poll'));
});
test('image upload failure retains original result and a later recovery only uploads',async()=>{
 const state=setup({images:[{dataUrl:'data:image/png;base64,AA=='}]});state.scope.uploadMediaFile=async()=>{throw new Error('archive offline');};
 await assert.rejects(execute(state.scope)({...task,input:{mode:'image'}},signal,owner,{version:1,phase:'result_available',cacheOwner:'owner'},async()=>{}),/archive offline/);
 state.scope.uploadMediaFile=async()=>({storageKey:'saved-image'});
 const output=await execute(state.scope)({...task,input:{mode:'image'}},signal,owner,{version:1,phase:'result_available',cacheOwner:'owner'},async()=>{});
 assert.deepEqual(output,{media:[{storageKey:'saved-image'}]});assert.equal(state.calls.includes('create-image'),false);
});
test('archived completion recovery returns original handles without polling or generating',async()=>{
 const state=setup();const output={media:[{storageKey:'existing'}]};assert.deepEqual(await execute(state.scope)(task,signal,owner,{version:1,phase:'archived',cacheOwner:'owner',output},async()=>{}),output);assert.deepEqual(state.calls,[]);
});
test('task UI distinguishes healthy running, unknown, recoverable result and confirmed failure',()=>{
 const base={kind:'canvas-browser-script',status:'running',result:{browserRecovery:{phase:'external_task'}}};
 assert.equal(browserTaskRecoveryAction(base),null);
 assert.equal(browserTaskRecoveryAction({...base,error:'offline'}),'query');
 assert.equal(browserTaskRecoveryAction({...base,error:'offline',result:{browserRecovery:{phase:'submitting'}}}),'check');
 assert.equal(browserTaskRecoveryAction({...base,error:'offline',result:{browserRecovery:{phase:'archived'}}}),'archive');
 assert.equal(browserTaskRecoveryAction({...base,status:'failed',result:{}}),'blocked');
 assert.equal(browserTaskRecoveryAction({...base,status:'failed',result:{browserRecovery:{terminalConfirmed:true}}}),null);
});
test('restoring original external task is blocked after provider identity changes',async()=>{
 const state=setup();await assert.rejects(execute(state.scope)(task,signal,owner,{version:1,phase:'external_task',cacheOwner:'owner',providerFingerprint:'other-account',externalTask:{id:'old',provider:'openai',model:'m'}},async()=>{}));assert.deepEqual(state.calls,[]);
});
test('queued cancellation with proof of no submission may retry; legacy cancellation stays blocked',()=>{
 assert.equal(browserTaskRecoveryAction({kind:'canvas-browser-script',status:'cancelled',result:{browserRecovery:{notSubmitted:true}}}),null);
 assert.equal(browserTaskRecoveryAction({kind:'canvas-browser-script',status:'cancelled'}),'blocked');
});
test('a locally paused task retains a check-only escape even before its checkpoint snapshot arrives',()=>{
 assert.equal(browserTaskRecoveryAction({kind:'canvas-browser-script',status:'running',locallyPaused:true}),'check');
 assert.equal(browserTaskRecoveryAction({kind:'canvas-browser-script',status:'queued',locallyPaused:true}),'check');
});
test('audio recovery archives the original Blob without repeating speech generation',async()=>{
 const blob=new Blob(['audio'],{type:'audio/mpeg'});const state=setup({audio:blob});let received:unknown;
 state.scope.storeGeneratedAudio=async(value:unknown)=>{received=value;return {storageKey:'audio-saved'};};
 const output=await execute(state.scope)({...task,input:{mode:'audio'}},signal,owner,{version:1,phase:'result_available',cacheOwner:'owner'},async()=>{});
 assert.equal(received,blob);assert.deepEqual(output,{media:[{storageKey:'audio-saved'}]});
});
