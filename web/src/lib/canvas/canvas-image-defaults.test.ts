import assert from "node:assert/strict";
import test from "node:test";

import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";

test("new image nodes use the latest image settings while saved node settings take priority", () => {
    const original = useConfigStore.getState().config;
    try {
        useConfigStore.getState().replaceConfig({
            ...defaultConfig,
            channels: [{
                ...defaultConfig.channels[0],
                models: [...defaultConfig.channels[0].models, { name: "another-image", capability: "image" }],
            }],
        });
        const store = useConfigStore.getState();
        store.updateConfig("imageModel", "default::another-image");
        store.updateConfig("quality", "high");
        store.updateConfig("size", "1152x2048");
        store.updateConfig("count", "2");
        store.updateConfig("background", "transparent");
        store.updateConfig("imageAlign16", false);

        const config = useConfigStore.getState().config;
        const nextNode = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 });
        const nextGeneration = buildGenerationConfig(config, nextNode, "image");
        assert.equal(nextGeneration.model, "default::another-image");
        assert.equal(nextGeneration.quality, "high");
        assert.equal(nextGeneration.size, "1152x2048");
        assert.equal(nextGeneration.count, "2");
        assert.equal(nextGeneration.background, "transparent");
        assert.equal(nextGeneration.imageAlign16, false);

        const savedNode = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, {
            model: "default::gpt-image-2", quality: "low", size: "1024x1024", count: 1, background: "",
        });
        const savedGeneration = buildGenerationConfig(config, savedNode, "image");
        assert.equal(savedGeneration.model, "default::gpt-image-2");
        assert.equal(savedGeneration.quality, "low");
        assert.equal(savedGeneration.size, "1024x1024");
        assert.equal(savedGeneration.count, "1");
        assert.equal(savedGeneration.background, "");
    } finally {
        useConfigStore.setState({ config: original });
    }
});
