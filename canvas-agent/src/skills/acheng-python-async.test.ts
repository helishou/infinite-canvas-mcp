import assert from "node:assert/strict";
import test from "node:test";
import { resolveAchengPythonAsync, runAchengPythonAsync } from "./acheng.js";

test("Acheng Python async resolver and runner do not block the event loop", async () => {
    const python = await resolveAchengPythonAsync();
    assert.ok(python);
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 5);
    try {
        const output = await runAchengPythonAsync(["-c", "import time; time.sleep(0.15); print('async-ok')"], { windowsHide: true, encoding: "utf8" });
        assert.equal(output.trim(), "async-ok");
        assert.ok(heartbeats >= 5, `event-loop heartbeat ran only ${heartbeats} times during the child process`);
    } finally { clearInterval(timer); }
});

test("Acheng Python async runner forwards stdin and preserves non-zero exits", async () => {
    const output = await runAchengPythonAsync(["-c", "import sys; print(sys.stdin.read())"], { windowsHide: true, encoding: "utf8", input: "stdin-ok" });
    assert.equal(output.trim(), "stdin-ok");
    await assert.rejects(
        runAchengPythonAsync(["-c", "import sys; print('failed', file=sys.stderr); raise SystemExit(7)"], { windowsHide: true, encoding: "utf8" }),
        (error: any) => error.code === 7 && String(error.stderr).includes("failed"),
    );
});
