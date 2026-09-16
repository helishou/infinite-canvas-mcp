import { useEffect, useMemo, useState } from "react";
import { Modal, Checkbox, Switch } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3CharacterGroup } from "../types";

// 双击 ref 槽中带 groupId 的格子后弹出：选择这个角色在本段实际进入 ref 槽的 outfit 集合、是否启用声线。
// 应用时由 H3Workbench 的 onApply 走 applyCharacterGroupEdits 重写 refs。
export function H3CharacterRefModal({
    ctx,
    group,
    onApply,
    onDelete,
    onClose,
}: {
    ctx: CanvasNodeContext;
    group: H3CharacterGroup;
    onApply: (patch: { outfitEnabled?: Record<string, boolean>; voiceEnabled?: boolean }) => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    const initialEnabled = useMemo(() => {
        const map: Record<string, boolean> = {};
        for (const outfit of group.outfits) map[outfit.id] = outfit.enabled;
        return map;
    }, [group.id, group.outfits.length]);
    const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(initialEnabled);
    const [voiceEnabled, setVoiceEnabled] = useState(group.voiceEnabled);
    useEffect(() => {
        setEnabledMap(initialEnabled);
        setVoiceEnabled(group.voiceEnabled);
    }, [group.id, initialEnabled, group.voiceEnabled]);
    const apply = () => { onApply({ outfitEnabled: enabledMap, voiceEnabled }); onClose(); };
    return <Modal
        open
        title={`${group.characterName} · 服装与声线`}
        onCancel={onClose}
        onOk={apply}
        okText="应用到当前 Clip"
        cancelText="取消"
        width={520}
        destroyOnClose
    >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 8 }}>
            <div>
                <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>服装（{Object.values(enabledMap).filter(Boolean).length}/{group.outfits.length}）</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
                    {group.outfits.map((outfit) => {
                        const checked = enabledMap[outfit.id] ?? false;
                        return <label key={outfit.id} style={{ position: "relative", display: "block", border: `1px solid ${checked ? ctx.theme.node.activeStroke : ctx.theme.node.stroke}`, borderRadius: 6, overflow: "hidden", cursor: "pointer", background: ctx.theme.node.panel, opacity: checked ? 1 : 0.45 }}>
                            <img src={outfit.url} alt={outfit.name} style={{ width: "100%", height: 76, objectFit: "cover", display: "block" }} />
                            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 12 }}>
                                <Checkbox checked={checked} onChange={(event) => setEnabledMap((current) => ({ ...current, [outfit.id]: event.target.checked }))} />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{outfit.name}</span>
                            </div>
                        </label>;
                    })}
                </div>
            </div>
            {group.voice ? <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6, background: ctx.theme.node.panel }}>
                <span style={{ fontSize: 13 }}>声线</span>
                <span style={{ flex: 1, fontSize: 12, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.voice.name}</span>
                <Switch checked={voiceEnabled} onChange={setVoiceEnabled} />
            </div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <a style={{ color: "#ef4444", fontSize: 12, cursor: "pointer" }} onClick={onDelete}>从本段移除整组</a>
            </div>
        </div>
    </Modal>;
}
