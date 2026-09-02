declare module "*.css" {
    const css: string;
    export default css;
}

declare module "*.md?raw" {
    const text: string;
    export default text;
}

declare module "*.txt?raw" {
    const text: string;
    export default text;
}
