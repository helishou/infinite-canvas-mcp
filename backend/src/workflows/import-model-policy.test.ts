import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerWorkflowRoutes } from './routes.js';
import { WorkflowModelCatalog } from './model-catalog.js';

test('upload/package import never registers models by default; explicit creation is retained',async()=>{
 const app=express(); app.use(express.json());
 const models:string[]=[];
 const store:any={upload:async(name:string)=>({name}),importPackage:async(name:string)=>({name})};
 registerWorkflowRoutes(app,store,{} as any,undefined,async name=>{models.push(name);});
 const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try {
  for(const [url,body] of [['/api/workflows',{name:'upload.json',workflow:{}}],['/api/workflows/import',{name:'package.json',package:{}}]] as const){
   const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   assert.equal(response.status,201);
  }
  assert.deepEqual(models,[]);
  const response=await fetch(base+'/api/workflows/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'manual.json',package:{},exposeModel:true})});
  assert.equal(response.status,201); assert.deepEqual(models,['manual.json']);
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('settings sync does not rediscover unregistered workflows as models',async()=>{
 const values=new Map<string,unknown>([['ai.config',{channels:[]}]]);
 const detail:any={name:'fresh.json',workflow:{},config:{title:'fresh',operation:'image',fields:[]}};
 const catalog=new WorkflowModelCatalog({list:async()=>[{name:detail.name}],get:async()=>detail} as any,{get:key=>values.get(key),set:(key,value)=>{values.set(key,value);}});
 assert.deepEqual((await catalog.syncStoredConfig()).added,[]);
 assert.equal((values.get('ai.config') as any).channels.flatMap((channel:any)=>channel.models).length,0);
 assert.equal((await catalog.exposeImportedWorkflow(detail.name)).changed,true);
 assert.equal((values.get('ai.config') as any).channels.flatMap((channel:any)=>channel.models).length,1);
});
