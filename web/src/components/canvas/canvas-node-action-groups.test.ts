import assert from "node:assert/strict";
import test from "node:test";
import { canvasNodeDropdownActions, groupCanvasNodeActions, nearbyCanvasNodeActions } from "./canvas-node-action-groups";

const builtInIds = ["info", "delete", "saveAsset", "download", "convertToCharacter", "convertToScene", "convertToProp", "copyPrompt", "reversePrompt", "replace", "resize", "maskEdit", "crop", "split", "upscale", "superResolve", "autoLevels", "angle", "view", "compareVideo", "trimVideo", "retry", "edit", "generateImage", "config", "decreaseFont", "increaseFont", "uploadImage", "uploadVideo", "uploadAudio", "saveCharacterToAsset", "saveSceneToAsset", "arrangeGroup", "toggleOrderedGroup", "groupLock", "discardShared"];

test("every existing node action is reachable exactly once in the full menu", () => {
    const actions = builtInIds.map((id) => ({ id }));
    const groups = groupCanvasNodeActions(actions);
    assert.deepEqual(groups.flatMap((group) => group.actions.map((action) => action.id)).sort(), [...builtInIds].sort());
    assert.equal(groups.some((group) => group.id === "extensions"), false);
    assert.deepEqual(groups.at(-1)?.actions.map((action) => action.id), ["delete", "discardShared"]);
});

test("hidden quick tools stay hidden while remaining directly executable in their section", () => {
    let cropCalls = 0;
    const actions = [{ id: "view", onClick: () => undefined }, { id: "crop", onClick: () => cropCalls++ }, { id: "delete", danger: true, onClick: () => undefined }];
    assert.deepEqual(nearbyCanvasNodeActions(actions, new Set(["view"])).map((action) => action.id), ["view"]);
    const crop = groupCanvasNodeActions(actions).find((group) => group.id === "edit")?.actions[0];
    crop?.onClick();
    assert.equal(cropCalls, 1);
    assert.equal(crop, actions[1]);
    assert.deepEqual(nearbyCanvasNodeActions(actions, new Set()), []);
});

test("production toolbar More keeps Save to Asset Library even when it is not a quick tool", () => {
    const all = [{ id: "info" }, { id: "saveAsset" }, { id: "delete", danger: true }];
    const more = [{ id: "delete", danger: true }];
    assert.deepEqual(canvasNodeDropdownActions(all, more, true).map(action => action.id), ["info", "saveAsset", "delete"]);
    assert.deepEqual(canvasNodeDropdownActions(all, more, false).map(action => action.id), ["delete"]);
});

test("registered plugin actions preserve callbacks and state without recognizing a node type", () => {
    let calls = 0;
    const pluginAction = { id: "voice-plugin:normalize", active: true, disabled: true, loading: true, onClick: () => calls++ };
    const groups = groupCanvasNodeActions([{ id: "info" }, pluginAction]);
    assert.equal(groups.at(-1)?.id, "extensions");
    assert.equal(groups.at(-1)?.actions[0], pluginAction);
    assert.equal(nearbyCanvasNodeActions([pluginAction])[0], pluginAction);
    pluginAction.onClick();
    assert.equal(calls, 1);
    const updated = { ...pluginAction, disabled: false };
    assert.equal(groupCanvasNodeActions([updated])[0].actions[0].disabled, false);
});

test("dangerous plugin actions are isolated even when their identifiers are unknown", () => {
    const dangerous = { id: "custom:clear", danger: true };
    assert.equal(groupCanvasNodeActions([dangerous])[0].id, "danger");
    assert.deepEqual(nearbyCanvasNodeActions([dangerous]), []);
});

test("image customization keeps its existing order and can explicitly pin dangerous tools", () => {
    const actions = [{ id: "delete", danger: true }, { id: "info" }, { id: "crop" }];
    assert.deepEqual(nearbyCanvasNodeActions(actions, new Set(["crop", "delete"])), [actions[0], actions[2]]);
    assert.deepEqual(actions.map((action) => action.id), ["delete", "info", "crop"]);
});
