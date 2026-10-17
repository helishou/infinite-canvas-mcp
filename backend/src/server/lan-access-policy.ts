import { isIP } from "node:net";

function isTrustedPrivateAddress(value: string | undefined): boolean {
    if (!value) return false;
    const address = value.trim().toLowerCase().split("%", 1)[0];
    if (address.startsWith("::ffff:")) {
        const mapped = address.slice("::ffff:".length);
        if (isIP(mapped) === 4) return isTrustedPrivateAddress(mapped);
    }
    if (isIP(address) === 4) {
        const octets = address.split(".").map(Number);
        const [a, b] = octets;
        return a === 10
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254);
    }
    if (isIP(address) === 6) {
        if (address === "::" || address === "::1") return false;
        if (/^f[cd]/.test(address)) return true; // fc00::/7 unique-local
        const firstHextet = Number.parseInt(address.split(":", 1)[0] || "0", 16);
        return firstHextet >= 0xfe80 && firstHextet <= 0xfebf; // fe80::/10 link-local
    }
    return false;
}

function isLoopbackAddress(value: string | undefined): boolean {
    if (!value) return false;
    const address = value.trim().toLowerCase().split("%", 1)[0];
    if (address === "::1") return true;
    if (address.startsWith("::ffff:")) return isLoopbackAddress(address.slice("::ffff:".length));
    if (isIP(address) !== 4) return false;
    return Number(address.split(".", 1)[0]) === 127;
}

/** Trust X-Forwarded-For only from the loopback-only development proxy. */
export function effectiveClientAddress(
    remoteAddress: string | undefined,
    forwardedFor: string | string[] | undefined,
    trustLocalProxy: boolean,
): string | undefined {
    if (!trustLocalProxy || !isLoopbackAddress(remoteAddress)) return remoteAddress;
    const forwarded = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor || "";
    const candidate = forwarded.split(",", 1)[0].trim().split("%", 1)[0];
    return isIP(candidate) ? candidate : remoteAddress;
}

/** No-token access is limited to private/link-local peers while LAN binding is explicitly enabled. */
export function isLanAuthBypassed(remoteAddress: string | undefined, listenHost: string | undefined): boolean {
    return listenHost === "0.0.0.0" && isTrustedPrivateAddress(remoteAddress);
}
