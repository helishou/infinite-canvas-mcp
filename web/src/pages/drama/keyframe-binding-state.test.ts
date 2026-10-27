import assert from "node:assert/strict";
import test from "node:test";
import { keyframeBindingState } from "./keyframe-binding-state";

test("keyframe picker is available only for an already registered keyframe asset", () => {
    assert.equal(keyframeBindingState(undefined, undefined, undefined, ["image-1"]).registered, false);
    assert.equal(keyframeBindingState("KF:shot-1", undefined, undefined, ["image-1"]).registered, true);
});

test("keyframe binding distinguishes valid, missing-media, and unavailable canvas nodes", () => {
    assert.deepEqual(keyframeBindingState("KF:shot-1", "image-1", undefined, ["image-1"]), {
        registered: true, hasMedia: false, selectedNodeId: "image-1", unavailableNode: false,
    });
    assert.deepEqual(keyframeBindingState("KF:shot-1", "text-1", "media/keyframe.png", ["image-1"]), {
        registered: true, hasMedia: true, selectedNodeId: undefined, unavailableNode: true,
    });
    assert.deepEqual(keyframeBindingState("KF:shot-1", "image-1", "media/keyframe.png", ["image-1"]), {
        registered: true, hasMedia: true, selectedNodeId: "image-1", unavailableNode: false,
    });
});
