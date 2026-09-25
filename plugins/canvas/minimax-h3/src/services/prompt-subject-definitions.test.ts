import assert from "node:assert/strict";
import test from "node:test";

import { literalPromptSubjects } from "./prompt-subject-definitions.ts";

test("识别 Ref2VA 正文中已定义的非人物 Subject", () => {
    const prompt = `subject_definitions:\n<Picture 1> is the first frame.\n<Subject 1> is the red-stitched marriage booklet in <Picture 1>.\n<Subject 2> is the snow courtyard.\n\nsummary:\n<Subject 1> appears again; <Subject 3> has no definition.`;
    assert.deepEqual(literalPromptSubjects(prompt), [
        { ordinal: 1, description: "is the red-stitched marriage booklet in <Picture 1>.", pictureOrdinal: 1 },
        { ordinal: 2, description: "is the snow courtyard." },
    ]);
});

test("不把正文引用或未完成定义当作有效 Subject", () => {
    assert.deepEqual(literalPromptSubjects("summary:\n<Subject 1> is referenced."), []);
    assert.deepEqual(literalPromptSubjects("subject_definitions:\n<Subject 1>\n\nsummary:\n<Subject 1> appears."), []);
});
