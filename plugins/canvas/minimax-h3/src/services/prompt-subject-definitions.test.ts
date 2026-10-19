import assert from "node:assert/strict";
import test from "node:test";

import { bindLiteralSubjectsToReferences, literalPromptSubjects } from "./prompt-subject-definitions.ts";

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

test("正式提示词的主体标签按定义名称显示，图片序号不决定主体身份", () => {
    const subjects = literalPromptSubjects(`subject_definitions:
<Subject 1> is 沈砚; appearance follows the reference images exclusively, represented by <Picture 2>.
<Subject 2> is 红绡; appearance follows the reference images exclusively, represented by <Picture 3>.
<Subject 3> is 草庐室内, represented by <Picture 1>.

summary:
...`);
    const definitions = bindLiteralSubjectsToReferences(subjects);
    assert.deepEqual(definitions.map(({ id, name, pictures, role }) => ({ id, name, pictures, role })), [
        { id: "prompt-subject-1", name: "沈砚", pictures: [], role: "character_identity" },
        { id: "prompt-subject-2", name: "红绡", pictures: [], role: "character_identity" },
        { id: "prompt-subject-3", name: "草庐室内", pictures: [], role: undefined },
    ]);
});
