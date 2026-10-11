import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "./db.js";

test("historical workflow field IDs resolve to a unique renamed field definition", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-workflow-labels-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite"));
    try {
        db.upsertWorkflowConfig("custom/2.1文生图.json", {
            fieldsJson: JSON.stringify([
                { id: "f_old", node: "25", input: "template", name: "Template", type: "dropdown" },
            ]),
        });
        db.upsertWorkflowConfig("custom/image-edit.json", {
            fieldsJson: JSON.stringify([
                { id: "f_current", node: "11", input: "template", name: "Style", type: "dropdown" },
            ]),
        });

        const result = db.getWorkflowFieldDefinitionsByIds(["f_old", "f_missing"]);
        assert.deepEqual(result.map(({ workflowName, field }) => ({
            workflowName,
            id: field.id,
            name: field.name,
            input: field.input,
        })), [{
            workflowName: "custom/2.1文生图.json",
            id: "f_old",
            name: "Template",
            input: "template",
        }]);

        db.upsertWorkflowConfig("custom/conflict.json", {
            fieldsJson: JSON.stringify([
                { id: "f_conflict", node: "1", input: "style", name: "First name", type: "text" },
            ]),
        });
        db.upsertWorkflowConfig("custom/conflict-copy.json", {
            fieldsJson: JSON.stringify([
                { id: "f_conflict", node: "2", input: "style", name: "Other name", type: "text" },
            ]),
        });
        assert.deepEqual(db.getWorkflowFieldDefinitionsByIds(["f_conflict"]), []);
    } finally {
        db.close();
    }
});
