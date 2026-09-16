import { unzip, Zip, ZipPassThrough } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: Iterable<ZipFile> | AsyncIterable<ZipFile>) {
    const chunks: BlobPart[] = [];
    let failure: Error | null = null;
    const archive = new Zip((error, data) => {
        if (error) failure = error;
        else chunks.push(new Uint8Array(data));
    });
    try {
        for await (const file of files) {
            const entry = new ZipPassThrough(file.name);
            archive.add(entry);
            const reader = new Blob([file.data]).stream().getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    entry.push(value);
                    if (failure) throw failure;
                }
                entry.push(new Uint8Array(), true);
            } finally { reader.releaseLock(); }
        }
        archive.end();
        if (failure) throw failure;
        return new Blob(chunks, { type: "application/zip" });
    } catch (error) {
        archive.terminate();
        throw error;
    }
}

export async function readZip(file: Blob) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(bytes, (error, data) => error ? reject(error) : resolve(data));
    });
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([new Uint8Array(data)])]));
}
