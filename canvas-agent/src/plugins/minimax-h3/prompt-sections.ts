export type H3PromptMode = "ref2va" | "t2v" | "i2v" | "fl2v";
export type H3PromptSection =
    | "subject_definitions"
    | "summary"
    | "retention_analysis"
    | "detailed_description"
    | "integrated_multimodal_description"
    | "overall_soundscape"
    | "non_diegetic_music";

export type H3PromptSectionValues = Partial<Record<H3PromptSection, string>>;

const H3_PROMPT_SECTION_ORDER: Record<H3PromptMode, readonly H3PromptSection[]> = {
    ref2va: ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"],
    t2v: ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"],
    i2v: ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"],
    fl2v: ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"],
};

const H3_PROMPT_SECTION_HEADER = /^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music|storyboard_timeline):[ \t]*(?:\r?\n)?/mi;

function promptMode(mode: string): H3PromptMode {
    return mode === "t2v" || mode === "i2v" || mode === "fl2v" ? mode : "ref2va";
}

export function h3PromptSectionsForMode(mode: string) {
    return H3_PROMPT_SECTION_ORDER[promptMode(mode)];
}

export function readH3PromptSection(prompt: string, section: H3PromptSection) {
    const header = new RegExp(`^${section}:[ \\t]*(?:\\r?\\n)?`, "mi").exec(prompt);
    if (!header) return "";
    const bodyStart = header.index + header[0].length;
    const remainder = prompt.slice(bodyStart);
    const next = H3_PROMPT_SECTION_HEADER.exec(remainder);
    return remainder.slice(0, next?.index ?? remainder.length).trim();
}

/**
 * Rebuild a prompt from its managed sections. Anything before the first
 * managed section, and anything outside the selected mode's section order,
 * is intentionally discarded so legacy free text cannot survive migration.
 */
export function assembleH3Prompt(mode: string, sections: H3PromptSectionValues) {
    return h3PromptSectionsForMode(mode).map((section) => {
        const content = sections[section]?.trim() || "";
        return content ? `${section}:\n${content}` : `${section}:`;
    }).join("\n\n");
}

export function replaceH3PromptSection(prompt: string, section: H3PromptSection, content: string, mode: string) {
    const sections = Object.fromEntries(h3PromptSectionsForMode(mode).map((name) => [name, readH3PromptSection(prompt, name)])) as H3PromptSectionValues;
    sections[section] = content;
    return assembleH3Prompt(mode, sections);
}
