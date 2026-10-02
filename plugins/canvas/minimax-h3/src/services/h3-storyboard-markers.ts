/** Only a line-opening shot label starts a storyboard shot; inline labels are references. */
export function storyboardShotMarkers(description: string) {
    return [...description.matchAll(/^[\t ]*\[Shot[\t ]+(\d+)\](?:[\t ]+At[\t ]+(\d{1,2}:\d{2}(?:\.\d{1,3})?)[,，]?)?/gimu)];
}

/** The track parser leaves the optional time in the body for its legacy time handling. */
export function storyboardShotLabelMarkers(description: string) {
    return [...description.matchAll(/^[\t ]*\[Shot[\t ]+\d+\]/gimu)];
}
