import assert from "node:assert/strict";
import test from "node:test";
import { focusProductionSection } from "./production-section-navigation";

test("section shortcuts scope to the nearest workspace and focus after scrolling", () => {
    const calls: unknown[] = [];
    const section = {
        scrollIntoView: (options: unknown) => calls.push(["scroll", options]),
        focus: (options: unknown) => calls.push(["focus", options]),
    };
    const root = {
        querySelector: (selector: string) => { calls.push(["target", selector]); return section; },
    };
    const control = {
        closest: (selector: string) => { calls.push(["scope", selector]); return root as unknown as Element; },
    };
    focusProductionSection(control, "delivery");
    assert.deepEqual(calls, [
        ["scope", "[data-production-section-root]"],
        ["target", '[data-production-section="delivery"]'],
        ["scroll", { block: "start" }],
        ["focus", { preventScroll: true }],
    ]);
});

test("unmounted or unavailable sections leave navigation and editing state alone", () => {
    assert.doesNotThrow(() => focusProductionSection({ closest: () => null }, "delivery"));
    assert.doesNotThrow(() => focusProductionSection({ closest: () => ({ querySelector: () => null }) as unknown as Element }, "compiler"));
});

test("standalone section links scroll only workspace content and keep the shared header fixed", () => {
    const calls: unknown[] = [];
    const content = { scrollTop: 50, getBoundingClientRect: () => ({ top: 100 }) };
    const section = { closest: () => content, getBoundingClientRect: () => ({ top: 420 }), scrollIntoView: () => calls.push("outer scroll"), focus: (options: unknown) => calls.push(options) };
    focusProductionSection({ closest: () => ({ querySelector: () => section }) as unknown as Element }, "history");
    assert.equal(content.scrollTop, 370);
    assert.deepEqual(calls, [{ preventScroll: true }]);
});

test("embedded section links preserve Inspector scrolling even when a content marker exists", () => {
    const calls: unknown[] = [];
    const content = { scrollTop: 50 };
    const section = { closest: (selector: string) => selector === "[data-production-workspace-content]" ? content : null, scrollIntoView: (options: unknown) => calls.push(options), focus: (options: unknown) => calls.push(options) };
    focusProductionSection({ closest: () => ({ querySelector: () => section }) as unknown as Element }, "history");
    assert.equal(content.scrollTop, 50);
    assert.deepEqual(calls, [{ block: "start" }, { preventScroll: true }]);
});


test("section links expand collapsed preparation controls before scrolling", () => {
    const calls: unknown[] = [];
    const section = { tagName: "DETAILS", open: false, scrollIntoView: () => calls.push(section.open), focus: () => calls.push("focus") };
    focusProductionSection({ closest: () => ({ querySelector: () => section }) as unknown as Element }, "checks");
    assert.equal(section.open, true);
    assert.deepEqual(calls, [true, "focus"]);
});
