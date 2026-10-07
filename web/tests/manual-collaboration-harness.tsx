import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider, theme, Button } from 'antd';
import { ProductionInputDiff } from '../src/pages/drama/production-input-diff';
import i18n from '../src/i18n';
import '../src/styles/globals.css';

const original = { prompt: '我的对白、动作与镜头描述。', title: '人工标题', duration: 6, referenceBindings: [{ id: 'my-reference' }], storyboardShots: [{ id: 'my-shot' }], inputOutdated: true };
const nextValues = { prompt: '导演的新对白、动作与镜头描述。', title: '导演标题', duration: 5, referenceBindings: [{ id: 'director-reference' }], storyboardShots: [{ id: 'director-shot' }] };
const groups = [['prompt'], ['title'], ['referenceBindings', 'storyboardShots', 'duration']];
const writes: string[][] = [];
function Harness() {
    const [current, setCurrent] = useState(original);
    const [dark, setDark] = useState(false);
    const [busy, setBusy] = useState(false);
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App>
        <main className={dark ? 'dark' : ''} style={{ padding: 24, maxWidth: 1000 }}>
            <Button onClick={() => setDark(value => !value)}>Theme</Button>
            <Button onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en-US' : 'zh-CN')}>Language</Button>
            <Button onClick={() => setBusy(value => !value)}>Saving</Button>
            <ProductionInputDiff current={current} busy={busy} projection={{ nextValues, fieldGroups: groups, conflicts: ['prompt', 'duration'] }}
                onAdopt={async fields => { writes.push(fields); const related = groups.filter(group => group.some(field => fields.includes(field))).flat(); setCurrent(value => ({ ...value, ...Object.fromEntries(related.map(field => [field, nextValues[field as keyof typeof nextValues]])) })); return true; }} />
            <pre aria-label="evidence">{JSON.stringify({ current, writes })}</pre>
        </main>
    </App></ConfigProvider>;
}
void i18n.changeLanguage('zh-CN').then(() => createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>));
