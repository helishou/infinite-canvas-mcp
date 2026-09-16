/** 读取接口现有分页，空页表示结束；请求失败直接交给调用方处理。 */
export async function readAllPages<T>(read: (offset: number) => Promise<T[]>) {
    const result: T[] = [];
    while (true) {
        const page = await read(result.length);
        if (!page.length) return result;
        result.push(...page);
    }
}
