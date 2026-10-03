import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Build the official plugin registry and bundles into the Web assets directory.
await import('../plugins/canvas/registry/build.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'web', 'public', 'plugins');
await mkdir(target, { recursive: true });
await cp(path.join(root, 'plugins', 'canvas', 'registry', 'dist'), target, { recursive: true });
