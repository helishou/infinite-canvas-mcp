import type { NavigationToolSlug } from "@/constant/navigation-tools";

export type SecondaryWorkspace = "projects" | "generate" | "resources";
export type SecondaryNavigationSlug = "allProjects" | "canvasProjects" | "dramaProjects" | "image" | "video" | "assets" | "prompts";

type WorkspaceNavigationState = {
    area?: NavigationToolSlug;
    secondary?: SecondaryWorkspace;
    activeSecondary?: SecondaryNavigationSlug;
    compact: boolean;
};

/** Classify legacy URLs without redirecting, replacing IDs, or losing query context. */
export function resolveWorkspaceNavigation(pathname: string, search = ""): WorkspaceNavigationState {
    const segments = pathname.split("/").filter(Boolean);
    const root = segments[0];
    const query = new URLSearchParams(search);
    if (!root) return { area: "workbench", compact: false };
    if (root === "image" || root === "video") return { area: "generate", secondary: "generate", activeSecondary: root, compact: false };
    if (root === "assets" || root === "prompts") return { area: "resources", secondary: "resources", activeSecondary: root, compact: false };
    if (root === "workflows") return { area: "workflows", compact: false };
    if (root === "canvas" || (root === "projects" && query.get("type") === "canvas")) {
        return { area: "freeCanvas", compact: root === "canvas" && segments.length > 1 };
    }
    if (["projects", "production", "director", "drama"].includes(root)) {
        const projectDetail = segments.length > 1 || query.has("dramaId");
        const activeSecondary =
            root === "director"
                ? "canvasProjects"
                : root === "production" || root === "drama" || (root === "projects" && query.get("type") === "drama")
                  ? "dramaProjects"
                  : "allProjects";
        return { area: "projects", compact: false, ...(!projectDetail ? { secondary: "projects", activeSecondary } : {}) };
    }
    return { compact: false };
}
