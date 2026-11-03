import type { WorkflowField } from '../db.js';
import { injectParams, removeEmptyMediaNodes, selectedSwitchBranch, validatePromptGraph } from './executor.js';
import { convertComfyWorkflowToApi } from './comfyui-workflow-conversion.js';

/** Derive capacity using the same compiled graph and missing-media rules as execution. */
export function workflowImageInputs(source: Record<string, unknown>, fields: WorkflowField[], outputNodes?: string[]) {
 const workflow = Array.isArray(source.nodes) ? convertComfyWorkflowToApi(source) : source;
 const claimed = new Set<string>();
 const outputs = outputNodes?.length ? outputNodes : Object.keys(workflow).filter(id => ['SaveImage','PreviewImage'].includes((workflow[id] as any)?.class_type));
 const reachable = new Set<string>();
 const visit = (id: string) => {
  if (reachable.has(id)) return;
  reachable.add(id);
  const node = workflow[id] as {class_type?:string;inputs?:Record<string,unknown>} | undefined;
  const branch = node?.class_type === 'ComfySwitchNode' ? selectedSwitchBranch(workflow, node) : null;
  for (const [name,value] of Object.entries(node?.inputs || {})) {
   if (branch && (name === 'on_true' || name === 'on_false') && name !== branch) continue;
   if (Array.isArray(value) && typeof value[0] === 'string') visit(value[0]);
  }
 };
 outputs.forEach(visit);
 const images = fields.filter(field => {
  const ids = field.node.split(',').map(id => id.trim());
  const targets = ids.map(id => `${id}.${field.input}`);
  if (outputs.length && !ids.some(id => reachable.has(id))) return false;
  if (!ids.every(id => {
   const node = workflow[id] as {class_type?:string;inputs?:Record<string,unknown>} | undefined;
   return node?.inputs && (field.input in node.inputs || node.class_type === 'LoadImage' && field.input === 'image') && !Array.isArray(node.inputs[field.input]);
  })) return false;
  if (field.type !== 'image' && !ids.some(id => (workflow[id] as any)?.class_type === 'LoadImage')) return false;
  if (targets.some(target => claimed.has(target))) return false;
  targets.forEach(target => claimed.add(target));
  return true;
 });
 let structurallyValid = true;
 try { validatePromptGraph(workflow); } catch { structurallyValid = false; }
 const counts: number[] = [];
 // Image compatibility must not become a general workflow validator (e.g. output setup).
 if (!images.length) return { fields: images, counts: [0] };
 for (let count=0;count<=images.length;count++) {
  const params: Record<string,Record<string,unknown>> = {};
  const values: Record<string,unknown> = {};
  images.forEach((field,index) => {
   const value = index<count ? '__canvas_reference__.png' : null;
   values[field.id]=value;
   for (const id of field.node.split(',').map(id=>id.trim())) (params[id] ||= {})[field.input]=value;
  });
  if (images.some((field,index)=>field.required === true && index>=count)) continue;
  try {
   const prepared = removeEmptyMediaNodes(injectParams(workflow,params),images,values);
   if (structurallyValid) validatePromptGraph(prepared);
   // The executor's structural validator cannot detect a deleted required output socket.
   if (Object.entries(workflow).some(([id,node]) => {
    const output = node as {class_type?:string;inputs?:Record<string,unknown>};
    if (!outputs.includes(id)) return false;
    return Object.keys(output.inputs || {}).some(key => !(key in ((prepared[id] as any)?.inputs || {})));
   })) continue;
   counts.push(count);
  } catch { /* Exact executor would reject this missing-media shape. */ }
 }
 return {fields:images,counts};
}
