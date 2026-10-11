export function shouldProxyLocalModelList(baseUrl: string, apiFormat: string): boolean {
    if (apiFormat === "gemini") return false;
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase();
        if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
        const octets = hostname.split(".").map(Number);
        return octets.length === 4 && octets[0] === 127 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
    } catch {
        return false;
    }
}
