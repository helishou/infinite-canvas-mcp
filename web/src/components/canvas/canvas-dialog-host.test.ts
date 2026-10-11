import assert from "node:assert/strict";
import test from "node:test";
import { createElement, lazy } from "react";
import { renderToString } from "react-dom/server";
import { CanvasDialogHost } from "./canvas-dialog-host";

test("a pending lazy dialog does not suspend its sibling dialog", () => {
    const PendingDialog = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    const markup = renderToString(createElement(
        CanvasDialogHost,
        null,
        createElement(PendingDialog),
        createElement("div", null, "sibling dialog remains visible"),
    ));

    assert.match(markup, /sibling dialog remains visible/);
});
