export type H3IconName = "clapperboard" | "play" | "plus" | "download" | "settings" | "database" | "output" | "sparkles" | "paperclip" | "waves" | "trash" | "close" | "prompt" | "sliders";

const paths: Record<H3IconName, string> = {
    clapperboard: "M4 4h16v16H4z M4 8h16 M8 4l3 4 M14 4l3 4",
    play: "M8 5l11 7-11 7z",
    plus: "M12 5v14 M5 12h14",
    download: "M12 4v11 M7 11l5 5 5-5 M5 20h14",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 12h2m12 0h2M12 4v2m0 12v2",
    database: "M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0z M4 6c0 2 16 2 16 0 M4 12c0 2 16 2 16 0",
    output: "M5 5h14v14H5z M8 12h8m-4-4 4 4-4 4",
    sparkles: "M12 3l1.5 6.5L20 11l-6.5 1.5L12 19l-1.5-6.5L4 11l6.5-1.5z",
    paperclip: "M8 12.5l5.5-5.5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l7-7",
    waves: "M4 8c2-4 4 4 6 0s4 4 6 0 3 1 4 0 M4 12c2-4 4 4 6 0s4 4 6 0 3 1 4 0",
    trash: "M5 7h14m-9 4v5m4-5v5M9 7V4h6v3m-9 0 1 13h10l1-13",
    close: "M6 6l12 12M18 6L6 18",
    prompt: "M5 5h14v14H5z M8 9h8M8 13h5",
    sliders: "M4 7h16M4 12h16M4 17h16 M8 5v4m8-2v4m-5 3v4",
};

export function H3Icon({ name }: { name: H3IconName }) {
    return <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
