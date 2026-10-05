let applicationTitle = "";
let attentionTitle = "";

function renderTitle() {
    if (typeof document === "undefined") return;
    if (!applicationTitle) applicationTitle = document.title;
    document.title = attentionTitle ? `${attentionTitle} · ${applicationTitle}` : applicationTitle;
}

export function setApplicationTitle(title: string) { applicationTitle = title; renderTitle(); }
export function setAttentionTitle(title: string) { attentionTitle = title; renderTitle(); }
