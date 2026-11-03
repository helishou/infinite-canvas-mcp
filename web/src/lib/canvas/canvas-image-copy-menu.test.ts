import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('ordinary images with no prompt expose independent Copy content beside node Duplicate',()=>{
 const source=readFileSync(new URL('../../pages/canvas/project.tsx',import.meta.url),'utf8');
 const gate=source.match(/canCopyContent=\{(Boolean\([^\n]+\))\}/)?.[1];
 assert.ok(gate);
 assert.equal(new Function('contextMenuImage','contextMenuText',`return ${gate}`)({storageKey:'image:import'},''),true);
 assert.match(source,/onDuplicate=\{\(\) => \{[\s\S]*?duplicateNode\(contextMenu.nodeId\)/);
});

test('contextmenu hit keeps exact secondary image identity without selecting or promoting it',()=>{
 const source=readFileSync(new URL('../../pages/canvas/project.tsx',import.meta.url),'utf8');
 const callback=source.match(/const handleNodeContextMenu = useCallback\(([\s\S]*?), \[\]\);/)?.[1];
 assert.ok(callback);
 const code=ts.transpileModule('const callback='+callback,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 class HitElement { constructor(public imageId:string){} closest(){return {dataset:{canvasImageId:this.imageId}};} }
 const menus:any[]=[];
 const handler=new Function('Element','setContextMenu',code+'; return callback;')(HitElement,(menu:any)=>menus.push(menu));
 for(const id of ['B','C'])handler({target:new HitElement(id),clientX:10,clientY:20,preventDefault(){},stopPropagation(){}},'node');
 assert.deepEqual(menus.map(menu=>[menu.nodeId,menu.imageId]),[['node','B'],['node','C']]);
 const cards=readFileSync(new URL('../../components/canvas/canvas-node.tsx',import.meta.url),'utf8');
 assert.match(cards,/data-canvas-image-id=\{image.id\}/);
 assert.match(cards,/data-canvas-image-id=\{primaryImage\?\.id\}/);
});

test('image context-menu Copy content calls binary image copy, not text prompt',()=>{
 const source=readFileSync(new URL('../../pages/canvas/project.tsx',import.meta.url),'utf8');
 const body=source.match(/onCopyContent=\{\(\) => \{([\s\S]*?)\n                        \}\}/)?.[1];
 assert.ok(body);
 const calls:string[]=[];
 new Function('contextMenuImage','contextMenuNode','contextMenuText','copyCanvasImageContent','copyText','setContextMenu','message','t','contextMenu',body)(
  {storageKey:'image:B'}, {id:'node'}, 'not the requested prompt', (_node:unknown,_io:unknown,id:string)=>{calls.push('image:'+id);return Promise.resolve();},()=>calls.push('text'),()=>{}, {error:()=>{}}, (s:string)=>s,{type:'node',imageId:'B'});
 assert.deepEqual(calls,['image:B']);
});
