import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { SubjectShotEditor } from "../src/pages/drama/subject-shot-editor";
import "../src/i18n";
import "../src/styles/globals.css";
import "../src/pages/drama/production.css";
import { getAntThemeConfig } from "../src/lib/app-theme";
document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

/** 真实 SubjectShotEditor + 真实 Backend 镜头库接口；只 stub 最终制作稿写入。 */
function Fixture() {
    const [draft, setDraft] = useState<string>();
    const [saved, setSaved] = useState<unknown>();
    const [shot, setShot] = useState<any>({
        id: "S1", title: "镜头", duration_frames: 96,
        visual: "青石建筑空间，镜头向抱鸡妇人推进。",
        // 旧稿手填的运镜方式：改成单选后必须继续显示，不能被静默丢弃。
        camera: { framing: "MS", editorial_reason: "先交代乌木条案周围的空间与人物关系", movement: "一镜到底：单摄影机连续跟拍，低机位快速推移" },
        subject_usages: [], keyframes: [], reference_requirements: [],
    });
    const source = { fps_num: 24, fps_den: 1, subject_registry: [], ledger: {}, asset_plan: [] };
    return <ConfigProvider theme={getAntThemeConfig(true)}><App><MemoryRouter><main className="p-8">
        <SubjectShotEditor
            shot={shot} source={source} canvasNodes={[]} assets={{}} canvasId="camera-library-fixture"
            busy={false} draftValue={draft} onDraftChange={setDraft}
            onSave={async (_id, patch) => {
                setSaved(patch);
                setShot((current: any) => ({ ...current, ...patch }));
                return true;
            }}
        />
        <pre aria-label="保存内容">{JSON.stringify(saved)}</pre>
        <pre aria-label="草稿内容">{draft || ""}</pre>
    </main></MemoryRouter></App></ConfigProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
