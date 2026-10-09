export type ClipPartitionDraft = { base: string; cuts: string[]; profileChoices: Record<string, string> };

export function readClipPartitionDraft(raw: string | undefined, currentBase: string) {
    if (!raw) return { draft: undefined, invalid: false, sourceChanged: false };
    try {
        const draft = JSON.parse(raw) as ClipPartitionDraft;
        if (!draft || typeof draft.base !== "string" || !Array.isArray(draft.cuts)
            || !draft.cuts.every(cut => typeof cut === "string") || !draft.profileChoices
            || typeof draft.profileChoices !== "object" || Array.isArray(draft.profileChoices)
            || !Object.values(draft.profileChoices).every(value => typeof value === "string")) throw new Error("Invalid Clip draft");
        return { draft, invalid: false, sourceChanged: draft.base !== currentBase };
    } catch {
        return { draft: undefined, invalid: true, sourceChanged: false };
    }
}
