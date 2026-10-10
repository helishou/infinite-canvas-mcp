import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { directorHash } from "./director.js";
import { directorProductionSchema } from "@basketikun/canvas-agent/drama/production-contract";
function fixture(t: test.TestContext, existing?: Record<string, any>) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"smart-prepare-")), db=new BackendDatabase(path.join(dir,"db.sqlite"));
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.upsertCanvasFolder({id:"drama",name:"剧目",isDrama:true,createdAt:new Date().toISOString()});
 db.createCanvasProject({id:"canvas",title:"场次",nodes:existing?[existing]:[],connections:[]});
 db.upsertDramaEpisode({id:"ep",dramaId:"drama",episodeNumber:1,title:"机甲",synopsis:"",canvasId:"canvas"});
 const source={prompt_assembly:{version:2},fps_num:24,fps_den:1,subject_registry:[],character_registry:[],scene_registry:[],shots:[],segments:[],utterances:[],asset_plan:[{id:"A",kind:"vehicle",asset_name:"铆钉",canvas_scope:"episode"}],asset_cards:[],ledger:{contract_version:2,facts:[],timelines:[],initial:[],events:[],requirements:[],coverage:[]}};
 const director=directorProductionSchema.parse({schemaVersion:1,engine:{commit:"a".repeat(40),patchVersion:"test",runtimeId:"test",version:"test"},source,sourceHash:directorHash(source),assets:{A:{version:"v1",status:"planned",...(existing?{nodeId:existing.id}:{})}},shotInputs:{},modules:{},artifacts:[],boundaries:[],unresolved:[],workflow:{},executionAuthorized:false});
 const service=new EpisodeProductionService(db,new BackendEventBus(),dir,false,()=>{});
 const saved=service.edit("ep",{operationId:"init",expectedRevision:0,ops:[{type:"set_director_production",director}]});
 const runner=new EpisodeProductionRunner(service,createStores(db),{} as any);
 return {db,service,runner,revision:saved.revision};
}
test("v2 prepares smart image producers and repeated preparation creates no duplicate node",t=>{
 const f=fixture(t); const result=f.runner.prepareTargets("ep",f.revision,["asset:A"],"prepare");
 const node=(f.db.getCanvasProject("canvas")!.nodes as any[]).find(n=>n.metadata?.productionAssetId==="A");
 assert.equal(node.type,"config");assert.equal(node.metadata.smart,true);assert.equal(node.metadata.generationMode,"image");
 const count=(f.db.getCanvasProject("canvas")!.nodes as any[]).length;
 const replay=f.runner.prepareTargets("ep",f.revision,["asset:A"],"prepare");
 assert.equal(replay.replayed,true);assert.equal(replay.revision,result.revision);assert.equal((f.db.getCanvasProject("canvas")!.nodes as any[]).length,count);
});
test("only empty v2 production placeholders are repaired in place, keeping position and metadata",t=>{
 const f=fixture(t,{id:"pending",type:"image",position:{x:123,y:456},width:320,height:240,metadata:{productionAssetId:"A",prompt:"机械设定",custom:"保留"}});
 f.runner.prepareTargets("ep",f.revision,["asset:A"],"repair");
 const node=(f.db.getCanvasProject("canvas")!.nodes as any[]).find(n=>n.id==="pending");
 assert.equal(node.type,"config");assert.equal(node.metadata.composerContent,"机械设定");assert.equal(node.metadata.custom,"保留");assert.deepEqual(node.position,{x:123,y:456});
});
test("an existing media node cannot be silently converted into a smart producer",t=>{
 const f=fixture(t,{id:"media",type:"image",position:{x:1,y:2},metadata:{productionAssetId:"A",storageKey:"user-image"}});
 assert.throws(()=>f.runner.prepareTargets("ep",f.revision,["asset:A"],"invalid"),/SUBJECT_IMAGE_NODE_UPGRADE_REQUIRED/);
 const node=(f.db.getCanvasProject("canvas")!.nodes as any[]).find(n=>n.id==="media");assert.equal(node.type,"image");assert.equal(node.metadata.storageKey,"user-image");
});
