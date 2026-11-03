import test from 'node:test';
import assert from 'node:assert/strict';
import { imageModelCompatibility } from './image-model-compatibility';
const config={channels:[{id:'local',kind:'comfyui',models:[{name:'mapped',capability:'image',workflows:['graph.json']},{name:'blocked',capability:'image',workflowRouting:{single:'__unsupported__'},workflows:['graph.json']}]},{id:'api',kind:'openai',models:[{name:'unlisted-api-model',capability:'image'}]}]};
test('filter by input reference count, independent of output count or model names',()=>{
 assert.equal(imageModelCompatibility(config,'local::mapped',0,[1,2]),'unsupported');
 assert.equal(imageModelCompatibility(config,'local::mapped',1,[1,2]),'supported');
 assert.equal(imageModelCompatibility(config,'local::mapped',2,[1,2]),'supported');
 assert.equal(imageModelCompatibility(config,'local::mapped',3,[1,2]),'unsupported');
 assert.equal(imageModelCompatibility(config,'local::mapped',1,[0]),'unsupported');
 assert.equal(imageModelCompatibility(config,'local::mapped',0,[0]),'supported');
});
test('explicit unsupported route overrides graph capacity',()=>assert.equal(imageModelCompatibility(config,'local::blocked',1,[0,1,2]),'unsupported'));
test('unknown API capability and unavailable backend metadata are not guessed or globally filtered',()=>{
 assert.equal(imageModelCompatibility(config,'api::unlisted-api-model',20),'unknown');
 assert.equal(imageModelCompatibility(config,'local::mapped',2),'unknown');
 assert.equal(imageModelCompatibility(config,'local::mapped',2,[]),'unsupported');
});
