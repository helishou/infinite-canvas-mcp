import { continuitySecondLabel } from './continuity-workbench-interaction';
import { Input, Select } from 'antd';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { continuityPresentation } from './continuity-presentation';
type Row = Record<string, any>;
export function ContinuityEventFields({ value, onChange, onAddValue, shot, fact, blocks, display, fps, disabled, compact = false }: { value: { frame: string; after: string; reason: string; sourceBlockId: string }; onChange: (patch: Partial<typeof value>) => void; onAddValue?: (value: string) => void; shot: Row; fact: Row; blocks: Row[]; display: ReturnType<typeof continuityPresentation>; fps: number; disabled: boolean; compact?: boolean }) {
 const { t } = useTranslation(); const label = (key: string, values?: Record<string, unknown>) => t(`director.workspace.continuity.subjectTimeline.${key}`, values);
 const last = Number(shot.duration_frames) - 1, frame = value.frame.trim() ? Number(value.frame) : NaN;
 const valid = Number.isInteger(frame) && frame >= 0 && frame <= last;
 const block = blocks.find(row => row.id === value.sourceBlockId);
 const when = valid ? label('timeAt', { seconds: continuitySecondLabel(frame, fps), frame, duration: last + 1 }) : label('invalidPosition');
 // Evidence reads as a short pick; the full passage is quoted below it.
 const evidenceLabel = (row: Row) => { const text = String(row.sourceBlock?.text || '').trim(); return text.length > 24 ? `${text.slice(0, 24)}…` : text || display.source(String(row.id)); };
 // The state picker accepts typed input: an unseen name is offered as a new state
 // value, which joins the fact enum or the ledger validator rejects the event.
 const [search, setSearch] = useState("");
 const typed = search.trim();
 const addable = Boolean(onAddValue) && Boolean(typed) && typed !== "unknown" && !(fact.allowed_values || []).includes(typed);
 return <>
  <label className="continuity-field"><span>{t('director.workspace.continuity.afterChange')} *</span><Select showSearch searchValue={search} onSearch={setSearch} onOpenChange={open => { if (!open) setSearch(""); }} aria-label={t('director.workspace.continuity.afterChange')} disabled={disabled} value={value.after || undefined} placeholder={label('chooseAfter')} options={[...new Set<string>([...(fact.allowed_values || []), 'unknown'])].map(item => ({ value: item, label: display.value(fact.id, item) }))} filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.trim().toLowerCase())} notFoundContent={addable ? <button type="button" className="continuity-add-value-option" data-continuity-add-value-option disabled={disabled} onClick={() => { onAddValue?.(typed); setSearch(""); }}><Plus size={12} />{label('addStateValueOption', { value: typed })}</button> : undefined} onChange={after => onChange({ after })} /></label>
  <label className="continuity-field"><span>{label('changePosition')}</span><input data-continuity-frame-slider type="range" min={0} max={last} step={1} disabled={disabled} aria-label={label('changePosition')} value={valid ? frame : 0} onChange={event => onChange({ frame: event.target.value })} /><span className="continuity-time-readout"><strong>{when}</strong><span className="flex justify-between text-xs"><span>{label('shotStart')}</span><span>{label('shotMiddle')}</span><span>{label('shotEnd')}</span></span></span></label>
  <details className="mb-3 text-xs" open={!valid || undefined}><summary>{label('preciseFrame')}</summary><Input className="mt-2" type="number" min={0} max={last} step={1} disabled={disabled} aria-label={t('director.atomic.localEventFrame')} value={value.frame} onChange={event => onChange({ frame: event.target.value })} />{!valid && <p role="alert" className="continuity-local-warning">{label('frameRange', { last })}</p>}</details>
  <label className="continuity-field"><span>{t('director.workspace.continuity.eventReason')} · {label('optional')}</span><Input.TextArea disabled={disabled} aria-label={t('director.workspace.continuity.eventReason')} placeholder={label('reasonPlaceholder')} value={value.reason} onChange={event => onChange({ reason: event.target.value })} autoSize={{ minRows: 2, maxRows: 4 }} /><small>{label('reasonHint')}</small></label>
  <label className="continuity-field"><span>{t('director.workspace.continuity.scriptEvidence')} · {label('optional')}</span><Select allowClear showSearch optionFilterProp="label" disabled={disabled} aria-label={t('director.workspace.continuity.scriptEvidence')} placeholder={label('chooseEvidence')} value={value.sourceBlockId || undefined} options={blocks.map(row => ({ value: String(row.id), label: evidenceLabel(row) }))} onChange={sourceBlockId => onChange({ sourceBlockId: sourceBlockId || '' })} /></label>
  {block ? compact ? <details className="mb-2 text-xs"><summary>{label('evidenceFull')}</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{String(block.sourceBlock?.text || '')}</p></details> : <blockquote className="continuity-evidence-quote"><span>{label('evidenceQuote')}</span>{String(block.sourceBlock?.text || '')}</blockquote> : !blocks.length && <p className="text-xs text-muted-foreground">{label('noEvidence')}</p>}
 </>;
}
