import { h3NodeDefinition } from "./node-definition";

// Host entry for Vite development. CSS is imported by the host as a normal stylesheet;
// unlike the bundled plugin entry, it must not import the stylesheet as a string.
export const h3SystemDefinition = h3NodeDefinition;
