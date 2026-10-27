import localforage from "localforage";

export type LocalAnalyticsEventType = "pv" | "mv" | "mc";

/** Viewport-relative box at capture time, as 0..1 fractions. */
export type LocalAnalyticsRect = { x: number; y: number; w: number; h: number };

export type LocalAnalyticsEvent = {
    id: string;
    type: LocalAnalyticsEventType;
    path: string;
    module: string;
    name: string;
    occurredAt: string;
    /** Absent on records written before position previews existed. */
    rect?: LocalAnalyticsRect;
};

const events = localforage.createInstance({ name: "infinite-canvas", storeName: "local_analytics_events" });

function eventPath(path: string) {
    // Query strings and hashes can contain user supplied or identifying values.
    return path.split(/[?#]/, 1)[0] || "/";
}

/**
 * The report measures the app it is part of. Counting the report page itself would let every look at
 * the numbers add rows that describe nothing but the look, so that one route is left out.
 */
const UNTRACKED_PATHS = new Set(["/analytics/local"]);

/** Exported so the exclusion stays covered by tests instead of drifting silently. */
export function isTrackedPath(path: string) {
    return !UNTRACKED_PATHS.has(eventPath(path));
}

export async function recordLocalAnalyticsEvent(input: Omit<LocalAnalyticsEvent, "id" | "occurredAt">) {
    if (typeof window === "undefined") return;
    const path = eventPath(input.path);
    if (!isTrackedPath(path)) return;
    try {
        const event: LocalAnalyticsEvent = {
            ...input,
            path,
            id: crypto.randomUUID(),
            occurredAt: new Date().toISOString(),
        };
        await events.setItem(event.id, event);
    } catch {
        // Analytics storage failures must never affect normal application use.
    }
}

export async function readLocalAnalyticsEvents() {
    const result: LocalAnalyticsEvent[] = [];
    try {
        await events.iterate<LocalAnalyticsEvent, void>((value) => {
            if (value && typeof value === "object" && ["pv", "mv", "mc"].includes(value.type)) {
                result.push({ ...value, rect: readRect(value.rect) });
            }
        });
    } catch {
        // Treat unavailable local storage as an empty report.
    }
    return result.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function readRect(value: unknown): LocalAnalyticsRect | undefined {
    if (!value || typeof value !== "object") return undefined;
    const { x, y, w, h } = value as Record<string, unknown>;
    if (![x, y, w, h].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    if ((w as number) <= 0 || (h as number) <= 0) return undefined;
    return { x: x as number, y: y as number, w: w as number, h: h as number };
}

/** Record where the module sat on screen; it is the only way a later report can point at the region. */
function viewportRect(element: Element): LocalAnalyticsRect | undefined {
    try {
        const box = element.getBoundingClientRect();
        const width = window.innerWidth || 1;
        const height = window.innerHeight || 1;
        if (!box.width || !box.height) return undefined;
        const round = (value: number) => Math.round(value * 1000) / 1000;
        return { x: round(box.left / width), y: round(box.top / height), w: round(box.width / width), h: round(box.height / height) };
    } catch {
        return undefined;
    }
}

export async function exportLocalAnalytics(selectedEvents?: LocalAnalyticsEvent[]) {
    const records = selectedEvents ?? await readLocalAnalyticsEvents();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), events: records }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `infinite-canvas-local-analytics-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return records.length;
}

export function trackLocalPageview(path: string) {
    void recordLocalAnalyticsEvent({ type: "pv", path, module: "page", name: "page_view" });
}

function moduleIdentity(element: Element) {
    const explicit = element.getAttribute("data-analytics-module")?.trim();
    if (explicit) return explicit;
    const label = element.getAttribute("aria-label")?.trim();
    if (label) return label;
    const id = element.id.trim();
    if (id) return id;
    const testId = element.getAttribute("data-testid")?.trim();
    if (testId) return testId;
    const role = element.getAttribute("role");
    const kind = role === "tabpanel" || role === "region" ? role : element.tagName.toLowerCase();
    const parent = element.parentElement;
    const peers = parent ? Array.from(parent.children).filter((peer) => {
        const peerRole = peer.getAttribute("role");
        return (peerRole === "tabpanel" || peerRole === "region" ? peerRole : peer.tagName.toLowerCase()) === kind;
    }) : [];
    // Unnamed containers are unreadable on their own, so keep the nearest named ancestors as breadcrumbs.
    const context = ancestorContext(element);
    const structural = `${kind}#${Math.max(1, peers.indexOf(element) + 1)}`;
    return context ? `${context} › ${structural}` : structural;
}

function ancestorContext(element: Element) {
    const chain: string[] = [];
    let node = element.parentElement;
    while (node && chain.length < 2 && node !== document.body && node !== document.documentElement) {
        const label = node.getAttribute("data-analytics-module")?.trim()
            || node.getAttribute("data-testid")?.trim()
            || node.id.trim()
            || node.getAttribute("aria-label")?.trim();
        if (label) chain.unshift(label);
        node = node.parentElement;
    }
    return chain.join(" › ");
}

/**
 * Containers that count as a module. Plain divs are excluded because they would flood the report;
 * semantic landmarks, roles and explicit markers cover the regions a user can actually recognise.
 */
const MODULE_SELECTOR = [
    "[data-analytics-module]",
    "[data-testid]",
    "main",
    "header",
    "footer",
    "aside",
    "nav",
    "form",
    "section",
    "[role='tabpanel']",
    "[role='region']",
    "[role='dialog']",
    "[role='toolbar']",
    "[role='navigation']",
    "[role='banner']",
    "[role='complementary']",
    "[role='main']",
    "[role='search']",
].join(", ");

function trackingModule(element: Element) {
    return element.closest(MODULE_SELECTOR);
}

function clickableElement(target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    return target.closest("[data-analytics-click], button, a[href], [role='button'], [role='tab']");
}

function startClickTracking() {
    document.addEventListener("click", (event) => {
        const control = clickableElement(event.target);
        if (!control || control.closest("[data-analytics-ignore='true']")) return;
        const module = trackingModule(control);
        const explicitName = control.getAttribute("data-analytics-click")?.trim();
        const role = control.getAttribute("role") || control.tagName.toLowerCase();
        void recordLocalAnalyticsEvent({
            type: "mc",
            path: window.location.pathname,
            module: module ? moduleIdentity(module) : "unassigned",
            // Never capture visible control text or form contents; labels must be explicit and code-owned.
            name: explicitName || role,
            rect: module ? viewportRect(module) : undefined,
        });
    }, true);
}

/** A module counts as viewed when a quarter of it is on screen, or when it covers a quarter of the screen. */
export function isModuleViewed(
    entry: { isIntersecting: boolean; intersectionRatio: number; intersectionRect: { width: number; height: number } },
    viewport: { width: number; height: number },
) {
    if (!entry.isIntersecting) return false;
    if (entry.intersectionRatio >= 0.25) return true;
    // Page-sized containers can never reach 25% of themselves; otherwise whole-page regions would never be reported.
    return entry.intersectionRect.width * entry.intersectionRect.height >= 0.25 * viewport.width * viewport.height;
}

function startModuleViewTracking() {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const element = entry.target;
            if (isModuleViewed(entry, { width: window.innerWidth || 0, height: window.innerHeight || 0 })) {
                if (element.getAttribute("data-analytics-visible") === "true") continue;
                element.setAttribute("data-analytics-visible", "true");
                void recordLocalAnalyticsEvent({
                    type: "mv",
                    path: window.location.pathname,
                    module: moduleIdentity(element),
                    name: "module_view",
                    rect: viewportRect(element),
                });
            } else if (!entry.isIntersecting) {
                element.removeAttribute("data-analytics-visible");
            }
        }
        // Tall containers cross only the low ratios, so keep several checkpoints instead of one 25% mark.
    }, { threshold: [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1] });

    const observed = new WeakSet<Element>();
    const observeModules = (root: ParentNode) => {
        root.querySelectorAll(MODULE_SELECTOR).forEach((element) => {
            if (observed.has(element)) return;
            observed.add(element);
            observer.observe(element);
        });
    };
    observeModules(document);
    new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element) {
                    if (node.matches(MODULE_SELECTOR) && !observed.has(node)) {
                        observed.add(node);
                        observer.observe(node);
                    }
                    observeModules(node);
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}

let captureStarted = false;
export function startLocalAnalyticsCapture() {
    if (captureStarted || typeof document === "undefined") return;
    captureStarted = true;
    startClickTracking();
    startModuleViewTracking();
}
