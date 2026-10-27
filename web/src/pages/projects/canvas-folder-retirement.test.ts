import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { matchesProjectQuery } from "./directory-data";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function initializer(name: string) {
    let value = "";
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) value = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(value, `${name} exists`);
    return value;
}

test("canvas directory search and displayed counts include every former folder", () => {
    const visible = new Function("ordinaryProjects", "searchQuery", "matchesProjectQuery", `return (${initializer("visibleProjects")})`);
    const projects = [
        { id: "root", title: "Root canvas" },
        { id: "nested", title: "Nested CANVAS", folderId: "old/nested" },
        { id: "orphan", title: "Orphan canvas", folderId: "missing" },
    ];
    assert.deepEqual(visible(projects, "", matchesProjectQuery), projects);
    assert.equal(visible(projects, "  canvas  ", matchesProjectQuery).length, 3);
    assert.deepEqual(visible(projects, "orphan", matchesProjectQuery), [projects[2]]);
    assert.deepEqual(visible(projects, "no match", matchesProjectQuery), []);
    assert.match(source, /data-testid="canvas-directory-count"[\s\S]{0,40}\{!hydrated \|\| !ownershipReady \? "—" : visibleProjects\.length\}/);
    assert.match(source, /ownershipUnavailable/);
    assert.match(source, /ownershipDescription/);
});

test("desktop, mobile, selection and card surfaces expose no ordinary folder actions", () => {
    const card = readFileSync(new URL("../../components/canvas/canvas-project-card.tsx", import.meta.url), "utf8");
    for (const surface of [source, card]) {
        assert.doesNotMatch(surface, /canvas\.folder\.|canvas\.project\.moveFolder|folderFilter|folderName|createFolder|renameFolder|deleteFolder|moveProjectsToFolder|FolderInput|FolderPlus/);
    }
    assert.match(source, /exportCanvasProjects\(ordinaryProjects.filter/);
    assert.match(source, /setDeleteIds\(selectedIds\)/);
    for (const action of ["export", "rename", "delete"]) assert.ok(card.includes(`canvas.project.${action}`));
    assert.match(source, /replaceFolders\(\[\.\.\.foldersById.values\(\)\]\)/, "legacy archive metadata remains backward-readable");
});

test("Home uses actual drama ownership while retaining pins, recents and stable canvas routes", () => {
    const home = readFileSync(new URL("../home/index.tsx", import.meta.url), "utf8");
    const data = readFileSync(new URL("../home/use-workbench-data.ts", import.meta.url), "utf8");
    assert.match(home, /const folderFor = \(p: CanvasProject\) => data.canvasOwners.get\(p.id\)/);
    assert.match(home, /const isDrama = \(p: CanvasProject\) => data.canvasOwners.has\(p.id\)/);
    assert.doesNotMatch(home, /p\.folderId/);
    assert.match(data, /dramaCanvasOwners\(folders, episodesByDrama\)/);
    assert.match(home, /homePinnedProject:\$\{entry.id\}/);
    assert.match(data, /homePinnedProject:\$\{projectId\}/);
    assert.match(home, /const latest = sorted\[0\]/);
    assert.match(home, /openDestination\(`\/canvas\/\$\{encodeURIComponent\(id\)}`\)/);
});
