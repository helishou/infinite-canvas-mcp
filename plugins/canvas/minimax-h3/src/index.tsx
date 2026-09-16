import { definePlugin } from "@infinite-canvas/plugin-sdk";
import { h3PluginManifest } from "./manifest";
import { h3NodeDefinition } from "./node-definition";
import h3Css from "./styles/h3.css";

export default definePlugin({
    ...h3PluginManifest,
    css: h3Css,
    nodes: [h3NodeDefinition],
});
