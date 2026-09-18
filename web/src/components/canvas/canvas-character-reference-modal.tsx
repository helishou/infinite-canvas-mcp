import { useEffect, useMemo, useState } from "react";
import { Checkbox, Modal, Switch } from "antd";
import { Image as ImageIcon, Music2, User } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { characterReferenceKey, type CanvasCharacterReferenceSelection } from "@/lib/canvas/canvas-resource-references";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type CharacterImage = NonNullable<NonNullable<CanvasNodeData["metadata"]>["characterImages"]>[number];

export function CanvasCharacterReferenceModal({ node, selection, onApply, onClose }: {
    node: CanvasNodeData;
    selection?: CanvasCharacterReferenceSelection;
    onApply: (selection: CanvasCharacterReferenceSelection) => void;
    onClose: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const images = node.metadata?.characterImages || [];
    const hasVoice = Boolean(node.metadata?.characterVoiceUrl || node.metadata?.characterVoiceStorageKey);
    const defaultImageKeys = useMemo(() => new Set(images.map((image, index) => characterReferenceKey(image, index))), [images]);
    const [imageKeys, setImageKeys] = useState<Set<string>>(defaultImageKeys);
    const [voiceEnabled, setVoiceEnabled] = useState(true);

    useEffect(() => {
        setImageKeys(selection?.imageKeys ? new Set(selection.imageKeys) : new Set(defaultImageKeys));
        setVoiceEnabled(selection?.voiceEnabled !== false);
    }, [defaultImageKeys, selection]);

    const toggleImage = (image: CharacterImage, index: number, checked: boolean) => {
        const key = characterReferenceKey(image, index);
        setImageKeys((current) => {
            const next = new Set(current);
            if (checked) next.add(key);
            else next.delete(key);
            return next;
        });
    };

    return (
        <Modal
            open
            centered
            width={560}
            title={<span className="inline-flex items-center gap-2"><User className="size-4" />{node.metadata?.characterName || node.title || "角色"} · 参考输入</span>}
            okText="应用到生成节点"
            cancelText="取消"
            onOk={() => { onApply({ imageKeys: images.flatMap((image, index) => imageKeys.has(characterReferenceKey(image, index)) ? [characterReferenceKey(image, index)] : []), voiceEnabled }); onClose(); }}
            onCancel={onClose}
            destroyOnHidden
        >
            <div className="space-y-4 pt-1" style={{ color: theme.node.text }}>
                <div>
                    <div className="mb-2 flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                        <span>角色图片（{imageKeys.size}/{images.length}）</span>
                        <div className="flex gap-1">
                            <button type="button" className="px-1.5 py-0.5 hover:opacity-70" onClick={() => setImageKeys(new Set(defaultImageKeys))}>全选</button>
                            <button type="button" className="px-1.5 py-0.5 hover:opacity-70" onClick={() => setImageKeys(new Set())}>清空</button>
                        </div>
                    </div>
                    {images.length ? (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {images.map((image, index) => {
                                const checked = imageKeys.has(characterReferenceKey(image, index));
                                return <label key={`${characterReferenceKey(image, index)}:${index}`} className="group relative cursor-pointer overflow-hidden rounded-xl border transition" style={{ borderColor: checked ? theme.node.activeStroke : theme.toolbar.border, background: theme.node.panel, opacity: checked ? 1 : 0.52 }}>
                                    <img src={image.url} alt={image.outfit || image.name || "角色参考图"} className="h-28 w-full object-cover" draggable={false} />
                                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
                                        <Checkbox checked={checked} onChange={(event) => toggleImage(image, index, event.target.checked)} />
                                        <span className="min-w-0 truncate">{image.outfit || image.name || `参考图 ${index + 1}`}</span>
                                    </div>
                                </label>;
                            })}
                        </div>
                    ) : (
                        <div className="flex h-24 items-center justify-center rounded-xl border text-sm" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>暂无角色图片</div>
                    )}
                </div>

                {hasVoice ? (
                    <div className="flex items-center gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.node.panel }}>
                        <Music2 className="size-4 shrink-0" style={{ color: theme.node.activeStroke }} />
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">{node.metadata?.characterVoiceName || "角色声线"}</div>
                            {node.metadata?.characterVoiceDescription ? <div className="mt-0.5 truncate text-xs" style={{ color: theme.node.muted }}>{node.metadata.characterVoiceDescription}</div> : null}
                        </div>
                        <Switch checked={voiceEnabled} onChange={setVoiceEnabled} />
                    </div>
                ) : null}

                <div className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <ImageIcon className="size-3.5" />双击参考栏中的角色卡片可再次调整输入内容
                </div>
            </div>
        </Modal>
    );
}
