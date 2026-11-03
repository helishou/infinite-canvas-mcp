import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowImageInputs } from './image-input-capability.js';
const field = (id: string, node: string, required = false): any => ({ id, node, input: 'image', type: 'image', required });
const graph: any = { a: {class_type:'LoadImage',inputs:{image:'old.png'}}, b:{class_type:'LoadImage',inputs:{image:'old.png'}}, enc:{class_type:'TextEncodeQwenImage21',inputs:{'images.0':['a',0],'images.1':['b',0]}}, out:{class_type:'SaveImage',inputs:{images:['enc',0]}} };
test('optional multi-image mechanism accepts zero through actual mapped capacity', () => {
 assert.deepEqual(workflowImageInputs(graph, [field('a','a'),field('b','b')]).counts,[0,1,2]);
});
test('required mapped inputs exclude zero and enforce positional minimum', () => {
 assert.deepEqual(workflowImageInputs(graph,[field('a','a'),field('b','b',true)]).counts,[2]);
});
test('stale and duplicate mappings cannot inflate capacity',()=>{
 assert.equal(workflowImageInputs(graph,[field('a','a'),field('alias','a'),field('stale','missing')]).fields.length,1);
});
test('disconnected loaders and linked IMAGE sockets cannot consume references',()=>{
 const wf:any={...graph,unused:{class_type:'LoadImage',inputs:{image:'old.png'}}};
 assert.deepEqual(workflowImageInputs(wf,[field('a','a'),field('unused','unused'),{...field('linked','out'),input:'images'}]).fields.map(f=>f.id),['a']);
});
test('capacity follows selected outputs and the executor-resolved switch branch',()=>{
 const wf:any={a:graph.a,b:graph.b,sw:{class_type:'ComfySwitchNode',inputs:{switch:true,on_true:['a',0],on_false:['b',0]}},out:{class_type:'SaveImage',inputs:{images:['sw',0]}},other:{class_type:'SaveImage',inputs:{images:['b',0]}}};
 const fields=[field('a','a'),field('b','b')];
 assert.deepEqual(workflowImageInputs(wf,fields,['out']).fields.map(f=>f.id),['a']);
 assert.deepEqual(workflowImageInputs(wf,fields,['other']).fields.map(f=>f.id),['b']);
 assert.deepEqual(workflowImageInputs(wf,fields,['out']).counts,[1]);
});
test('mandatory downstream image graph excludes zero even if field required flag is absent',()=>{
 const wf:any={a:graph.a,out:{class_type:'SaveImage',inputs:{images:['a',0]}}};
 assert.deepEqual(workflowImageInputs(wf,[field('a','a')]).counts,[1]);
});
