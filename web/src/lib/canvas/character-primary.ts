type CharacterImageRef = { url: string; storageKey?: string };

/** 图片列表变动时保留原来选中的图片，而不是沿用可能已指向另一张图的数组索引。 */
export function retainCharacterPrimaryIndex(previousImages: CharacterImageRef[], previousIndex: number, nextImages: CharacterImageRef[]): number {
    const currentIndex = Math.min(Math.max(previousIndex, 0), Math.max(previousImages.length - 1, 0));
    const primary = previousImages[currentIndex];
    const match = nextImages.findIndex((image) => primary?.storageKey ? image.storageKey === primary.storageKey : Boolean(primary?.url && image.url === primary.url));
    return match >= 0 ? match : Math.min(currentIndex, Math.max(nextImages.length - 1, 0));
}
