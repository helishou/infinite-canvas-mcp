import { Clapperboard, FileText, FolderOpen, House, Images, LayoutGrid, Workflow, WandSparkles } from "lucide-react";

/** Primary workspaces. Existing tool URLs remain the canonical destinations. */
export const navigationTools = [
    { slug: "workbench", href: "/", icon: House },
    { slug: "projects", href: "/projects", icon: FolderOpen },
    { slug: "freeCanvas", href: "/projects?type=canvas", icon: LayoutGrid },
    { slug: "resources", href: "/assets", icon: Images },
    { slug: "workflows", href: "/workflows", icon: Workflow },
    { slug: "skills", href: "/skills", icon: WandSparkles },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

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
