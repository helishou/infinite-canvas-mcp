declare module "file-saver" {
    export function saveAs(data: string | Blob, filename?: string, options?: { autoBom?: boolean }): void;
}

declare module "react-dom" {
    export function createPortal(children: import("react").ReactNode, container: Element | DocumentFragment, key?: string | null): import("react").ReactPortal;
    export function flushSync(callback: () => void): void;
}
