import assert from "node:assert/strict";
import test from "node:test";

import { isModuleViewed, isTrackedPath } from "./local-analytics";

const viewport = { width: 1440, height: 900 };
const entry = (isIntersecting: boolean, intersectionRatio: number, width: number, height: number) => ({
    isIntersecting,
    intersectionRatio,
    intersectionRect: { width, height },
});

test("a module mostly on screen counts as viewed", () => {
    assert.equal(isModuleViewed(entry(true, 0.6, 400, 300), viewport), true);
    assert.equal(isModuleViewed(entry(true, 1, 1440, 900), viewport), true);
});

test("a tall page-sized container is viewed once it fills a quarter of the viewport", () => {
    // 3493px main inside a 900px window: the ratio can never approach 25%, but it covers the screen.
    assert.equal(isModuleViewed(entry(true, 0.25, 1440, 870), viewport), true);
    assert.equal(isModuleViewed(entry(true, 0.7, 1440, 900), viewport), true);
});

test("a sliver at the viewport edge does not count", () => {
    assert.equal(isModuleViewed(entry(true, 0.02, 1440, 20), viewport), false);
    assert.equal(isModuleViewed(entry(true, 0.24, 400, 30), viewport), false);
});

test("an off-screen module never counts, even when it was sized above the viewport", () => {
    assert.equal(isModuleViewed(entry(false, 0, 1440, 900), viewport), false);
    assert.equal(isModuleViewed(entry(false, 0, 0, 0), viewport), false);
});

test("the report page does not record itself, other paths keep tracking", () => {
    assert.equal(isTrackedPath("/analytics/local"), false);
    assert.equal(isTrackedPath("/analytics/local?tab=modules"), false);
    assert.equal(isTrackedPath("/"), true);
    assert.equal(isTrackedPath("/canvas/CQHFYYKku76yKKlUfVQB9"), true);
});
