/** Action-based groups keep registered plugin tools reachable without listing node types. */
export const canvasNodeActionGroupOrder = ["inspect", "edit", "generate", "organize", "extensions", "danger"] as const;
export type CanvasNodeActionGroup = typeof canvasNodeActionGroupOrder[number];

type NodeAction = { id: string; danger?: boolean };

const actionGroups: Record<string, CanvasNodeActionGroup> = {
    info: "inspect", view: "inspect", download: "inspect", copyPrompt: "inspect", compareVideo: "inspect",
    replace: "edit", resize: "edit", maskEdit: "edit", crop: "edit", split: "edit", stitch: "edit", upscale: "edit", superResolve: "edit", autoLevels: "edit", angle: "edit",
    trimVideo: "edit", extractAudio: "edit", edit: "edit", config: "edit", decreaseFont: "edit", increaseFont: "edit", uploadImage: "edit", uploadVideo: "edit", uploadAudio: "edit",
    retry: "generate", generateImage: "generate", reversePrompt: "generate", convertToCharacter: "generate", convertToScene: "generate", convertToProp: "generate",
    saveAsset: "organize", saveCharacterToAsset: "organize", saveSceneToAsset: "organize", arrangeGroup: "organize", createOrderedGroupCollage: "organize", toggleOrderedGroup: "organize", groupLock: "organize",
    delete: "danger", discardShared: "danger",
};

export function groupCanvasNodeActions<T extends NodeAction>(actions: readonly T[]): { id: CanvasNodeActionGroup; actions: T[] }[] {
    const groups = new Map<CanvasNodeActionGroup, T[]>();
    for (const action of actions) {
        const group = action.danger ? "danger" : actionGroups[action.id] || "extensions";
        const items = groups.get(group) || [];
        items.push(action);
        groups.set(group, items);
    }
    return canvasNodeActionGroupOrder.flatMap((id) => {
        const items = groups.get(id);
        return items?.length ? [{ id, actions: items }] : [];
    });
}

/** Production canvas toolbars have dedicated primary actions, so their More menu must retain every node action. */
export function canvasNodeDropdownActions<T extends NodeAction>(allActions: readonly T[], moreActions: readonly T[], productionToolbar: boolean): T[] {
    const source = productionToolbar ? allActions : moreActions;
    return [...new Map(source.map(action => [action.id, action])).values()];
}

const nearbyActionIds = new Set(["info", "view", "download", "retry", "edit", "config", "generateImage", "uploadImage", "uploadVideo", "uploadAudio", "extractAudio", "decreaseFont", "increaseFont", "arrangeGroup", "groupLock"]);

/** Image customization is retained verbatim; every omitted action remains in the full menu. */
export function nearbyCanvasNodeActions<T extends NodeAction>(actions: readonly T[], selectedImageIds?: ReadonlySet<string>): T[] {
    return actions.filter((action) => selectedImageIds ? selectedImageIds.has(action.id) : nearbyActionIds.has(action.id) || (!actionGroups[action.id] && !action.danger));
}
