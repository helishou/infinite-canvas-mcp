import { resolveWorkflowBindingForModel, usesWorkflowExecutor } from '@basketikun/canvas-agent/model-workflow';

/** Unknown API/script/remote capability stays selectable under its existing execution contract. */
export function imageModelCompatibility(config: unknown, model: string, referenceCount: number, workflowCounts?: readonly number[]): 'supported' | 'unsupported' | 'unknown' {
 if (!usesWorkflowExecutor(config, model)) return 'unknown';
 const route = resolveWorkflowBindingForModel(config, model, referenceCount);
 if (!route.ok) return 'unsupported';
 if (route.binding.provider !== 'comfyui' || workflowCounts === undefined) return 'unknown';
 return workflowCounts.includes(referenceCount) ? 'supported' : 'unsupported';
}
