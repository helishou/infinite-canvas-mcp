/** Isolated interactive fixture: no user database, no media generation. */
import { BackendDatabase } from "../src/db.js";
import { startServer } from "../src/server.js";
import { CanvasRealtimeHub } from "../src/canvas/realtime-hub.js";
const db = new BackendDatabase(":memory:");
db.upsertCanvasFolder({ id: "preview-drama", name: "共享资产验证", isDrama: true, createdAt: new Date().toISOString() });
for (const [index, id] of ["preview-live-a", "preview-live-b"].entries()) {
    db.createCanvasProject({ id, title: index ? "分集二" : "分集一", nodes: index ? [] : [{ id: "preview-text", type: "text", title: "共享文本测试", position: { x: 0, y: 0 }, width: 440, height: 260, metadata: { content: "共享资产初始内容", fontSize: 20, status: "success" } }], connections: [], viewport: { x: 100, y: 180, k: 1 } });
    db.upsertDramaEpisode({ id: `ep-${id}`, dramaId: "preview-drama", episodeNumber: index + 1, title: `分集${index + 1}`, synopsis: "", fullPlot: "", canvasId: id, createdAt: "now", updatedAt: "now" });
}
const config = { url: "http://127.0.0.1", token: "shared-library-test", port: 0, origins: ["http://127.0.0.1:3017"] };
const { app, events } = startServer(db, config);
const hub = new CanvasRealtimeHub(config, db, events);
app.get("/canvas/projects/:id/collaboration", (req, res) => {
    const project = db.getCanvasProject(req.params.id);
    res.json({ ok: true, projectId: req.params.id, revision: Number(project?.revision || 0), participants: hub.participants(req.params.id) });
});
const server = app.listen(Number(process.env.CANVAS_PREVIEW_PORT) || 0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") console.log(`SHARED_LIBRARY_PREVIEW_PORT=${address.port}`);
});
hub.attach(server);
process.on("SIGINT", () => { hub.close(); server.close(() => { db.close(); process.exit(0); }); });
