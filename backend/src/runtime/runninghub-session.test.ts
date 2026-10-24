import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readTokens } from "./runninghub-session.js";

/** 造一个 readTokens 认可的 JWT（header.payload.sig，exp=1999 秒）。 */
function fakeJwt(exp = 1999): string {
    const header = "eyJhbGciOiJIUzI1NiJ9";
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    const sig = "abcdefghijklmnop";
    return `${header}.${payload}.${sig}`;
}

/** localStorage 的 key 形如 `_https://www.runninghub.cn\x00\x01Rh-Accesstoken`。 */
function leveldbEntry(origin: string, token: string): Buffer {
    return Buffer.from(`_${origin}\u0000\u0001Rh-Accesstoken\u0000\u0001${token}`, "utf8");
}

describe("runninghub-session.readTokens", () => {
    it("从 localStorage key 前缀识别 .cn 站点", () => {
        const [hit] = readTokens(leveldbEntry("https://www.runninghub.cn", fakeJwt()));
        assert.equal(hit.accessToken, fakeJwt());
        assert.equal(hit.site, "cn");
    });

    it("从 localStorage key 前缀识别 .ai 站点", () => {
        const [hit] = readTokens(leveldbEntry("https://www.runninghub.ai", fakeJwt()));
        assert.equal(hit.site, "ai");
    });

    it("两个站的令牌各带各的站点标记，不会混为一谈", () => {
        const bytes = Buffer.concat([
            leveldbEntry("https://www.runninghub.ai", fakeJwt(2001)),
            Buffer.from("\u0000", "utf8"),
            leveldbEntry("https://www.runninghub.cn", fakeJwt(2002)),
        ]);
        const hits = readTokens(bytes);
        const sites = hits.map((item) => item.site).sort();
        assert.deepEqual(sites, ["ai", "cn"]);
    });
});
