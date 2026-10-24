import localforage from "localforage";

export type LocalAnalyticsEventType = "pv" | "mv" | "mc";

export type LocalAnalyticsEvent = {
    id: string;
    type: LocalAnalyticsEventType;
    path: string;
    module: string;
    name: string;
    occurredAt: string;
};

const events = localforage.createInstance({ name: "infinite-canvas", storeName: "local_analytics_events" });

function eventPath(path: string) {
    // Query strings and hashes can contain user supplied or identifying values.
    return path.split(/[?#]/, 1)[0] || "/";
}

export async function recordLocalAnalyticsEvent(input: Omit<LocalAnalyticsEvent, "id" | "occurredAt">) {
    if (typeof window === "undefined") return;
    try {
        const event: LocalAnalyticsEvent = {
            ...input,
            path: eventPath(input.path),
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
            if (value && typeof value === "object" && ["pv", "mv", "mc"].includes(value.type)) result.push(value);
        });
    } catch {
        // Treat unavailable local storage as an empty report.
    }
    return result.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
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
    return `${kind}#${Math.max(1, peers.indexOf(element) + 1)}`;
}

function trackingModule(element: Element) {
    return element.closest("[data-analytics-module], [data-testid], section, [role='tabpanel'], [role='region']");
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
        });
    }, true);
}

function startModuleViewTracking() {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const element = entry.target;
            if (entry.isIntersecting && entry.intersectionRatio >= 0.25) {
                if (element.getAttribute("data-analytics-visible") === "true") continue;
                element.setAttribute("data-analytics-visible", "true");
                void recordLocalAnalyticsEvent({
                    type: "mv",
                    path: window.location.pathname,
                    module: moduleIdentity(element),
                    name: "module_view",
                });
            } else if (!entry.isIntersecting) {
                element.removeAttribute("data-analytics-visible");
            }
        }
    }, { threshold: [0, 0.25] });

    const observed = new WeakSet<Element>();
    const observeModules = (root: ParentNode) => {
        root.querySelectorAll("[data-analytics-module], [data-testid], section, [role='tabpanel'], [role='region']").forEach((element) => {
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
                    if (node.matches("[data-analytics-module], [data-testid], section, [role='tabpanel'], [role='region']") && !observed.has(node)) {
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
