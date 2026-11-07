import fs from 'node:fs';
import { workflowDisplayGraph, workflowSourcePositions } from './src/pages/workflows/workflow-source.ts';
const wf = JSON.parse(fs.readFileSync('C:/Users/wxy/.infinite-canvas/workflows/custom/H3+影视武打无限流1101++无限接续长视频无劣化无色差+_+复杂高速大动态+_++宏大场景（工作版）.json','utf8'));
const g = workflowDisplayGraph(wf);
console.log('display nodes:', Object.keys(g).length);
const pos = workflowSourcePositions(wf);
console.log('positions:', pos.size, JSON.stringify([...pos.entries()].slice(0,3)));
const xs=[...pos.values()].map(p=>p.x), ys=[...pos.values()].map(p=>p.y);
console.log('x range', Math.min(...xs), Math.max(...xs), 'y range', Math.min(...ys), Math.max(...ys));
