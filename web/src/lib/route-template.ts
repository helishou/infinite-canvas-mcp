import { matchRoutes, type RouteObject } from "react-router-dom";

/**
 * Collapse a concrete pathname to the route pattern that produced it, e.g. /canvas/abc → /canvas/:id.
 *
 * Stored events keep the exact path; the pattern is only a reporting view, so historical records
 * can be regrouped later without rewriting anything. Static siblings such as /canvas/performance
 * outrank /canvas/:id, and paths with no matching route keep their recorded value.
 */
export function routeTemplate(routes: RouteObject[], pathname: string) {
    const matches = matchRoutes(routes, pathname);
    return matches?.at(-1)?.route.path || pathname;
}
