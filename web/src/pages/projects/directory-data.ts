import { hasAgentUrlBootstrap } from "../../lib/agent/agent-url-bootstrap";
import type { CanvasFolder, CanvasProject } from "../../stores/canvas/use-canvas-store";
import type { DramaEpisode } from "../../services/backend-api";

export type ProjectDirectoryType = "all" | "canvas" | "drama";

export function projectDirectoryType(pathname: string, query: URLSearchParams): ProjectDirectoryType {
    // Legacy entry points keep their original scope, including Agent's canvas chooser.
    if (pathname === "/canvas") return "canvas";
    if (pathname === "/production") return "drama";
    const type = query.get("type");
    return type === "canvas" || type === "drama" ? type : "all";
}

export function updateProjectDirectoryLocation(
    location: { pathname: string; search: string; hash: string },
    update: { type?: ProjectDirectoryType; q?: string },
) {
    const query = new URLSearchParams(location.search);
    if (update.type !== undefined) {
        if (update.type === "all") query.delete("type"); else query.set("type", update.type);
    }
    if (update.q !== undefined) {
        if (update.q) query.set("q", update.q); else query.delete("q");
    }
    return {
        pathname: update.type === undefined ? location.pathname : "/projects",
        search: query.toString(),
        hash: location.hash,
    };
}

export function matchesProjectQuery(name: string, query: string) {
    return name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

/** Production ownership comes from explicit episode/shared bindings, never legacy folder membership. */
export function dramaCanvasOwners(
    folders: CanvasFolder[],
    episodesByDrama: Record<string, readonly Pick<DramaEpisode, "canvasId">[] | undefined>,
) {
    const owners = new Map<string, CanvasFolder>();
    for (const drama of folders.filter(folder => folder.isDrama)) {
        if (drama.sharedAssetCanvasId) owners.set(drama.sharedAssetCanvasId, drama);
        for (const episode of episodesByDrama[drama.id] || []) {
            if (episode.canvasId) owners.set(episode.canvasId, drama);
        }
    }
    return owners;
}

export function ordinaryCanvasProjects(
    projects: CanvasProject[],
    folders: CanvasFolder[],
    episodesByDrama: Record<string, readonly Pick<DramaEpisode, "canvasId">[] | undefined>,
) {
    const owners = dramaCanvasOwners(folders, episodesByDrama);
    // An unread episode directory is not proof that a legacy drama member is unbound.
    // Once that read succeeds, even an empty list lets unbound canvases remain discoverable.
    const unresolvedDramaIds = new Set(folders.filter(folder => folder.isDrama && episodesByDrama[folder.id] === undefined).map(folder => folder.id));
    return projects.filter(project => !owners.has(project.id) && !unresolvedDramaIds.has(project.folderId || ""));
}

export function canvasProjectDestination(id: string, view: "canvas" | "production", search = "", hash = "") {
    const query = search.replace(/^\?/, "");
    const agentHash = hasAgentUrlBootstrap(hash) ? hash : "";
    return {
        to: `/${view === "canvas" ? "canvas" : "director"}/${encodeURIComponent(id)}${query ? `?${query}` : ""}${agentHash}`,
        replace: Boolean(agentHash),
    };
}

export function dramaProjectDestination(id: string, search = "") {
    const query = new URLSearchParams(search);
    query.set("dramaId", id);
    query.delete("manage");
    query.delete("episodeId");
    return `/production?${query.toString()}`;
}
