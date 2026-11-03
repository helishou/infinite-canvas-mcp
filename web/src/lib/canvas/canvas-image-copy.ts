import type { CanvasNodeData } from '@/types/canvas';
import { canvasNodePrimaryImage } from './canvas-image-renderability';
import { getMediaBlob } from '@/services/file-storage';
import { resolveImageUrl } from '@/services/image-storage';

type VisibleImage = NonNullable<ReturnType<typeof canvasNodePrimaryImage>>;
type ImageCopyIO = {
 read: (image: VisibleImage) => Promise<Blob>;
 png: (blob: Blob) => Promise<Blob>;
 write: (png: Promise<Blob>) => Promise<void>;
};

async function readImage(image: VisibleImage) {
 if (image.storageKey) {
  const blob = await getMediaBlob(image.storageKey);
  if (!blob) throw new Error('当前图片媒体不可读取');
  return blob;
 }
 const url = await resolveImageUrl(undefined, image.content);
 if (!url) throw new Error('当前图片没有可读取内容');
 const response = await fetch(url);
 if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
 return response.blob();
}

/** PNG is the interoperable native image clipboard format, not a custom web MIME. */
async function imagePng(blob: Blob) {
 if (blob.type === 'image/png') return blob;
 const bitmap = await createImageBitmap(blob);
 try {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法转换剪贴板图片');
  context.drawImage(bitmap,0,0);
  return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value ? resolve(value) : reject(new Error('图片 PNG 转换失败')), 'image/png'));
 } finally { bitmap.close(); }
}

function writeImage(png: Promise<Blob>) {
 if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined' || typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png')) {
  // No URL/text fallback: callers surface this failure to the user.
  void png.catch(()=>undefined);
  throw new Error('当前环境不支持图片剪贴板，请在安全浏览器环境中使用');
 }
 return navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
}

/** An explicit hit target must never fall back to a different primary image. */
export function canvasImageCopyTarget(node: CanvasNodeData, imageId?: string): VisibleImage | null {
 if (imageId === undefined) return canvasNodePrimaryImage(node);
 const image = node.metadata?.images?.find(item => item.id === imageId);
 if (!image || (!image.content && !image.storageKey)) return null;
 return { content: image.content || '', storageKey: image.storageKey, naturalWidth: image.naturalWidth || 0, naturalHeight: image.naturalHeight || 0, bytes: image.bytes || 0, mimeType: image.mimeType || 'image/png' };
}

/** Copy the right-clicked image, or the displayed primary when no image target was supplied. */
export async function copyCanvasImageContent(node: CanvasNodeData, io: ImageCopyIO = {read:readImage,png:imagePng,write:writeImage}, imageId?: string) {
 const image = canvasImageCopyTarget(node, imageId);
 if (!image) throw new Error('当前没有可复制的图片');
 // Pass a promise into ClipboardItem before awaiting network/decode so user activation survives.
 const png = Promise.resolve().then(()=>io.read(image)).then(io.png);
 void png.catch(()=>undefined);
 await io.write(png);
}
