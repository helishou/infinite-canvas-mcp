import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveConfig } from "vite";

const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hostProvider = fileURLToPath(new URL("../../components/layout/app-providers.tsx", import.meta.url));
const h3Settings = fileURLToPath(new URL("../../../../plugins/canvas/minimax-h3/src/components/ClipSettings.tsx", import.meta.url));

for (const command of ["serve", "build"] as const) {
    test(`${command}: built-in H3 shares the host antd theme and popup context`, async () => {
        const config = await resolveConfig({ root: webRoot }, command);
        const resolve = config.createResolver();
        for (const specifier of ["antd", "antd/es/config-provider/context", "antd/es/theme/context"]) {
            const hostModule = await resolve(specifier, hostProvider);
            const h3Module = await resolve(specifier, h3Settings);
            assert.ok(hostModule, `host must resolve ${specifier}`);
            assert.equal(h3Module, hostModule, `H3 must share ${specifier} with AppProviders`);
        }
    });
}
