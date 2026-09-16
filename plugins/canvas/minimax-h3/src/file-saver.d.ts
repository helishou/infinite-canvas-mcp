// file-saver 未附带 .d.ts：与其装 @types，这里一个最小声明即可（与主项目用法一致：saveAs(url, name)）。
declare module "file-saver" {
    export function saveAs(data: string | Blob, filename?: string, options?: { autoBom?: boolean }): void;
}
