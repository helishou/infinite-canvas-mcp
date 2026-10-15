type Row = Record<string, any>;
export type ContinuityLedgerCollection = 'facts' | 'timelines' | 'initial' | 'events' | 'requirements' | 'coverage';
export type ContinuityDeletionReference = { collection: string; id: string; shotId?: string; reason: string };
export type ContinuityDeletionAnalysis = {
    allowed: boolean;
    code: 'allowed' | 'missing' | 'ambiguous' | 'referenced' | 'shared_evidence';
    references: ContinuityDeletionReference[];
    removals: { collection: ContinuityLedgerCollection; id: string }[];
    affectedShotIds: string[];
};
const collections: ContinuityLedgerCollection[] = ['facts', 'timelines', 'initial', 'events', 'requirements', 'coverage'];
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
/** JSON tuples keep initial identities collision-free even when either ID contains a colon. */
export function continuityLedgerEntryId(collection: ContinuityLedgerCollection, row: Row): string {
    return collection === 'initial'
        ? typeof row.timeline_id === 'string' && row.timeline_id && typeof row.fact_id === 'string' && row.fact_id ? JSON.stringify([row.timeline_id, row.fact_id]) : ''
        : typeof row.id === 'string' ? row.id : '';
}

/** Analyze current authored data only; this never claims continuity validation has passed. */
export function analyzeContinuityDeletion(source: Row | undefined, ledger: Row, collection: ContinuityLedgerCollection, entry: Row | string): ContinuityDeletionAnalysis {
    const id = typeof entry === 'string' ? entry : continuityLedgerEntryId(collection, entry);
    const matches = rows(ledger[collection]).filter(row => continuityLedgerEntryId(collection, row) === id);
    const result: ContinuityDeletionAnalysis = { allowed: false, code: 'missing', references: [], removals: [], affectedShotIds: [] };
    if (!collections.includes(collection) || !id || !matches.length) return result;
    if (matches.length !== 1) return { ...result, code: 'ambiguous' };
    const target = matches[0];
    const affected = new Set<string>();
    const affect = (row: Row) => { if (typeof row.shot_id === 'string') affected.add(row.shot_id); strings(row.shot_ids).forEach(id => affected.add(id)); };
    const reference = (group: string, row: Row, reason: string, shotId?: string) => {
        result.references.push({ collection: group, id: group === 'initial' ? continuityLedgerEntryId('initial', row) : String(row.id || row.subjectId || ''), ...(shotId || row.shot_id ? { shotId: shotId || row.shot_id } : {}), reason });
        affect(row); if (shotId) affected.add(shotId);
    };
    const remove = (group: ContinuityLedgerCollection, row: Row) => {
        const rowId = continuityLedgerEntryId(group, row);
        if (!rowId || rows(ledger[group]).filter(item => continuityLedgerEntryId(group, item) === rowId).length !== 1) {
            reference(group, row, 'ambiguous_identity'); result.code = 'ambiguous'; return;
        }
        result.removals.push({ collection: group, id: rowId }); affect(row);
    };
    remove(collection, target);
    if (collection === 'facts' || collection === 'timelines') {
        for (const group of collections) for (const row of rows(ledger[group])) {
            if (group === collection && row === target) continue;
            if (collection === 'facts' ? row.fact_id === id || strings(row.fact_ids).includes(id) : row.timeline_id === id) reference(group, row, 'ledger_reference');
        }
        if (!source) reference('source', { id: '' }, 'source_unavailable');
        for (const shot of rows(source?.shots)) {
            if (collection === 'timelines' && shot.timeline_id === id) reference('shots', shot, 'shot_timeline', shot.id);
            if (collection === 'facts') {
                if (strings(shot.continuity_facts).includes(id)) reference('shots', shot, 'shot_fact', shot.id);
                for (const usage of rows(shot.subject_usages)) {
                    if (strings(usage.continuityFactIds).includes(id) || rows(usage.stateRequirements).some(row => row.factId === id)) reference('subject_usages', usage, 'subject_state', shot.id);
                }
            }
        }
        if (collection === 'facts') for (const subject of rows(source?.subject_registry)) for (const binding of rows(subject.pictureBindings)) {
            if (binding.applicableState && Object.prototype.hasOwnProperty.call(binding.applicableState, id)) reference('pictureBindings', binding, 'picture_state');
        }
        if (result.references.length) result.code = 'referenced';
    } else if (collection === 'initial') {
        // The initial state is timeline-wide, including Shots without visible subject usage.
        for (const shot of rows(source?.shots)) if (shot.timeline_id === target.timeline_id && typeof shot.id === 'string') affected.add(shot.id);
        for (const group of ['events', 'requirements', 'coverage']) for (const row of rows(ledger[group])) {
            if (row.timeline_id === target.timeline_id && (row.fact_id === target.fact_id || strings(row.fact_ids).includes(target.fact_id))) affect(row);
        }
    } else if (collection === 'events') {
        for (const group of ['requirements', 'coverage'] as const) for (const row of rows(ledger[group])) {
            if (!strings(row.event_ids).includes(id)) continue;
            // Coverage fact/shot sets are authored assertions, not derivable from the event list.
            // Do not shrink a shared record or refresh its digest to make deletion look valid.
            const exclusive = Array.isArray(row.event_ids) && row.event_ids.length === 1 && row.event_ids[0] === id && row.timeline_id === target.timeline_id
                && (group === 'requirements'
                    ? row.kind === 'change' && row.fact_id === target.fact_id && row.shot_id === target.shot_id
                    : row.evidence_kind === 'explicit_change' && Array.isArray(row.fact_ids) && row.fact_ids.length === 1 && row.fact_ids[0] === target.fact_id
                        && Array.isArray(row.shot_ids) && row.shot_ids.length === 1 && row.shot_ids[0] === target.shot_id
                        && row.source_anchor?.block_id === target.source_anchor?.block_id);
            if (exclusive) remove(group, row);
            else { reference(group, row, 'shared_evidence'); if (result.code !== 'ambiguous') result.code = 'shared_evidence'; }
        }
        // Existing later before/after values stay authored; deletion can expose a real conflict.
        for (const event of rows(ledger.events)) if (event.timeline_id === target.timeline_id && event.fact_id === target.fact_id) affect(event);
    } else if (collection === 'requirements' && target.kind === 'hold') {
        const otherHold = rows(ledger.requirements).some(row => row !== target && row.kind === 'hold' && typeof row.value === 'string' && row.value && row.timeline_id === target.timeline_id && row.shot_id === target.shot_id && row.fact_id === target.fact_id);
        if (!otherHold) for (const row of rows(ledger.coverage)) {
            if (row.evidence_kind === 'explicit_hold' && row.timeline_id === target.timeline_id && strings(row.fact_ids).includes(target.fact_id) && strings(row.shot_ids).includes(target.shot_id)) reference('coverage', row, 'hold_evidence_requires_requirement');
        }
        if (result.references.length) result.code = 'referenced';
    }
    if (result.code === 'missing') { result.allowed = true; result.code = 'allowed'; }
    result.affectedShotIds = [...affected];
    return result;
}

const stateValues = (fact: Row): string[] => Array.isArray(fact.allowed_values) ? fact.allowed_values.map(value => String(value)) : [];
const descriptions = (fact: Row): Row => fact.value_descriptions && typeof fact.value_descriptions === 'object' && !Array.isArray(fact.value_descriptions) ? fact.value_descriptions : {};
const missingDescription = (fact: Row) => { const current = descriptions(fact); return stateValues(fact).some(value => typeof current[value] !== 'string' || !current[value].trim()); };
/** The save contract requires a model-readable description per allowed value, and the compiler already falls back to the raw value, so a missing description defaults to the value itself. */
const completedDescriptions = (fact: Row, values: string[]): Row => {
    const completed: Row = { ...descriptions(fact) };
    for (const value of values) if (typeof completed[value] !== 'string' || !completed[value].trim()) completed[value] = value;
    return completed;
};

/** Append a state value and keep every allowed value described, so the fact stays saveable. */
export function continuityFactStateValue(fact: Row, value: string): { allowed_values: string[]; value_descriptions: Row } {
    const allowed = [...new Set([...stateValues(fact), value.trim()].filter(item => item && item !== 'unknown'))];
    return { allowed_values: allowed, value_descriptions: completedDescriptions(fact, [...new Set([...stateValues(fact), ...allowed])]) };
}

/** Complete descriptions across the ledger at the save boundary; returns the same ledger when nothing is missing. */
export function continuityLedgerFactDescriptions(ledger: Row): Row {
    const facts = Array.isArray(ledger.facts) ? ledger.facts : [];
    const needs = (fact: unknown): fact is Row => Boolean(fact && typeof fact === 'object' && missingDescription(fact as Row));
    if (!facts.some(needs)) return ledger;
    return { ...ledger, facts: facts.map(fact => needs(fact) ? { ...fact, value_descriptions: completedDescriptions(fact, stateValues(fact)) } : fact) };
}

/** Reanalyze at application time so a stale UI confirmation cannot remove new dependencies. */
export function applyContinuityDeletion(source: Row | undefined, ledger: Row, collection: ContinuityLedgerCollection, entry: Row | string): Row {
    const analysis = analyzeContinuityDeletion(source, ledger, collection, entry);
    if (!analysis.allowed) throw new Error(analysis.code);
    const next = { ...ledger };
    for (const group of collections) {
        const ids = new Set(analysis.removals.filter(row => row.collection === group).map(row => row.id));
        if (ids.size) next[group] = ledger[group].filter((row: Row) => !ids.has(continuityLedgerEntryId(group, row)));
    }
    return next;
}

/** Restore only the latest removed rows; never replace a newly authored row with the same identity. */
export function restoreContinuityDeletion(ledger: Row, removedRows: Array<{ collection: ContinuityLedgerCollection; row: Row; index?: number }>, source?: Row): Row {
    const restored = new Set<string>();
    for (const { collection, row } of removedRows) {
        if (!collections.includes(collection)) throw new Error('missing');
        const id = continuityLedgerEntryId(collection, row), identity = JSON.stringify([collection, id]);
        if (!id || restored.has(identity) || rows(ledger[collection]).some(current => continuityLedgerEntryId(collection, current) === id)) throw new Error('ambiguous');
        restored.add(identity);
    }
    const candidates = (group: ContinuityLedgerCollection) => [...rows(ledger[group]), ...removedRows.filter(item => item.collection === group).map(item => item.row)];
    const requireUnique = (group: ContinuityLedgerCollection, id: unknown) => {
        if (typeof id !== 'string' || !id || candidates(group).filter(row => row.id === id).length !== 1) throw new Error('missing');
    };
    const requireShot = (id: unknown) => {
        if (source && (typeof id !== 'string' || rows(source.shots).filter(row => row.id === id).length !== 1)) throw new Error('missing');
    };
    const samePosition = (a: Row, b: Row) => {
        if (a.shot_id !== b.shot_id || a.fact_id !== b.fact_id || a.timeline_id !== b.timeline_id) return false;
        if (Number.isInteger(a.local_frame) && Number.isInteger(b.local_frame)) return a.local_frame === b.local_frame;
        if (Number.isInteger(a.frame) && Number.isInteger(b.frame)) return a.frame === b.frame;
        const shot = rows(source?.shots).find(row => row.id === a.shot_id);
        if (!shot || !Number.isInteger(shot.start_frame)) return false;
        const position = (row: Row) => Number.isInteger(row.local_frame) ? shot.start_frame + row.local_frame : row.frame;
        return Number.isInteger(position(a)) && position(a) === position(b);
    };
    // Only restored rows are checked. Unrelated pre-existing issues remain manually repairable.
    for (const { collection, row } of removedRows) {
        if (['initial', 'events', 'requirements', 'coverage'].includes(collection)) requireUnique('timelines', row.timeline_id);
        if (['initial', 'events', 'requirements'].includes(collection)) requireUnique('facts', row.fact_id);
        if (collection === 'events' || collection === 'requirements') requireShot(row.shot_id);
        if (collection === 'requirements' || collection === 'coverage') for (const id of strings(row.event_ids)) requireUnique('events', id);
        if (collection === 'events' && candidates('events').some(other => other !== row && samePosition(row, other))) throw new Error('ambiguous');
        if (collection === 'coverage') {
            for (const id of strings(row.fact_ids)) requireUnique('facts', id);
            for (const id of strings(row.shot_ids)) requireShot(id);
            if (row.evidence_kind === 'explicit_hold') for (const factId of strings(row.fact_ids)) for (const shotId of strings(row.shot_ids)) {
                if (!candidates('requirements').some(requirement => requirement.kind === 'hold' && typeof requirement.value === 'string' && requirement.value && requirement.timeline_id === row.timeline_id && requirement.fact_id === factId && requirement.shot_id === shotId)) throw new Error('missing');
            }
            if (row.source_anchor?.block_id && candidates('coverage').some(other => other !== row && other.source_anchor?.block_id === row.source_anchor.block_id && other.evidence_kind === row.evidence_kind)) throw new Error('ambiguous');
        }
    }
    const next = { ...ledger };
    for (const group of collections) {
        const entries = removedRows.filter(item => item.collection === group);
        if (!entries.length) continue;
        const updated = [...(Array.isArray(ledger[group]) ? ledger[group] : [])];
        // An optional original index preserves display order without replacing intervening edits.
        for (const entry of entries.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))) {
            const index = entry.index !== undefined && Number.isInteger(entry.index) && entry.index >= 0 ? Math.min(entry.index, updated.length) : updated.length;
            updated.splice(index, 0, structuredClone(entry.row));
        }
        next[group] = updated;
    }
    return next;
}
