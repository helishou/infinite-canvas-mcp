import { useState } from 'react';
import { Button, Checkbox } from 'antd';
import { useTranslation } from 'react-i18next';

export function ProductionInputDiff({ current, projection, busy, onAdopt }: {
    current: Record<string, any>; projection?: Record<string, any>; busy: boolean; onAdopt: (fields: string[]) => Promise<boolean>;
}) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    const next = projection?.nextValues || {};
    const changed = Object.keys(next).filter(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(next[key] ?? null));
    const conflicts = changed.filter(key => projection?.conflicts?.includes(key));
    if (!changed.length && !current.inputOutdated) return null;
    return <div className="mt-3 space-y-2 text-xs text-muted-foreground" data-production-input-diff>
        <p>{changed.length > 0 && t('director.workspace.manualInput')} {conflicts.length > 0 && ` · ${t('director.workspace.directorUpdate')}`} {current.inputOutdated && ` · ${t('director.workspace.inputChanged')}`}</p>
        {changed.length > 0 && <details><summary className="cursor-pointer">{t('director.workspace.compareInputs')}</summary>
            <div className="mt-2 space-y-3">{changed.map(field => <div key={field}>
                <Checkbox checked={selected.includes(field)} onChange={event => setSelected(previous => event.target.checked ? [...previous, field] : previous.filter(value => value !== field))}>{t(`director.workspace.inputFieldNames.${field}`, { defaultValue: field })}</Checkbox>
                <div className="grid gap-2 sm:grid-cols-2">
                    <div><p>{t('director.workspace.savedInput')}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{typeof current[field] === 'string' ? current[field] : JSON.stringify(current[field], null, 2)}</pre></div>
                    <div><p>{t('director.workspace.directorInput')}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{typeof next[field] === 'string' ? next[field] : JSON.stringify(next[field], null, 2)}</pre></div>
                </div>
            </div>)}
                <p>{t('director.workspace.adoptRelatedFields')}</p>
                <Button size="small" disabled={busy || !selected.some(field => changed.includes(field))} onClick={async () => { if (await onAdopt(selected.filter(field => changed.includes(field)))) setSelected([]); }}>{t('director.workspace.adoptDirectorFields')}</Button>
            </div>
        </details>}
    </div>;
}
