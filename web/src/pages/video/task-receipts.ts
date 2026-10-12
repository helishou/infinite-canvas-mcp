import localforage from 'localforage';
import { getBackendUrl } from '@/services/backend-api';
import { getBackendTokenShared } from '@/lib/backend-token';
import type { VideoGenerationTask } from '@/services/api/video';
// Receipts contain no prompt, media, credentials or second editable draft.
export type VideoReceipt = { id: string; createdAt: number; task?: VideoGenerationTask; submissionUnknown?: boolean; queryEndpoint?: string; providerFingerprint?: string; ownerKey?: string };
const store = localforage.createInstance({ name: 'infinite-canvas', storeName: 'video_task_receipts' });
export async function captureVideoOwner() {
    const backend = getBackendUrl();
    const token = getBackendTokenShared();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([backend, token])));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const key = JSON.stringify(['video-workbench', fingerprint]);
    const assertCurrent = () => { if (backend !== getBackendUrl() || token !== getBackendTokenShared()) throw new Error('Backend connection changed; the original task receipt is retained.'); };
    return { key, assertCurrent };
}
export async function retainVideoReceipt(receipt: VideoReceipt, ownerKey: string) {
    const { id, createdAt, task, submissionUnknown, queryEndpoint, providerFingerprint } = receipt;
    const safeTask = task ? { id: task.id, provider: task.provider, model: task.model, parameters: task.parameters } : undefined;
    await store.setItem(`${ownerKey}:${id}`, { scope: ownerKey, receipt: { id, createdAt, task: safeTask, submissionUnknown, queryEndpoint, providerFingerprint, ownerKey } });
}
export async function clearVideoReceipt(id: string, ownerKey: string) { await store.removeItem(`${ownerKey}:${id}`); }
export async function readVideoReceipts(ownerKey: string) {
    const receipts: VideoReceipt[] = [];
    await store.iterate<{ scope: string; receipt: VideoReceipt }, void>(entry => { if (entry.scope === ownerKey) receipts.push(entry.receipt); });
    return receipts;
}
