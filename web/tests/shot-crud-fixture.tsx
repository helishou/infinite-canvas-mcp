import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { ShotOperations, type ShotOperation } from "../src/pages/drama/shot-operations";
import "../src/i18n";
import "../src/styles/globals.css";
declare global { interface Window { shotFixtureSource: Record<string, any>; applyFixtureShot: (operation: ShotOperation) => Promise<Record<string, any>> } }
function Fixture() {
    const [source, setSource] = useState(window.shotFixtureSource), [selected, setSelected] = useState("S1");
    const shot = source.shots.find((shot: Record<string, any>) => shot.id === selected) || source.shots[0];
    return <ConfigProvider><App><main className="space-y-4 p-8"><ShotOperations source={source} shot={shot} onSelect={setSelected} onEdit={async operation => { setSource(await window.applyFixtureShot(operation)); return true; }} /><p aria-label="当前镜头">{shot?.title}</p><pre aria-label="制作源稿">{JSON.stringify(source)}</pre></main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
