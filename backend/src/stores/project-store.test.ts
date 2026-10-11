import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BackendDatabase } from '../db.js';
import { createProjectStore } from './project-store.js';
import { h3StoryboardIssues } from '@basketikun/canvas-agent/plugins/minimax-h3/runtime-params';

test('an opening-only anchor permits a multi-shot Clip; a complete storyboard remains required and checked', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-anchor-'));
    const db = new BackendDatabase(path.join(directory, 'db.sqlite'));
    t.after(() => { db.close(); fs.rmSync(directory, {recursive:true, force:true}); });
    db.createCanvasProject({id:'canvas', title:'Test', nodes:[], connections:[]});
    const snapshot = {
        clipGroups:[{id:'clip', nodeId:'h3', segmentId:'segment', shotIds:['s1','s2','s3']}],
        shots:['s1','s2','s3'].map(id => ({id,duration:2})),
        director:{shotInputs:{s1:{keyframeAssetId:'opening',keyframePolicy:'reuse'},s2:{keyframePolicy:'none'},s3:{keyframePolicy:'none'}}},
    };
    db.db.prepare('INSERT INTO canvas_productions(project_id,revision,draft_json,published_json,published_version,updated_at) VALUES(?,?,?,?,?,?)')
        .run('canvas',1,JSON.stringify(snapshot),JSON.stringify(snapshot),1,new Date().toISOString());
    const store = createProjectStore(db);
    const requirements = () => store.getH3ProductionRequirements!('canvas')!.clips[0];
    let requirement = requirements();
    assert.equal(requirement.storyboardRequired,false);
    assert.deepEqual(h3StoryboardIssues({duration:6}, requirement.storyboardRequired ? requirement.shots : undefined),[]);
    for (const id of ['s2','s3']) (snapshot.director.shotInputs as Record<string,unknown>)[id] = {keyframeAssetId:id,keyframePolicy:'reuse'};
    db.db.prepare('UPDATE canvas_productions SET published_json=? WHERE project_id=?').run(JSON.stringify(snapshot),'canvas');
    requirement = requirements();
    assert.equal(requirement.storyboardRequired,true);
    assert.ok(h3StoryboardIssues({duration:6}, requirement.shots).length > 0);
    (snapshot.director.shotInputs as Record<string,unknown>).s2 = {keyframeAssetId:'disabled',keyframePolicy:'none'};
    db.db.prepare('UPDATE canvas_productions SET published_json=? WHERE project_id=?').run(JSON.stringify(snapshot),'canvas');
    assert.equal(requirements().storyboardRequired,false);
});
