import { Clapperboard, FileText, ImagePlus, Images, LayoutGrid, Settings2, Video, Workflow } from "lucide-react";

export const navigationTools = [
    {
        slug: "production",
        icon: Clapperboard,
    },
    {
        slug: "canvas",
        icon: LayoutGrid,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "workflows",
        icon: Workflow,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
