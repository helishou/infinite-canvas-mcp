import { useEffect, useState } from "react";
import { fetchCameraLibrary, type CameraLibraryIndex, type CameraLibraryMove } from "@/services/backend-api";

/**
 * 「运镜方式」下拉与镜头库预览弹窗写的是同一个标准值：`camera.movement` 用镜头的中英文名，
 * `camera.previs_id` 绑定 001–132 检索号。两个入口都从这里取值，避免文本与绑定各写一套。
 */
export const cameraMovementValue = (move: CameraLibraryMove) => `${move.nameZh} / ${move.nameEn}`;

export function findCameraLibraryMove(index: CameraLibraryIndex | undefined, movement: string) {
    const value = movement.trim();
    return value ? index?.moves.find(move => cameraMovementValue(move) === value) : undefined;
}

export function findCameraLibraryMoveById(index: CameraLibraryIndex | undefined, id: string) {
    return id ? index?.moves.find(move => move.id === id) : undefined;
}

export type CameraLibraryState = {
    index?: CameraLibraryIndex;
    loading: boolean;
    error: string;
    reload: () => void;
};

let cached: CameraLibraryIndex | undefined;
let inflight: Promise<CameraLibraryIndex> | undefined;

/** skill 索引是只读清单：切换镜头、重复打开弹窗都复用一次请求，只有显式重载才重取。 */
function loadCameraLibrary(force = false): Promise<CameraLibraryIndex> {
    if (force) cached = undefined;
    if (cached) return Promise.resolve(cached);
    if (inflight) return inflight;
    inflight = fetchCameraLibrary()
        .then(index => { cached = index; return index; })
        .finally(() => { inflight = undefined; });
    return inflight;
}

/** 一次加载供「运镜方式」下拉与镜头库弹窗共用；失败保留可重试状态，不写入半个清单。 */
export function useCameraLibrary(): CameraLibraryState {
    const [index, setIndex] = useState<CameraLibraryIndex | undefined>(cached);
    const [loading, setLoading] = useState(!cached);
    const [error, setError] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    useEffect(() => {
        let active = true;
        setLoading(true);
        void loadCameraLibrary(reloadKey > 0)
            .then(data => {
                if (!active) return;
                setIndex(data);
                setError("");
            })
            .catch(reason => {
                if (active) setError(reason instanceof Error ? reason.message : String(reason));
            })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [reloadKey]);
    return { index, loading, error, reload: () => setReloadKey(key => key + 1) };
}
