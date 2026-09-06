// 图标统一走 lucide-react（与 web 主项目同一图标集 + 同一视觉规格：24 viewBox / 1.8 圆头描边）。
// 这里只做「插件命名 → lucide 组件」的映射，组件签名保持 H3Icon({ name }) 不变，调用方零改动。
import type { ComponentType, SVGProps } from "react";
import { Activity, Clapperboard, Database, Download, Film, Focus, Image, Link2, ListFilter, Maximize2, MessageSquareText, Paperclip, Play, Plus, RotateCcw, Settings, SlidersHorizontal, Sparkles, X } from "lucide-react";

export type H3IconName = "clapperboard" | "play" | "plus" | "download" | "settings" | "database" | "folder" | "output" | "restore" | "sparkles" | "paperclip" | "waves" | "link2" | "trash" | "close" | "prompt" | "sliders" | "filter-all" | "filter-current" | "zoom" | "frame";

const ICONS: Record<H3IconName, ComponentType<SVGProps<SVGSVGElement>>> = {
    clapperboard: Clapperboard,
    play: Play,
    plus: Plus,
    download: Download,
    settings: Settings,
    database: Database,
    folder: Database,
    output: Film,
    restore: RotateCcw,
    sparkles: Sparkles,
    paperclip: Paperclip,
    waves: Activity,
    link2: Link2,
    trash: X,
    close: X,
    prompt: MessageSquareText,
    sliders: SlidersHorizontal,
    "filter-all": ListFilter,
    "filter-current": Focus,
    zoom: Maximize2,
    frame: Image,
};

export function H3Icon({ name, ...props }: { name: H3IconName } & SVGProps<SVGSVGElement>) {
    const Icon = (ICONS as Record<string, ComponentType<SVGProps<SVGSVGElement>>>)[name] || X;
    return <Icon {...props} aria-hidden="true" />;
}
