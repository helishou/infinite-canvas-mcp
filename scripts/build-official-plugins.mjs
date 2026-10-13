import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Build the official plugin registry and bundles into the Web assets directory.
await import('../plugins/canvas/registry/build.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'plugins', 'canvas', 'registry', 'dist');
const target = path.join(root, 'web', 'public', 'plugins');
await mkdir(target, { recursive: true });

// 覆盖式拷贝不会清理目标目录：插件从官方清单移除后，旧 bundle 会一直留在 web/public/plugins
// 并继续被前端当成可选插件。这里只清理「上一份清单里是官方插件、这一份里不是」的产物，
// 不动插件作者经 VITE_DEV_PLUGINS 自行构建到该目录的文件。
async function officialEntries(manifestPath) {
    try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        return new Set((manifest.plugins ?? []).map((plugin) => plugin.entry).filter(Boolean));
    } catch {
        return new Set();
    }
}

const previous = await officialEntries(path.join(target, 'official-plugins.json'));
const current = await officialEntries(path.join(source, 'official-plugins.json'));
for (const entry of previous) {
    if (current.has(entry)) continue;
    await rm(path.join(target, entry), { force: true });
    console.log(`[plugins] removed stale bundle ${entry}`);
}

await cp(source, target, { recursive: true });
