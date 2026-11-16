import type { Router } from "express";
import { z } from "zod";
import {
    ASSET_KIND_SKILL,
    assetSpecKinds,
    assetSpecReadiness,
    assetSpecSchema,
    assetSpecSummary,
    buildAssetImagePrompt,
    missingAssetSpecFields,
} from "@basketikun/canvas-agent/drama/asset-spec";

import type { BackendDatabase } from "../db.js";
import { resolveDramaArtStyleByDb } from "../drama/art-style.js";

/**
 * 角色 / 场景 / 道具设定卡的读写口。
 *
 * 真值落在资产自身：asset.metadata.assetSpec —— 不新建第二份资产，
 * 也不把设定复制到分集里；分镜与编译要用的摘要用 assetSpecSummary() 现场生成。
 */

const kindSchema = z.enum(assetSpecKinds);

const patchSchema = z.object({
    kind: kindSchema,
    /** 只传要改的键；整块字段由 asset-spec 的 per-kind schema 校验。 */
    spec: z.record(z.unknown()),
    /** 顺手把提示词也拼回来（按该类型的技能模板），省一次往返。 */
    wantPrompt: z.boolean().optional(),
}).strict();

function readSpec(db: BackendDatabase, assetId: string) {
    const asset = db.getAsset(assetId);
    if (!asset) return null;
    const raw = (asset.metadata || {}).assetSpec;
    if (!raw) return { asset, spec: null };
    const parsed = assetSpecSchema.safeParse(raw);
    return { asset, spec: parsed.success ? parsed.data : null };
}

function payload(asset: { id: string; title: string; kind: string }, spec: ReturnType<typeof assetSpecSchema.parse> | null, assetId: string, style: { artStyle: string; language: string } = { artStyle: "", language: "" }) {
    const kind = spec?.kind || (assetSpecKinds.includes(String(asset.kind) as never) ? String(asset.kind) as (typeof assetSpecKinds)[number] : null);
    if (!kind) return { ok: true, assetId, title: asset.title, kind: asset.kind, spec: null, hint: "这个资产的类型不是角色/场景/道具，没有设定卡" };
    const readiness = assetSpecReadiness(kind, spec);
    return {
        ok: true,
        assetId,
        title: asset.title,
        kind,
        spec,
        summary: assetSpecSummary(kind, spec),
        missing: missingAssetSpecFields(kind, spec),
        readiness,
        prompt: spec ? buildAssetImagePrompt(kind, spec, asset.title, { artStyle: style.artStyle, language: style.language }) : "",
    };
}

export function registerAssetSpecRoutes(router: Router, db: BackendDatabase) {
    router.get<Record<string, string>>("/assets/:assetId/spec", (req, res) => {
        const assetId = String(req.params.assetId);
        const found = readSpec(db, assetId);
        if (!found) return void res.status(404).json({ ok: false, error: "资产不存在" });
        res.json(payload(found.asset, found.spec, assetId, resolveDramaArtStyleByDb(db, String((found.asset as Record<string, unknown>).dramaId || ""))));
    });

    router.patch<Record<string, string>>("/assets/:assetId/spec", (req, res) => {
        const assetId = String(req.params.assetId);
        const parsed = patchSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        const found = readSpec(db, assetId);
        if (!found) return void res.status(404).json({ ok: false, error: "资产不存在" });
        const { kind, spec: patch } = parsed.data;
        const current = found.spec || { kind };
        const merged = assetSpecSchema.safeParse({
            ...current,
            kind,
            [kind]: { ...((current as Record<string, unknown>)[kind] as Record<string, unknown> || {}), ...patch },
            updatedAt: new Date().toISOString(),
        });
        if (!merged.success) return void res.status(400).json({ ok: false, error: merged.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
        const asset = { ...found.asset, metadata: { ...(found.asset.metadata || {}), assetSpec: merged.data }, updatedAt: new Date().toISOString() };
        const saved = db.upsertAsset(asset as never);
        res.json(payload(saved, merged.data, assetId, resolveDramaArtStyleByDb(db, String((saved as Record<string, unknown>).dramaId || ""))));
    });

    /** 剧目下所有资产设定卡的清单：agent 开工前一次看全，知道谁还缺设定。 */
    router.get<Record<string, string>>("/drama/:dramaId/asset-specs", (req, res) => {
        const dramaId = String(req.params.dramaId);
        const assets = db.listAssets().filter((asset) => String(asset.dramaId || "") === dramaId);
        const rows = assets
            .filter((asset) => assetSpecKinds.includes(String(asset.kind) as never))
            .map((asset) => {
                const found = readSpec(db, asset.id);
                const kind = String(asset.kind) as (typeof assetSpecKinds)[number];
                const missing = missingAssetSpecFields(kind, found?.spec || null);
                return {
                    assetId: asset.id,
                    title: asset.title,
                    kind,
                    hasSpec: Boolean(found?.spec),
                    missing,
                    imageKind: ASSET_KIND_SKILL[kind].imageKind,
                    skill: ASSET_KIND_SKILL[kind].path,
                };
            });
        res.json({ ok: true, dramaId, total: rows.length, ready: rows.filter((row) => row.missing.length === 0).length, assets: rows });
    });
}
