import type { RequestHandler } from "express";

/** Dev-only mutation fence: idle check and closing the gate happen in one tick. */
export function createDevReloadGate() {
    let mutations = 0;
    let draining = false;
    const middleware: RequestHandler = (req, res, next) => {
        if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
        if (draining) { res.status(503).json({ ok: false, error: "Backend 正在开发重载，请保留编辑并等待重连" }); return; }
        mutations++;
        let finished = false;
        const finish = () => { if (!finished) { finished = true; mutations--; } };
        res.once("finish", finish);
        res.once("close", finish);
        next();
    };
    return {
        middleware,
        tryReload: (busy: () => boolean) => {
            if (draining || mutations || busy()) return false;
            draining = true;
            return true;
        },
    };
}
