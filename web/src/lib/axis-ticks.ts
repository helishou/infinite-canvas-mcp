/**
 * Round gridlines for an integer count axis.
 *
 * A plain "max / 3" split produced labels like 0 / 2 / 5 / 7 for a max of 7, which reads as a
 * rendering bug. Steps come from the usual 1 / 2 / 2.5 / 5 ladder and never go below 1 because
 * these series count events.
 */
export function axisTicks(maximum: number, intervals = 4) {
    const top = Math.max(1, maximum);
    const rough = top / intervals;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = Math.max(1, [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10);
    const ceiling = Math.max(step, Math.ceil(top / step) * step);
    return Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => Math.round(index * step));
}
