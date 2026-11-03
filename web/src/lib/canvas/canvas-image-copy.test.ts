import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCanvasImageContent } from './canvas-image-copy';
import { CanvasNodeType } from '@/types/canvas';
const image:any={id:'image',type:CanvasNodeType.Image,metadata:{content:'stale-top-level.png',storageKey:'image:stale',primaryImageId:'second',images:[{id:'first',content:'first.png',storageKey:'image:first'},{id:'second',content:'second.webp',storageKey:'image:second',mimeType:'image/webp'}]}};
test('copies the displayed selected image as binary PNG, no URL/text/node payload',async()=>{
 const reads:any[]=[]; const writes:Blob[]=[]; const original=new Blob(['webp'],{type:'image/webp'}); const png=new Blob(['png'],{type:'image/png'});
 await copyCanvasImageContent(image,{read:async selected=>{reads.push(selected);return original;},png:async blob=>{assert.equal(blob,original);return png;},write:async promise=>{writes.push(await promise);}});
 assert.equal(reads[0].storageKey,'image:second'); assert.deepEqual(writes,[png]);
});
test('ordinary imported storage-only image and smart image use the same visible-image selection',async()=>{
 for(const node of [{id:'plain',type:CanvasNodeType.Image,metadata:{storageKey:'image:import'}},{...image,type:CanvasNodeType.Config,metadata:{...image.metadata,smart:true,generationMode:'image'}}]){
  let key=''; await copyCanvasImageContent(node as any,{read:async selected=>{key=selected.storageKey!;return new Blob(['x'],{type:'image/png'});},png:async b=>b,write:async p=>{await p;}});
  assert.equal(key,node.id==='plain'?'image:import':'image:second');
 }
});
test('right-click targets B and C exactly without changing primary A or selection',async()=>{
 const node:any={...image,metadata:{primaryImageId:'A',selectedImageId:'B',images:['A','B','C'].map(id=>({id,content:id+'.png',storageKey:'image:'+id}))}};
 const before=JSON.stringify(node);
 for(const target of ['B','C',undefined]){
  let key='';
  await (copyCanvasImageContent as any)(node,{read:async(selected:any)=>{key=selected.storageKey;return new Blob(['png'],{type:'image/png'});},png:async(b:Blob)=>b,write:async(p:Promise<Blob>)=>{await p;}},target);
  assert.equal(key,'image:'+(target||'A'));
  assert.equal(JSON.stringify(node),before);
 }
 await assert.rejects((copyCanvasImageContent as any)(node,undefined,'deleted'),/没有可复制|不存在/);
});
test('clipboard permission/read/decode failures are surfaced; no text fallback',async()=>{
 await assert.rejects(copyCanvasImageContent(image,{read:async()=>{throw new Error('media denied');},png:async b=>b,write:async p=>{await p;}}),/media denied/);
 await assert.rejects(copyCanvasImageContent(image,{read:async()=>new Blob(),png:async()=>{throw new Error('decode failed');},write:async p=>{await p;}}),/decode failed/);
 await assert.rejects(copyCanvasImageContent(image,{read:async()=>new Blob(),png:async b=>b,write:async()=>{throw new Error('clipboard denied');}}),/clipboard denied/);
 await assert.rejects(copyCanvasImageContent({type:CanvasNodeType.Image,metadata:{prompt:'not an image'}} as any),/没有可复制/);
});
