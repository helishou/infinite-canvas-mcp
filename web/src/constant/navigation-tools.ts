import { Clapperboard, FileText, FolderOpen, Images, LayoutGrid, Workflow, WandSparkles } from "lucide-react";

/**
 * Primary workspaces. Existing tool URLs remain the canonical destinations.
 * 首页（workbench）不在此渲染：左上角 logo 即回主页入口，避免与导航项重复占一栏；
 * "workbench" 仍保留在 slug 类型里，主页时没有任何 tab 高亮，解析路由也不报错。
 */
export const navigationTools = [
    { slug: "projects", href: "/projects", icon: FolderOpen },
    { slug: "dramaStudio", href: "/drama-studio", icon: Clapperboard },
    { slug: "freeCanvas", href: "/projects?type=canvas", icon: LayoutGrid },
    { slug: "resources", href: "/assets", icon: Images },
    { slug: "workflows", href: "/workflows", icon: Workflow },
    { slug: "skills", href: "/skills", icon: WandSparkles },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"] | "workbench";

export const workspaceSecondaryNavigation = {
    projects: [
        { slug: "allProjects", href: "/projects", icon: FolderOpen },
        { slug: "canvasProjects", href: "/projects?type=canvas", icon: LayoutGrid },
        { slug: "dramaProjects", href: "/projects?type=drama", icon: Clapperboard },
    ],
    resources: [
        { slug: "assets", href: "/assets", icon: Images },
        { slug: "prompts", href: "/prompts", icon: FileText },
    ],
} as const;
