/** H3 reference tags are meaningful only inside a Clip editor. */
export function unresolvedClipReferenceTokens(text: string, knownTokens: ReadonlySet<string>, clipReferenceTags: boolean): string[] {
    if (!clipReferenceTags) return [];
    return [...new Set([...text.matchAll(/<(?:Subject|Picture|Video|Audio)\s+\d+>/giu)]
        .map((match) => match[0])
        .filter((token) => !knownTokens.has(token.toLocaleLowerCase())))];
}
