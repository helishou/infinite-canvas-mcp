import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { observeVideoTask, videoNeedsVerification, VideoTerminalFailure, videoEndpoint } from './task-recovery';
const wait = async () => {};
test('network, authentication and not-found query errors never become terminal generation failure', async () => {
    for (const message of ['offline', 'HTTP 401', 'HTTP 404', 'HTTP 429', 'HTTP 500']) {
        await assert.rejects(observeVideoTask({ poll: async () => { throw new Error(message); }, signal: new AbortController().signal, wait, timeoutMessage: 'timeout' }), error => error instanceof Error && !(error instanceof VideoTerminalFailure) && error.message === message);
    }
});
test('only explicit remote terminal failure is classified terminal', async () => {
    await assert.rejects(observeVideoTask({ poll: async () => ({status:'failed', error:'cancelled remotely'}), signal:new AbortController().signal, wait, timeoutMessage:'timeout' }), VideoTerminalFailure);
});
test('query timeout remains unknown and does not submit another generation', async () => {
    let polls = 0;
    await assert.rejects(observeVideoTask({poll:async()=>{polls++;return {status:'pending'};},signal:new AbortController().signal,wait,timeoutMessage:'timeout'}), error=>error instanceof Error && !(error instanceof VideoTerminalFailure));
    assert.equal(polls,120);
});
test('unmount abort discards a late response', async () => {
    const controller=new AbortController();
    await assert.rejects(observeVideoTask({poll:async()=>{controller.abort();return {status:'completed',result:'old'};},signal:controller.signal,wait,timeoutMessage:'timeout'}), {name:'AbortError'});
});
test('old failed task receipts require verification; confirmed failure and completed result do not',()=>{
    assert.equal(videoNeedsVerification({status:'failed',task:{id:'old'}}),true);
    assert.equal(videoNeedsVerification({status:'failed',task:{id:'old'},terminalConfirmed:true}),false);
    assert.equal(videoNeedsVerification({status:'pending',submissionUnknown:true}),true);
    assert.equal(videoNeedsVerification({status:'success',video:{},task:{id:'old'}}),false);
    assert.equal(videoEndpoint('https://user:secret@example.com/v1?key=hidden'),'https://example.com/v1');
});
function load(name:string, path:string, scope:Record<string,unknown>) {
    const source=readFileSync(new URL(path,import.meta.url),'utf8');
    const tree=ts.createSourceFile('file.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    let expression:ts.Node|undefined;
    function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)===name)expression=node.initializer; if(ts.isFunctionDeclaration(node)&&node.name?.text===name)expression=node;ts.forEachChild(node,visit);} visit(tree);assert.ok(expression);
    const code=ts.transpileModule(`return (${expression.getText(tree).replace(/^export\s+/, '')});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    return new Function(...Object.keys(scope),code)(...Object.values(scope));
}
test('original video API preserves failed/cancelled versus HTTP errors and original task ID',async()=>{
    const paths:string[]=[];let response:any={id:'same',status:'in_progress'};
    const poll=load('pollOpenAIVideoTask','../../services/api/video.ts',{axios:{get:async(path:string)=>{paths.push(path);if(response instanceof Error)throw response;return {data:response};},isCancel:()=>false},unwrapVideoResponse:(v:unknown)=>v,videoResultUrl:()=>'',aiApiUrl:(_:unknown,path:string)=>path,aiHeaders:()=>({}),readApiErrorMessage:(v:unknown)=>v,apiText:(v:string)=>v,readAxiosError:(error:Error)=>error.message});
    assert.deepEqual(await poll({}, {id:'same'}),{status:'pending'});
    response=new Error('HTTP 404');await assert.rejects(poll({}, {id:'same'}),/404/);
    response={id:'same',status:'failed',error:{message:'remote failure'}};
    assert.deepEqual(await poll({}, {id:'same'}),{status:'failed',error:'remote failure'});
    assert.deepEqual(paths,['/videos/same','/videos/same','/videos/same']);
});
test('video submission synchronous lock rejects repeat clicks before any request',async()=>{
    let snapshots=0;
    const generate=load('generate','./index.tsx',{submissionRef:{current:true},activeLogIdsRef:{current:new Set()},buildRequestSnapshot:()=>{snapshots++;}});
    await generate();await generate();assert.equal(snapshots,0);
});
test('image submission synchronous lock rejects repeat clicks',async()=>{
    const generate=load('generate','../image/index.tsx',{submissionRef:{current:true}});
    await generate();await generate();
});
function observerScope(poll:()=>Promise<any>, selected='one') {
    const written:any[]=[];const shown:any[]=[];const receipts:any[]=[];let logs:any[]=[{id:'one'}];
    const scope:any={captureVideoOwner:async()=>({key:'owner',assertCurrent:()=>{}}),activeLogIdsRef:{current:new Set()},controllersRef:{current:new Map()},mountedRef:{current:true},currentLogIdRef:{current:selected},setRunning:()=>{},setStartedAt:()=>{},setResults:(value:any)=>shown.push(value),setLogs:(fn:any)=>{logs=fn(logs);},effectiveConfig:{},buildVideoConfig:(config:any)=>config,resolveModelRequestConfig:()=>({baseUrl:'https://example.com'}),videoEndpoint,observeVideoTask,VideoTerminalFailure,pollVideoGenerationTask:poll,delay:async()=>{},t:(key:string)=>key,storeGeneratedVideo:async()=>({url:'saved',storageKey:'media',bytes:1,mimeType:'video/mp4'}),nanoid:()=> 'result',saveLog:async(log:any)=>written.push(log),clearVideoReceipt:async(id:string)=>receipts.push(['clear',id]),retainVideoReceipt:async(log:any)=>receipts.push(['retain',log.id]),message:{success:()=>{},warning:()=>{}},updateAgentTask:()=>{}};
    return {scope,written,shown,receipts};
}
const pendingLog={id:'one',createdAt:1,config:{},model:'m',status:'pending',task:{id:'remote-one',model:'m',provider:'openai'}};
test('duplicate recovery clicks share one query and old task completion cannot replace another selected task',async()=>{
    let resolve!:(v:any)=>void;let calls=0;
    const state=observerScope(()=>{calls++;return new Promise(r=>{resolve=r;});},'other');
    const poll=load('pollGenerationLog','./index.tsx',state.scope);
    const first=poll(pendingLog); await poll(pendingLog); assert.equal(calls,1);
    resolve({status:'completed',result:{url:'remote'}});await first;
    assert.equal(state.shown.length,0);assert.equal(state.written[0].status,'success');assert.deepEqual(state.receipts,[['clear','one']]);
});
test('query failure retains pending receipt and recovery action never creates a task',async()=>{
    const state=observerScope(async()=>{throw new Error('offline');});
    await load('pollGenerationLog','./index.tsx',state.scope)(pendingLog);
    assert.equal(state.written[0].status,'pending');assert.equal(state.written[0].queryError,'offline');
    assert.equal(state.shown.at(-1)[0].status,'unknown');assert.deepEqual(state.receipts,[['retain','one']]);
});
test('completed media is kept visible if history persistence fails, without fake success or clearing receipt',async()=>{
    const state=observerScope(async()=>({status:'completed',result:{url:'remote'}}));let success=0;
    state.scope.saveLog=async()=>{throw new Error('history offline');};state.scope.message.success=()=>success++;
    await load('pollGenerationLog','./index.tsx',state.scope)(pendingLog);
    assert.equal(state.shown.at(-1)[0].status,'success');assert.equal(success,0);assert.equal(state.receipts.length,0);
});
test('image history writer awaits rejection rather than fire-and-forget success',async()=>{
    const save=load('saveLog','../image/index.tsx',{saveWorkbenchLog:async()=>{throw new Error('history offline');},refreshLogs:()=>{throw new Error('must not refresh');}});
    await assert.rejects(save({id:'one'}),/history offline/);
});
test('receipt serialization excludes credentials, prompts and media and keys are owner scoped',async()=>{
    let entry:any,key='';
    const retain=load('retainVideoReceipt','./task-receipts.ts',{scope:()=> '["backend","video-workbench"]',store:{setItem:async(k:string,v:any)=>{key=k;entry=v;}}});
    await retain({id:'one',createdAt:1,task:{id:'remote',provider:'openai',model:'m',apiKey:'secret'},prompt:'private',config:{apiKey:'secret'},references:['data:media']}, '["backend","video-workbench"]');
    assert.equal(key,'["backend","video-workbench"]:one');assert.equal(JSON.stringify(entry).includes('secret'),false);assert.equal(JSON.stringify(entry).includes('private'),false);
});
test('owner guard prevents log writes when identity changes during history GET',async()=>{
    let token='first',writes=0;
    const save=load('saveWorkbenchLog','../../services/workbench-logs.ts',{PROJECTS:{video:'video-workbench'},fetchBackendGenerationLogs:async()=>{token='second';return {logs:[]};},toBackendInput:()=>({}),legacyId:()=>'',createBackendGenerationLog:async()=>writes++,updateBackendGenerationLog:async()=>writes++});
    await assert.rejects(save('video',{id:'one'},{assertOwner:()=>{if(token!=='first')throw new Error('owner changed');}}),/owner changed/);
    assert.equal(writes,0);
});
test('image delivery 404 never uploads an error body or creates another generation',async()=>{
    let uploads=0,creates=0,downloads=0;
    const run=load('runGenerationSlot','../image/index.tsx',{selectionVersionRef:{current:1},resolveModelChannel:()=>({kind:'openai'}),deliveryResultsRef:{current:new Map([[0,{url:'existing-result'}]])},fetch:async()=>{downloads++;return {ok:false,status:404,blob:()=>{throw new Error('must not read');}};},uploadImage:async()=>uploads++,requestGeneration:async()=>creates++,setResults:()=>{},t:(v:string)=>v});
    for(let i=0;i<2;i++) await assert.rejects(run(0,{config:{model:'m'},references:[],text:'prompt'},1),/404/);
    assert.equal(downloads,2);assert.equal(uploads,0);assert.equal(creates,0);
});
test('stale image completion cannot overwrite current result cards or delivery cache',async()=>{
    let cards=0;const cache=new Map();
    const run=load('runGenerationSlot','../image/index.tsx',{selectionVersionRef:{current:2},resolveModelChannel:()=>({kind:'openai'}),deliveryResultsRef:{current:cache},requestGeneration:async()=>[{dataUrl:'data:result'}],uploadImage:async()=>({url:'stored',width:1,height:1,bytes:1,mimeType:'image/png'}),setResults:()=>cards++,nanoid:()=> 'one',t:(v:string)=>v});
    await run(0,{config:{model:'m'},references:[],text:'prompt'},1);
    assert.equal(cards,0);assert.equal(cache.size,0);
});
test('legacy backend credentials are hashed in receipt scope, and token rotation preserves the frozen original identity',async()=>{
    let token='secret-one';
    const capture=load('captureVideoOwner','./task-receipts.ts',{getBackendUrl:()=> 'https://legacy:password@example.com?token=hidden',getBackendTokenShared:()=>token});
    const first=await capture();token='secret-two';const second=await capture();
    assert.notEqual(first.key,second.key);assert.equal(/secret|password|hidden|legacy/.test(first.key),false);
    assert.throws(first.assertCurrent,/changed/);
});
test('image request response loss is unknown rather than provider failure',async()=>{
 const Unknown=class extends Error{};let latest:any;
 const run=load('runGenerationSlot','../image/index.tsx',{selectionVersionRef:{current:1},resolveModelChannel:()=>({kind:'openai'}),deliveryResultsRef:{current:new Map()},requestGeneration:async()=>{throw new Error('HTTP 503');},setResults:(fn:any)=>{latest=fn([{}]);},updateResultAt:(list:any[],index:number,patch:any)=>list.map((item,i)=>i===index?{...item,...patch}:item),ImageSubmissionUnknown:Unknown,t:(v:string)=>v});
 await assert.rejects(run(0,{config:{model:'m'},references:[],text:'prompt'},1),Unknown);assert.equal(latest[0].status,'unknown');
});
test('new-generation confirmation never submits on open/cancel and closes before long generation finishes',()=>{
 for(const path of ['./index.tsx','../image/index.tsx']) {
  let options:any;let submits=0;
  const confirm=load('confirmNewGeneration',path,{Modal:{confirm:(value:any)=>{options=value;}},t:(key:string)=>key,generate:()=>{submits++;return new Promise(()=>{});}});
  confirm();assert.equal(submits,0);assert.equal(options.onOk(),undefined);assert.equal(submits,1);
 }
});
