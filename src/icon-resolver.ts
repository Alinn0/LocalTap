import { IconSource, MediaAsset } from './models';
import { getAsset, saveAsset } from './media-db';
// Full page identity preserves protocol, port, path and query.
export function normalizedDomain(value: string): string | undefined {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : undefined; } catch { return undefined; }
}
export function iconCacheId(source: IconSource, page: string): string { return `icon:${source}:${page}`; }
function originPattern(value: string): string { const u = new URL(value); return `${u.protocol}//${u.hostname}/*`; }
// Explicit one-time user consent; never requested by the automatic lookup loop.
export async function requestIconPermission(): Promise<boolean> {
  if (!globalThis.chrome?.permissions?.request) return true;
  return chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
}
export async function getCachedIcon(source: IconSource, page: string): Promise<MediaAsset | undefined> {
  const asset = await getAsset(iconCacheId(source, page));
  if (asset?.kind === 'icon') return asset;
  // Reuse downloaded data from previous versions, without calling those services.
  for (const legacySource of ['auto', 'domestic', 'international', 'site']) {
    for (const identity of [page, new URL(page).hostname]) {
      const legacy = await getAsset(`icon:${legacySource}:${identity}`);
      if (legacy?.kind === 'icon') {
        const migrated = { ...legacy, id: iconCacheId(source, page), source };
        await saveAsset(migrated); return migrated;
      }
    }
  }
  return undefined;
}
async function fetchResource(url: string, limit: number): Promise<{ blob: Blob; url: string }> {
  if (!normalizedDomain(url)) throw new Error('仅支持 HTTP/HTTPS');
  if (globalThis.chrome?.permissions?.contains && !(await chrome.permissions.contains({ origins: [originPattern(url)] }))) throw new Error(`未授权 ${new URL(url).hostname}，跳过此图标候选`);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('响应为空');
    const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('响应超过大小限制'); } chunks.push(new Uint8Array(value)); }
    return { blob: new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || '' }), url: response.url || url };
  } finally { clearTimeout(timer); }
}
async function checkedIcon(blob: Blob): Promise<Blob> {
  if (!blob.size || blob.size > 256 * 1024) throw new Error('图标必须为 256 KB 以内的图片');
  if (blob.type === 'text/html') throw new Error('响应是网页而非图片');
  return normalizeIcon(blob); // SVG is isolated in an Image, then rasterized; never injected as markup.
}
export function extractIconLinks(html: string, page: string): { icons: string[]; manifest?: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const resolve = (value: string, base: string): string | undefined => { try { return normalizedDomain(new URL(value, base).href); } catch { return undefined; } };
  const base = resolve(doc.querySelector('base[href]')?.getAttribute('href') || page, page) || page;
  const links = [...doc.querySelectorAll<HTMLLinkElement>('link[href]')];
  const icons = links.filter(link => /(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)/i.test(link.rel))
    .sort((a,b) => (parseInt(b.getAttribute('sizes') || '0') || 0) - (parseInt(a.getAttribute('sizes') || '0') || 0))
    .map(link => resolve(link.getAttribute('href')!, base)).filter((url): url is string => !!url);
  const manifest = links.find(link => link.rel.split(/\s+/).includes('manifest'));
  return { icons: [...new Set(icons)].slice(0, 6), manifest: manifest ? resolve(manifest.getAttribute('href')!, base) : undefined };
}
async function browserIcon(page: string): Promise<Blob> {
  if (!globalThis.chrome?.runtime?.getURL) throw new Error('不是扩展环境');
  const read = async (value: string) => { const url = new URL(chrome.runtime.getURL('/_favicon/')); url.searchParams.set('pageUrl', value); url.searchParams.set('size', '64'); return checkedIcon(await (await fetch(url, { signal: AbortSignal.timeout(4000) })).blob()); };
  const icon = await read(page), fallback = await read('https://localtab-missing-favicon.invalid/');
  const a = new Uint8Array(await icon.arrayBuffer()), b = new Uint8Array(await fallback.arrayBuffer());
  if (a.length === b.length && a.every((value, i) => value === b[i])) throw new Error('浏览器只有默认占位图');
  return icon;
}
export async function fetchAndCacheIcon(source: IconSource, page: string): Promise<MediaAsset> {
  const cached = await getCachedIcon(source, page);
  if (cached) return cached;
  const failures: string[] = [];
  const attempt = async (action: () => Promise<Blob>): Promise<Blob | undefined> => { try { return await action(); } catch (e) { failures.push(e instanceof Error ? e.message : String(e)); return undefined; } };
  const readIcon = async (url: string) => checkedIcon((await fetchResource(url, 256 * 1024)).blob);
  let icon = await attempt(() => browserIcon(page));
  if (!icon) await attempt(async () => {
    const response = await fetchResource(page, 1024 * 1024);
    const links = extractIconLinks(await response.blob.text(), response.url);
    for (const url of links.icons) { icon = await attempt(() => readIcon(url)); if (icon) return icon; }
    if (links.manifest) {
      const response = await fetchResource(links.manifest, 256 * 1024);
      const manifest = JSON.parse(await response.blob.text()) as { icons?: { src?: string }[] };
      if (Array.isArray(manifest.icons)) for (const entry of manifest.icons.slice(0, 6)) {
        if (!entry || typeof entry.src !== 'string') continue;
        const url = normalizedDomain(new URL(entry.src, response.url).href);
        if (url) icon = await attempt(() => readIcon(url)); if (icon) return icon;
      }
    }
    throw new Error('页面没有可读取的图标');
  });
  icon ??= await attempt(() => readIcon(new URL('/favicon.ico', page).href));
  if (!icon) throw new Error(failures.join('；'));
  const asset: MediaAsset = { id: iconCacheId(source, page), name: page, type: 'image/png', kind: 'icon', size: icon.size, importedAt: Date.now(), hash: `${source}:${page}`, width: 64, height: 64, source, domain: page, blob: icon };
  await saveAsset(asset); return asset;
}

async function normalizeIcon(blob: Blob): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(blob);
  try {
    return await rasterizeImage(await loadImage(sourceUrl));
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => { image.src = ''; reject(new Error('图标解码超时')); }, 5000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('图标响应不是可解码的图片')); };
    image.src = source;
  });
}

async function rasterizeImage(image: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图标处理画布');
  const scale = Math.min(64 / image.naturalWidth, 64 / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  context.drawImage(image, (64-w)/2, (64-h)/2, w, h);
  const normalized = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!normalized) throw new Error('图标转换为 PNG 失败');
  return normalized;
}
