import localforage from 'localforage';
import { getBackendUrl } from '@/services/backend-api';
import { getBackendTokenShared } from '@/lib/backend-token';
import type { VideoGenerationResult, VideoGenerationTask } from './video';
export type BrowserRecovery = { version: 1; phase: 'submitting' | 'external_task' | 'result_available' | 'archived'; cacheOwner: string; providerFingerprint?: string; externalTask?: VideoGenerationTask; output?: { media?: Array<{ storageKey: string }>; texts?: string[] } };
export type BrowserResultCache = { externalTask?: VideoGenerationTask; images?: Array<{dataUrl?: string;url?: string}>; video?: VideoGenerationResult; audio?: Blob; texts?: string[]; providerFingerprint?: string; output?: {media?:Array<{storageKey:string}>;texts?:string[]} };
const cache = localforage.createInstance({ name:'infinite-canvas', storeName:'browser_task_results' });
export async function browserRecoveryOwner() {
    const backend=getBackendUrl(), token=getBackendTokenShared();
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([backend,token])));
    const key=Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
    return { key, assertCurrent:()=>{if(backend!==getBackendUrl()||token!==getBackendTokenShared())throw new Error('Backend connection changed; original task recovery data retained.');} };
}
const key=(owner:string,id:string)=>JSON.stringify([owner,id]);
export const readBrowserResult=(owner:string,id:string)=>cache.getItem<BrowserResultCache>(key(owner,id));
export const saveBrowserResult=(owner:string,id:string,result:BrowserResultCache)=>cache.setItem(key(owner,id),result);
export const clearBrowserResult=(owner:string,id:string)=>cache.removeItem(key(owner,id));
export class BrowserProviderTerminalFailure extends Error {}
export class BrowserSubmissionUnknown extends Error {}

export class BrowserPreflightFailure extends Error {}
