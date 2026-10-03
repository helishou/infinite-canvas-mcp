import { spawn } from 'node:child_process';
import type { MediaStore } from '../stores/types.js';
import { canonicalH3AspectRatio, estimateH3Dimensions } from './h3-params.js';

const pathKey = (value: unknown) => String(value || '').replace(/\\/g, '/').toLowerCase();
const sameModel = (a: unknown, b: unknown) => pathKey(a) === pathKey(b) || pathKey(a).split('/').pop() === pathKey(b).split('/').pop();

/** Compare the frozen request with executable native node inputs, before /prompt. */
export function assertH3WorkflowContract(workflow: Record<string, any>, expected: Record<string, unknown>) {
    const native = Object.values(workflow).find((node: any) => ['NanFengH3MultiReferenceGeneratorV15', 'InfiniteCanvasH3ConfirmedGeneratorV15'].includes(node.class_type))?.inputs;
    if (!native) {
        const nodes = Object.values(workflow) as any[];
        const has = (type: string, field: string, value: unknown) => nodes.some(node => node.class_type === type && sameModel(node.inputs?.[field], value));
        const issues: string[] = [];
        if (!has('UNETLoader', 'unet_name', expected.modelName)) issues.push('modelName');
        if (!has('CLIPLoader', 'clip_name', expected.textEncoder)) issues.push('textEncoder');
        if (!has('VAELoader', 'vae_name', expected.videoVae)) issues.push('videoVae');
        if (!has('VAELoader', 'vae_name', expected.audioVae)) issues.push('audioVae');
        const wanted = (Array.isArray(expected.loraSlots) ? expected.loraSlots as any[] : []).filter(slot => slot.enabled !== false && slot.name && slot.name !== '未选择');
        const actual = nodes.filter(node => node.class_type === 'LoraLoaderModelOnly').map(node => node.inputs);
        if (wanted.length !== actual.length || wanted.some(slot => !actual.some(item => sameModel(slot.name, item.lora_name) && Number(slot.strength ?? 1) === Number(item.strength_model)))) issues.push('loraSlots');
        if (expected.postGenerationOnly !== true) {
            if (!nodes.some(node => node.class_type === 'KSamplerSelect' && node.inputs?.sampler_name === expected.sampler)) issues.push('sampler');
            if (!nodes.some(node => node.class_type === 'BasicScheduler' && node.inputs?.scheduler === expected.scheduler)) issues.push('scheduler');
            const frame = nodes.find(node => ['MiniMaxH3ReferenceToVideo2', 'MiniMaxH3ImageToVideo', 'MiniMaxH3AudioConditioningT8', 'JZL_MiniMaxH3ReferenceToVideo2'].includes(node.class_type))?.inputs;
            if (!frame) issues.push('frame dimensions');
            else if (typeof frame.width === 'number' && typeof frame.height === 'number') {
                const ratio = canonicalH3AspectRatio(expected.aspectRatio)?.split(':').map(Number);
                if (ratio && Math.abs(frame.width - frame.height * ratio[0] / ratio[1]) > 32) issues.push('aspectRatio');
            }
        }
        if (expected.latentUpscaleEnabled === true && !nodes.some(node => node.class_type === 'NanFengH3LowPeakLatentUpscalerV15' && sameModel(node.inputs?.model_name, expected.latentUpscaleModel) && Number(node.inputs?.target_megapixels) === Number(expected.latentUpscaleMegapixels))) issues.push('latentUpscale');
        if (issues.length) throw Object.assign(new Error(`H3 展开工作流偏离冻结参数：${issues.join('、')}`), { code: 'H3_WORKFLOW_MISMATCH', fields: issues });
        return;
    }
    const mismatches: string[] = [];
    for (const [key, field] of [['modelName', '模型'], ['textEncoder', '文本编码器'], ['videoVae', '视频VAE'], ['audioVae', '音频VAE']] as const)
        if (expected[key] && !sameModel(expected[key], native[field])) mismatches.push(key);
    for (const [key, field] of [['sampler', '采样器'], ['scheduler', '调度器'], ['megapixels', '百万像素'], ['steps', '采样步数'], ['denoise', '降噪强度'], ['v81ManualSigma', 'V81一采使用手动Sigma'], ['latentUpscaleEnabled', '启用H3潜空间放大二采']] as const)
        if (expected[key] !== undefined && expected[key] !== native[field]) mismatches.push(key);
    if (canonicalH3AspectRatio(expected.aspectRatio) !== canonicalH3AspectRatio(native['画面比例'])) mismatches.push('aspectRatio');
    if (expected.v81ManualSigma === true && expected.h3FullSigma !== native['H3完整Sigma序列']) mismatches.push('h3FullSigma');
    if (expected.latentUpscaleEnabled === true) {
        if (!sameModel(expected.latentUpscaleModel, native['H3潜空间放大模型'])) mismatches.push('latentUpscaleModel');
        for (const [key, field] of [['latentUpscaleMegapixels', 'H3潜空间目标百万像素'], ['h3FirstSteps', 'H3一采步数'], ['h3SecondSteps', 'H3二采步数'], ['h3FullSigma', 'H3完整Sigma序列']] as const)
            if (expected[key] !== undefined && expected[key] !== native[field]) mismatches.push(key);
    }
    const wanted = (Array.isArray(expected.loraSlots) ? expected.loraSlots as any[] : []).filter(slot => slot.enabled !== false && slot.name && slot.name !== '未选择');
    const actual = native['启用LoRA'] === true ? Array.from({ length: 8 }, (_, i) => ({ name: native[`LoRA${i + 1}`], strength: native[`LoRA${i + 1}强度`], enabled: native[`LoRA${i + 1}启用`] })).filter(slot => slot.enabled && slot.name && slot.name !== '未选择') : [];
    if (wanted.length !== actual.length || wanted.some((slot, i) => !sameModel(slot.name, actual[i]?.name) || Number(slot.strength ?? 1) !== Number(actual[i]?.strength))) mismatches.push('loraSlots');
    if (mismatches.length) throw Object.assign(new Error(`H3 最终工作流偏离冻结参数：${mismatches.join('、')}`), { code: 'H3_WORKFLOW_MISMATCH', fields: mismatches });
}

export async function probeH3Video(file: string) {
    const binary = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe');
    return new Promise<{ width: number; height: number; rotation: number; sampleAspectRatio: string }>((resolve, reject) => {
        const child = spawn(binary, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let output = '', errors = '';
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { errors += String(chunk); });
        child.once('error', reject);
        child.once('close', code => {
            try {
                if (code !== 0) throw new Error(`ffprobe 无法核对 H3 媒体：${errors.trim()}`);
                const stream = JSON.parse(output).streams?.[0];
                if (!(stream?.width > 0 && stream?.height > 0)) throw new Error('H3 媒体缺少有效视频尺寸');
                resolve({ width: stream.width, height: stream.height, rotation: Number(stream.side_data_list?.find((item: any) => item.rotation !== undefined)?.rotation || stream.tags?.rotate || 0), sampleAspectRatio: stream.sample_aspect_ratio || '1:1' });
            } catch (error) { reject(error); }
        });
    });
}

export function compareH3MediaSpecification(measured: { width: number; height: number; rotation?: number; sampleAspectRatio?: string }, expected: Record<string, unknown>) {
    const second = expected.latentUpscaleEnabled === true && expected.latentConfirmationPhase !== 'first';
    const dimensions = estimateH3Dimensions(expected, second);
    const issues: string[] = [];
    const ratio = canonicalH3AspectRatio(expected.aspectRatio);
    if (measured.rotation && measured.rotation % 360 !== 0) issues.push('视频带旋转元数据，显示画幅与编码画幅不同');
    if (measured.sampleAspectRatio && !['1:1', 'N/A', '0:1'].includes(measured.sampleAspectRatio)) issues.push('视频像素不是方形，显示画幅需要核对');
    if (ratio) {
        const [rw, rh] = ratio.split(':').map(Number);
        if ((rw < rh && measured.width >= measured.height) || (rw > rh && measured.width <= measured.height) || Math.abs(measured.width - measured.height * rw / rh) > (dimensions?.grid || 32)) issues.push(`媒体画幅 ${measured.width}×${measured.height} 不符合 ${ratio}`);
    }
    if (dimensions && expected.rtxEnabled !== true && (!expected.dlssUpscaleMode || expected.dlssUpscaleMode === '关闭') && (Math.abs(dimensions.width - measured.width) > dimensions.grid || Math.abs(dimensions.height - measured.height) > dimensions.grid)) issues.push(`媒体尺寸不符合${second ? '二采' : '一采'}规格 ${dimensions.width}×${dimensions.height}`);
    return { status: issues.length ? 'mismatch' : 'passed', measured: { ...measured, kind: 'media-probe' }, expected: dimensions, issues };
}

/** Preserve media even when it fails specification; never pretend probe failures passed. */
export async function inspectH3Result(result: Record<string, any>, params: Record<string, unknown>, media: MediaStore) {
    if (!params.h3ExecutionContract) return result;
    const video = (result.media || []).find((item: any) => String(item.mimeType).startsWith('video/'));
    try {
        const stored = video?.storageKey && media.meta(video.storageKey);
        if (!stored) throw new Error('H3 结果未归档，无法核对媒体');
        const measured = await probeH3Video(stored.filePath);
        return { ...result, specification: compareH3MediaSpecification(measured, params) };
    } catch (error) {
        return { ...result, specification: { status: 'mismatch', measured: null, issues: [(error as Error).message] } };
    }
}
