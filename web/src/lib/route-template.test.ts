import assert from "node:assert/strict";
import test from "node:test";

import { routeTemplate } from "./route-template";

const routes = [
    { path: "/" },
    { path: "/image" },
    { path: "/canvas" },
    { path: "/canvas/performance" },
    { path: "/canvas/:id" },
    { path: "/director/:projectId" },
    { path: "/drama/episodes/:episodeId/production" },
];

test("concrete ids collapse to the pattern that produced them", () => {
    assert.equal(routeTemplate(routes, "/canvas/CQHFYYKku76yKKlUfVQB9"), "/canvas/:id");
    assert.equal(routeTemplate(routes, "/director/8zQVIZGBX0KvFipc-nywu"), "/director/:projectId");
    assert.equal(routeTemplate(routes, "/drama/episodes/episode-a/production"), "/drama/episodes/:episodeId/production");
});

test("static siblings are not swallowed by a dynamic sibling", () => {
    assert.equal(routeTemplate(routes, "/canvas/performance"), "/canvas/performance");
    assert.equal(routeTemplate(routes, "/canvas"), "/canvas");
    assert.equal(routeTemplate(routes, "/image"), "/image");
});

test("unmatched paths keep the recorded path instead of inventing a pattern", () => {
    assert.equal(routeTemplate(routes, "/pelican-bike"), "/pelican-bike");
});
