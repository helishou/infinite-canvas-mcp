import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(packageRoot, "..", ".agents", "skills", "canvas-video-production-sop");
const target = path.join(packageRoot, "dist", "bundled-skills", "canvas-video-production-sop");
const packageReal = fs.realpathSync(packageRoot);
const insidePackage = (candidate) => {
    const relative = path.relative(packageReal, fs.realpathSync(candidate));
    return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

if (!fs.existsSync(path.join(source, "SKILL.md"))) throw new Error(`Missing production SOP: ${source}`);
const existingParent = fs.existsSync(path.dirname(target)) ? path.dirname(target) : path.dirname(path.dirname(target));
if (!insidePackage(existingParent) || (fs.existsSync(target) && !insidePackage(target))) throw new Error("Bundled skill target escaped the package workspace");
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true, dereference: false });
fs.mkdirSync(path.join(packageRoot, "dist", "skills"), { recursive: true });
fs.copyFileSync(path.join(packageRoot, "src", "skills", "compile-preflight.py"), path.join(packageRoot, "dist", "skills", "compile-preflight.py"));
