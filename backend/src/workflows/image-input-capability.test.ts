import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowImageInputs } from './image-input-capability.js';
import { injectParams, removeEmptyMediaNodes, validatePromptGraph } from './executor.js';
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

test('Goohai Qwen optional references preserve text, single and multi-image execution', () => {
 const wf: any = {
  primary: { class_type: 'LoadImageGoohai', inputs: { image: 'old.png' } },
  ...Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`ref${index}`, graph.a])),
  optimizer: { class_type: 'QwenImagePromptOptimizer', inputs: { 用户提示词: 'test', 图像_01: ['primary', 0] } },
  ratio: { class_type: 'GoohaiRatioAndResolution', inputs: { 图像: ['primary', 0] } },
  enc: { class_type: 'TextEncodeQwenImage21GH', inputs: { prompt: ['optimizer', 0], image_01: ['primary', 0], latent_width: ['ratio', 1] } },
  out: { class_type: 'SaveImage', inputs: { images: ['enc', 0] } },
 };
 for (let index = 0; index < 5; index++) {
  const slot = String(index + 2).padStart(2, '0');
  wf.optimizer.inputs[`图像_${slot}`] = [`ref${index}`, 0];
  wf.enc.inputs[`image_${slot}`] = [`ref${index}`, 0];
 }
 // Preserve the actual imported field order, where the main image is fourth.
 const ids = ['ref4', 'ref3', 'ref2', 'primary', 'ref1', 'ref0'];
 const fields = ids.map(id => field(id, id));
 assert.deepEqual(workflowImageInputs(wf, fields, ['out']).counts, [0, 1, 2, 3, 4, 5, 6]);
 for (const count of [0, 1, 3, 6]) {
  const values = Object.fromEntries(ids.map((id, index) => [id, index < count ? 'reference.png' : null]));
  const params = Object.fromEntries(ids.map(id => [id, { image: values[id] }]));
  const prepared: any = removeEmptyMediaNodes(injectParams(wf, params), fields, values);
  validatePromptGraph(prepared);
  assert.equal(prepared.primary.inputs.image, count > 3 ? 'reference.png' : '无');
  assert.ok(prepared.optimizer);
  assert.ok(prepared.enc);
  assert.ok(prepared.out.inputs.images);
 }
 assert.equal(wf.primary.inputs.image, 'old.png');
 assert.deepEqual(workflowImageInputs(wf, fields.map(f => ({ ...f, required: f.node === 'primary' })), ['out']).counts, [4, 5, 6]);
 assert.throws(() => removeEmptyMediaNodes({ primary: { class_type: 'LoadImageGoohai', inputs: {} } }, [field('primary', 'primary', true)], {}), /缺少必选媒体/);
});
