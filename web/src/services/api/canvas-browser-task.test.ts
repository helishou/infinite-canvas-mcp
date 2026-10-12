import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(name:string,scope:Record<string,unknown>) {
 const source=readFileSync(new URL('./canvas-browser-task.ts',import.meta.url),'utf8');
 const tree=ts.createSourceFile('file.ts',source,ts.ScriptTarget.Latest,true);
 const node=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)!;
 const code=ts.transpileModule(`return (${node.getText(tree)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(scope),code)(...Object.values(scope));
}
test('text browser scripts checkpoint before execution and return original text through Backend',async()=>{
 const order:string[]=[];const owner={key:'owner',assertCurrent:()=>{}};
 const execute=load('execute',{recordOf:(v:any)=>v||{},taskConfig:()=>({}),useConfigStore:{getState:()=>({config:{}})},referenceImages:()=>[],videoProviderFingerprint:async()=> 'fingerprint',readBrowserResult:async()=>null,saveBrowserResult:async()=>{order.push('cache');},requestImageQuestion:async()=>{order.push('script');return '浏览器脚本结果';}});
 const output=await execute({id:'text-one',input:{mode:'text',model:'m'}},new AbortController().signal,owner,undefined,async(value:any)=>order.push(value.phase));
 assert.deepEqual(output,{texts:['浏览器脚本结果']});assert.deepEqual(order,['submitting','script','cache','archived']);
});
test('complete failure only releases original claimed task, never reports provider terminal failure',async()=>{
 const calls:string[]=[];const task={id:'one',kind:'canvas-browser-script',status:'queued',input:{mode:'video'}};
 const run=load('run',{browserRecoveryOwner:async()=>({key:'owner',assertCurrent:()=>{}}),fetchBackendTask:async()=>({task}),claimBackendBrowserTask:async()=>({task,claimToken:'nonce'}),recordOf:(v:any)=>v||{},workerId:'worker',resumeOnly:new Set(),execute:async(_:unknown,_signal:unknown,_owner:unknown,_recovery:unknown,checkpoint:any)=>{await checkpoint({phase:'archived'});return {media:[{storageKey:'saved'}]};},checkpointBackendBrowserTask:async()=>{calls.push('checkpoint');},completeBackendBrowserTask:async()=>{calls.push('complete');throw new Error('response lost');},releaseBackendBrowserTask:async(...args:any[])=>{calls.push('release');assert.equal(args[2],'nonce');},failBackendBrowserTask:async()=>calls.push('fail'),paused:new Set(),BrowserPreflightFailure:class extends Error{},BrowserProviderTerminalFailure:class extends Error{},knownNonBrowserTasks:new Set()});
 await run('one',new AbortController());assert.deepEqual(calls,['checkpoint','complete','release']);
});
