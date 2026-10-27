import assert from "node:assert/strict";
import test from "node:test";
import { effectiveClientAddress, isLanAuthBypassed } from "./lan-access-policy.js";

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

test("only a loopback dev proxy may supply the client address used by the LAN bypass", () => {
    const remote = "127.0.0.1";
    const forwarded = "192.168.1.44";
    assert.equal(effectiveClientAddress(remote, forwarded, true), forwarded);
    assert.equal(isLanAuthBypassed(effectiveClientAddress(remote, forwarded, true), "0.0.0.0"), true);
    assert.equal(effectiveClientAddress(remote, forwarded, false), remote);
    assert.equal(effectiveClientAddress("8.8.8.8", forwarded, true), "8.8.8.8");
    assert.equal(effectiveClientAddress(remote, "not-an-ip", true), remote);
});
