export type ImportedScriptBlock = {
    id: string;
    scene_id: string;
    kind: "action";
    text: string;
    scene_name?: string;
    heading?: string;
    location?: string;
    time_of_day?: string;
};

type SceneIdentity = { blockId: string; sceneId: string; sceneName: string; location: string; timeOfDay: string };

function shotMarkerMatches(text: string) {
    return [...text.matchAll(/【\s*镜头\s*([^】\r\n]+?)\s*】/g)];
}

/** Count explicit script headings; these are cues, not formal timed production Shots. */
export function explicitShotCueCount(text: string) {
    return shotMarkerMatches(text).length;
}

/**
 * Split only at authored 镜头 headings. Every text slice is copied verbatim and the
 * returned rows concatenate to the original demand without adding or removing bytes.
 * Untagged content remains a single editable action block; no durations or camera data
 * are inferred here.
 */
export function importDemandScriptBlocks(text: string, identity: SceneIdentity): ImportedScriptBlock[] {
    const matches = shotMarkerMatches(text);
    const metadata = { scene_id: identity.sceneId, scene_name: identity.sceneName, heading: identity.sceneName, location: identity.location, time_of_day: identity.timeOfDay };
    if (!matches.length) return [{ id: identity.blockId, ...metadata, kind: "action", text }];

    const slices: string[] = [];
    const firstOffset = matches[0].index ?? 0;
    if (firstOffset > 0 && text.slice(0, firstOffset).trim()) slices.push(text.slice(0, firstOffset));
    for (let index = 0; index < matches.length; index += 1) {
        const start = index === 0 && slices.length === 0 ? 0 : (matches[index].index ?? 0);
        const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
        slices.push(text.slice(start, end));
    }

    return slices.map((slice, index) => ({
        id: index === 0 ? identity.blockId : `${identity.blockId}-N${String(index + 1).padStart(2, "0")}`,
        ...(index === 0 ? metadata : { scene_id: identity.sceneId }),
        kind: "action",
        text: slice,
    }));
}
