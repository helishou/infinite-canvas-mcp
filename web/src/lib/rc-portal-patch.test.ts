import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function installedPortalSource() {
    const entry = fileURLToPath(import.meta.resolve("@rc-component/portal"));
    return readFileSync(new URL("./Portal.js", new URL(`file:///${entry.replace(/\\/g, "/")}`)), "utf8");
}

test("rc-component Portal only rechecks its container when getContainer changes", () => {
    const source = installedPortalSource();
    assert.match(
        source,
        /setInnerContainer[\s\S]*?\}, \[getContainer\]\);/,
        "Portal's container effect has no dependency array and can overflow React's update depth during high-frequency canvas renders",
    );
});
