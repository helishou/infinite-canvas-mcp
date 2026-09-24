import assert from "node:assert/strict";
import test from "node:test";
import { REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD, REFERENCE_WRITE_MONITOR_WINDOW_MS, ReferenceWriteMonitor } from "./write-monitor.js";

test("参考资产高频写入触发一次告警，并在窗口后允许再次告警", () => {
    const alerts: unknown[] = [];
    const monitor = new ReferenceWriteMonitor((alert) => alerts.push(alert));
    for (let index = 0; index < REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD; index++) monitor.record({ projectId: "p", assetId: "a", changed: true }, 1000 + index);
    assert.equal(alerts.length, 1);
    assert.deepEqual(monitor.snapshot("p", 1001).assets, [{ assetId: "a", attempts: REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD, changed: REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD }]);
    const nextWindowStart = 1000 + REFERENCE_WRITE_MONITOR_WINDOW_MS + REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD;
    for (let index = 0; index < REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD; index++) monitor.record({ projectId: "p", assetId: "a", changed: true }, nextWindowStart + index);
    assert.equal(alerts.length, 2);
});

test("不同项目或资产分别统计，普通去重命中也保留在监控中", () => {
    const monitor = new ReferenceWriteMonitor();
    monitor.record({ projectId: "p", assetId: "a", changed: false }, 1000);
    monitor.record({ projectId: "p", assetId: "b", changed: true }, 1001);
    monitor.record({ projectId: "other", assetId: "a", changed: true }, 1002);
    assert.deepEqual(monitor.snapshot("p", 1002), { windowMs: REFERENCE_WRITE_MONITOR_WINDOW_MS, alertThreshold: REFERENCE_WRITE_MONITOR_ALERT_THRESHOLD, attempts: 2, changed: 1, assets: [{ assetId: "a", attempts: 1, changed: 0 }, { assetId: "b", attempts: 1, changed: 1 }] });
});
