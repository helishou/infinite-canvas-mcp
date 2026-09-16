import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoots = [
    join(root, "web", "node_modules", "@rc-component", "portal"),
    join(root, "node_modules", "@rc-component", "portal"),
];
const sourceFiles = packageRoots.flatMap((packageRoot) => [join(packageRoot, "es", "Portal.js"), join(packageRoot, "lib", "Portal.js")]);
const viteDeps = join(root, "web", "node_modules", ".vite", "deps");
const files = [...sourceFiles];

if (existsSync(viteDeps)) {
    const { readdirSync } = await import("node:fs");
    files.push(...readdirSync(viteDeps).filter((name) => /^chunk-.*\.js$/.test(name)).map((name) => join(viteDeps, name)));
}

const startMarker = "const [innerContainer, setInnerContainer]";
const endMarker = "const [defaultContainer";
let found = 0;
let patched = 0;

for (const file of files) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    const start = source.indexOf(startMarker);
    if (start < 0) continue;
    const end = source.indexOf(endMarker, start);
    if (end < 0) throw new Error(`Cannot find rc-component Portal container effect end in ${file}`);
    found += 1;
    const block = source.slice(start, end);
    if (/\}, \[getContainer\]\);\s*$/.test(block)) continue;
    const close = block.lastIndexOf("});");
    if (close < 0) throw new Error(`Cannot find rc-component Portal container effect close in ${file}`);
    const nextBlock = `${block.slice(0, close)}}), [getContainer]);${block.slice(close + 3)}`;
    writeFileSync(file, `${source.slice(0, start)}${nextBlock}${source.slice(end)}`);
    patched += 1;
}

if (!found) throw new Error("@rc-component/portal is not installed; cannot apply the React update-depth patch");
console.log(`rc-component Portal patch: ${patched} patched, ${found - patched} already current`);
