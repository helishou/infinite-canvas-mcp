/**
 * Shared backend token state.
 *
 * Avoids circular import between backend-api.ts (imported by use-backend-store.ts)
 * and use-backend-store.ts. Token is written by setBackendToken() and read by
 * getBackendTokenShared(). The authoritative source of truth is always the
 * Zustand store in use-backend-store.ts; this module is just a sync accessor for
 * code that cannot easily import the store (e.g., sync URL helpers in backend-api.ts).
 *
 * Uses localStorage as a synchronous fallback so that API calls fired immediately
 * after page load (before checkConnection() resolves) still have a token.
 */
const TOKEN_KEY = "backend-token";

let _token = "";

export function setBackendToken(token: string): void {
    _token = token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked */ }
}

export function getBackendTokenShared(): string {
    if (_token) return _token;
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
