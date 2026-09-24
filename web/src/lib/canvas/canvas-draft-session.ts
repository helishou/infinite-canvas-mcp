import { nanoid } from "nanoid";
import { backendConnection } from "../backend-connection";
import { hasPendingDraftImport } from "./canvas-draft-import-state";

const SESSION_KEY = "canvas-draft-session";
const HANDOFF_KEY = "canvas-draft-lease-handoff";
const LOCK_PREFIX = "canvas-draft-owner:";
const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_RENEW_MARGIN_MS = 15_000;

type LeaseState = "idle" | "owned" | "unavailable" | "lost";
type DraftSession = {
    owner: string;
    holderId: string;
    ready?: Promise<void>;
    leaseState: LeaseState;
    leaseExpiresAt: number;
    heartbeat?: ReturnType<typeof setInterval>;
    lifecycleBound?: boolean;
};
type LeaseStatus = { active: boolean; owned: boolean; expiresAt: number | null };
type LeaseResult = { kind: "owned" | "held"; lease: LeaseStatus } | { kind: "unavailable" };
type LeaseHandoff = { owner: string; holderId: string };

// HMR 不能重复申请同一个页面自己的锁，也不能悄悄改变草稿归属。
const runtime = globalThis as typeof globalThis & { __canvasDraftSession?: Partial<DraftSession> };
const existing = runtime.__canvasDraftSession;
const session = runtime.__canvasDraftSession = {
    owner: existing?.owner || `browser:${nanoid()}`,
    holderId: existing?.holderId || `window:${nanoid()}`,
    ready: existing?.ready,
    leaseState: existing?.leaseState || "idle",
    leaseExpiresAt: existing?.leaseExpiresAt || 0,
    heartbeat: existing?.heartbeat,
    lifecycleBound: existing?.lifecycleBound,
} as DraftSession;

export const getCanvasDraftSessionId = () => session.owner;

function savedOwner() {
    try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

function savedHandoff(): LeaseHandoff | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null") as Partial<LeaseHandoff> | null;
        return value?.owner && value.holderId ? { owner: value.owner, holderId: value.holderId } : null;
    } catch { return null; }
}

function saveSession() {
    try {
        sessionStorage.setItem(SESSION_KEY, session.owner);
        sessionStorage.removeItem(HANDOFF_KEY);
    } catch { /* 当前文档仍使用独立身份。 */ }
}

function supportsWebLocks() {
    return typeof navigator !== "undefined" && Boolean(navigator.locks);
}

/** 锁由浏览器在文档终止时释放，不使用过期时间猜测另一窗口是否还活着。 */
function holdOwner(owner: string, recovering = false): Promise<boolean> {
    return new Promise((resolve, reject) => {
        void navigator.locks.request(LOCK_PREFIX + owner, { ifAvailable: true }, async (lock) => {
            const available = Boolean(lock) && (!recovering || !await hasPendingDraftImport(owner));
            resolve(available);
            if (available) return new Promise<void>(() => {});
        }).catch(reject);
    });
}

function leasePath(owner: string, action: "acquire" | "release" | "lease") {
    return `/canvas/draft-sessions/${encodeURIComponent(owner)}/${action}`;
}

async function leaseFetch(owner: string, action: "acquire" | "release" | "lease", holderId: string, keepalive = false) {
    const { url, token } = backendConnection();
    const query = action === "lease" ? `?holderId=${encodeURIComponent(holderId)}` : "";
    return fetch(`${url.replace(/\/$/, "")}${leasePath(owner, action)}${query}`, {
        method: action === "lease" ? "GET" : "POST",
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(action === "lease" ? {} : { "Content-Type": "application/json" }),
        },
        body: action === "lease" ? undefined : JSON.stringify({ holderId }),
        keepalive,
    });
}

async function acquireBackendLease(owner: string, holderId: string): Promise<LeaseResult> {
    try {
        const response = await leaseFetch(owner, "acquire", holderId);
        const body = await response.json().catch(() => ({})) as { lease?: LeaseStatus };
        if (response.status === 409 && body.lease) return { kind: "held", lease: body.lease };
        if (!response.ok || !body.lease?.owned) return { kind: "unavailable" };
        return { kind: "owned", lease: body.lease };
    } catch { return { kind: "unavailable" }; }
}

async function backendLeaseStatus(owner: string): Promise<boolean | null> {
    try {
        const response = await leaseFetch(owner, "lease", session.holderId);
        const body = await response.json().catch(() => ({})) as { lease?: LeaseStatus };
        return response.ok && body.lease ? body.lease.active : null;
    } catch { return null; }
}

function releaseBackendLease(owner = session.owner, holderId = session.holderId, keepalive = false) {
    return leaseFetch(owner, "release", holderId, keepalive).catch(() => undefined);
}

function markLeaseLost() {
    session.leaseState = "lost";
    session.leaseExpiresAt = 0;
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.heartbeat = undefined;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("canvas-draft-lease-lost", { detail: { message: "这份本机草稿已由另一窗口接管。为避免重复提交，当前窗口已停止写入；请刷新页面使用新的草稿会话。" } }));
}

function startBackendHeartbeat() {
    if (session.heartbeat) clearInterval(session.heartbeat);
    session.heartbeat = setInterval(() => {
        void acquireBackendLease(session.owner, session.holderId).then((result) => {
            if (result.kind === "owned") {
                session.leaseState = "owned";
                session.leaseExpiresAt = result.lease.expiresAt || 0;
            } else if (result.kind === "held") markLeaseLost();
        });
    }, LEASE_HEARTBEAT_MS);
    // Node 单测不应被浏览器心跳定时器挂住。
    (session.heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
}

function bindBackendLeaseLifecycle() {
    if (session.lifecycleBound || typeof window === "undefined") return;
    session.lifecycleBound = true;
    window.addEventListener("pagehide", (event) => {
        if ((event as PageTransitionEvent).persisted || session.leaseState !== "owned") return;
        try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ owner: session.owner, holderId: session.holderId })); } catch { /* 关闭页面仍由 30 秒超时兜底。 */ }
        if (session.heartbeat) clearInterval(session.heartbeat);
        session.heartbeat = undefined;
        void releaseBackendLease(session.owner, session.holderId, true);
    });
}

function adoptLease(owner: string, holderId: string, lease: LeaseStatus) {
    session.owner = owner;
    session.holderId = holderId;
    session.leaseState = "owned";
    session.leaseExpiresAt = lease.expiresAt || 0;
    saveSession();
    bindBackendLeaseLifecycle();
    startBackendHeartbeat();
}

async function initializeBackendLease() {
    const previous = savedOwner();
    const handoff = savedHandoff();
    const candidateHolder = handoff?.owner === previous ? handoff.holderId : session.holderId;
    if (previous && !await hasPendingDraftImport(previous).catch(() => true)) {
        const result = await acquireBackendLease(previous, candidateHolder);
        if (result.kind === "owned") {
            adoptLease(previous, candidateHolder, result.lease);
            return;
        }
    }
    for (;;) {
        const owner = `browser:${nanoid()}`;
        const result = await acquireBackendLease(owner, session.holderId);
        if (result.kind === "held") continue;
        session.owner = owner;
        if (result.kind === "owned") adoptLease(owner, session.holderId, result.lease);
        else {
            session.leaseState = "unavailable";
            session.leaseExpiresAt = 0;
            saveSession();
            bindBackendLeaseLifecycle();
        }
        return;
    }
}

/** 应用入口先完成认领，再导入 Store/编辑器，避免临时 owner 混入持久记录。 */
export function initializeCanvasDraftSession() {
    return session.ready ||= (async () => {
        if (typeof window === "undefined") return;
        if (supportsWebLocks()) {
            const previous = savedOwner();
            // 旧档案不可读时不能盲目恢复，也不应把在线画布挡在初始化页面；新身份不读取旧草稿。
            if (previous && await holdOwner(previous, true).catch((error) => { console.warn("旧草稿状态暂不可读，保留原记录并使用新窗口身份", error); return false; })) session.owner = previous;
            else while (!await holdOwner(session.owner)) session.owner = `browser:${nanoid()}`;
            saveSession();
            return;
        }
        await initializeBackendLease();
    })();
}

export async function ensureCanvasDraftLease() {
    await initializeCanvasDraftSession();
    if (supportsWebLocks()) return;
    if (session.leaseState === "lost") throw new Error("这份本机草稿已由另一窗口接管，当前窗口不能继续写入；请刷新页面");
    if (session.leaseState === "owned" && session.leaseExpiresAt - Date.now() > LEASE_RENEW_MARGIN_MS) return;
    const result = await acquireBackendLease(session.owner, session.holderId);
    if (result.kind === "held") {
        markLeaseLost();
        throw new Error("这份本机草稿已由另一窗口接管，当前窗口不能继续写入；请刷新页面");
    }
    if (result.kind === "unavailable") throw new Error("暂时无法确认本机草稿租约，为避免重复提交，当前写入已暂停");
    adoptLease(session.owner, session.holderId, result.lease);
}

export async function canvasDraftOwnerActive(owner: string) {
    if (!supportsWebLocks()) return backendLeaseStatus(owner);
    const state = await navigator.locks.query();
    return (state.held || []).some((lock) => lock.name === LOCK_PREFIX + owner);
}

/** 恢复整个会话，不复制/重写命令 ID；当前会话草稿原样保留，可再次找回。 */
export async function reopenCanvasDraftSession(owner: string) {
    if (owner === session.owner) return;
    if (supportsWebLocks()) {
        let available = false;
        await navigator.locks.request(LOCK_PREFIX + owner, { ifAvailable: true }, async (lock) => {
            if (!lock) return;
            if (await hasPendingDraftImport(owner)) throw new Error("这份备份尚未完整导入，请先完成导入，不能恢复部分记录");
            sessionStorage.setItem(SESSION_KEY, owner);
            available = true;
            window.location.reload();
        });
        if (!available) throw new Error("这份草稿仍由另一窗口使用，请先关闭那个窗口再恢复");
        return;
    }
    if (await hasPendingDraftImport(owner)) throw new Error("这份备份尚未完整导入，请先完成导入，不能恢复部分记录");
    const holderId = `window:${nanoid()}`;
    const result = await acquireBackendLease(owner, holderId);
    if (result.kind === "held") throw new Error("这份草稿仍由另一窗口使用，请先关闭那个窗口再恢复");
    if (result.kind === "unavailable") throw new Error("暂时无法连接后台确认草稿归属；原草稿不会改变");
    const oldOwner = session.owner, oldHolder = session.holderId;
    await releaseBackendLease(oldOwner, oldHolder);
    session.owner = owner;
    session.holderId = holderId;
    session.leaseState = "owned";
    session.leaseExpiresAt = result.lease.expiresAt || 0;
    try {
        sessionStorage.setItem(SESSION_KEY, owner);
        sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ owner, holderId }));
    } catch { /* reload 后仍会通过租约阻止其他窗口抢占。 */ }
    window.location.reload();
}

export async function withCanvasDraftOwner<T>(owner: string, action: () => Promise<T>) {
    if (supportsWebLocks()) return navigator.locks.request(LOCK_PREFIX + owner, { ifAvailable: true }, (lock) => {
        if (!lock) throw new Error("这份草稿仍由另一窗口使用，请先关闭原窗口再导入");
        return action();
    });
    if (owner === session.owner) {
        await ensureCanvasDraftLease();
        return action();
    }
    const holderId = `import:${nanoid()}`;
    const result = await acquireBackendLease(owner, holderId);
    if (result.kind === "held") throw new Error("这份草稿仍由另一窗口使用，请先关闭原窗口再导入");
    if (result.kind === "unavailable") throw new Error("暂时无法连接后台确认草稿归属；原备份不会改变");
    const heartbeat = setInterval(() => { void acquireBackendLease(owner, holderId); }, LEASE_HEARTBEAT_MS);
    (heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    try { return await action(); }
    finally {
        clearInterval(heartbeat);
        await releaseBackendLease(owner, holderId);
    }
}
