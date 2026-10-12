import assert from "node:assert/strict";
import test from "node:test";
import { isLanAuthBypassed } from "./lan-access-policy.js";

test("token bypass is enabled only for RFC1918 or link-local clients after LAN binding is enabled", () => {
    const enabled = "0.0.0.0" as const;
    const disabled = "127.0.0.1" as const;
    for (const address of ["10.0.0.5", "172.16.0.5", "172.31.255.254", "192.168.1.22", "169.254.4.3", "::ffff:192.168.1.22", "fd12:3456::5", "fe80::1"]) {
        assert.equal(isLanAuthBypassed(address, enabled), true, address);
        assert.equal(isLanAuthBypassed(address, disabled), false, address);
    }
    for (const address of [undefined, "127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "192.167.1.22", "2001:4860:4860::8888", "not-an-ip"]) {
        assert.equal(isLanAuthBypassed(address, enabled), false, String(address));
    }
});
