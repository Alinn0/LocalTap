import { IconSource, MediaAsset } from './models';
import { deleteAsset, getAsset, listAssets, saveAsset } from './media-db';

export interface IconSourceDefinition {
  label: string;
  origins?: string[];
  buildUrl?: (domain: string) => string;
}

export interface IconFetchResult {
  asset: MediaAsset;
  fallbackUsed: boolean;
}

export const ICON_SOURCES: Record<IconSource, IconSourceDefinition> = {
  browser: {
    label: 'Chrome 内置',
  },
  domestic: {
    label: '国内源 · 百度',
    origins: ['https://favicon.baidubce.com/*'],
    buildUrl: (domain) => `https://favicon.baidubce.com/favicon.ico?url=${encodeURIComponent(`https://${domain}`)}`,
  },
  international: {
    label: '国际源 · Google',
    origins: ['https://www.google.com/*', 'https://*.gstatic.com/*'],
    buildUrl: (domain) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
  },
};

const MAX_ICON_BYTES = 256 * 1024;
const ALLOWED_ICON_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/gif',
]);

export function normalizedDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function iconCacheId(source: IconSource, domain: string): string {
  return `icon:${source}:${domain}`;
}

export async function hasIconPermission(source: IconSource): Promise<boolean> {
  const permissions = globalThis.chrome?.permissions;
  if (!permissions?.contains) return true;
  if (source === 'browser') return permissions.contains({ permissions: ['favicon'] });
  const origins = ICON_SOURCES[source].origins;
  if (!origins) throw new Error(`${ICON_SOURCES[source].label} 未配置主机权限`);
  return permissions.contains({ permissions: ['favicon'], origins });
}

export async function requestIconPermission(source: IconSource): Promise<boolean> {
  const permissions = globalThis.chrome?.permissions;
  if (!permissions?.request) return true;
  if (source === 'browser') return permissions.request({ permissions: ['favicon'] });
  const origins = ICON_SOURCES[source].origins;
  if (!origins) throw new Error(`${ICON_SOURCES[source].label} 未配置主机权限`);
  return permissions.request({ permissions: ['favicon'], origins });
}

export async function getCachedIcon(source: IconSource, domain: string): Promise<MediaAsset | undefined> {
  const asset = await getAsset(iconCacheId(source, domain));
  return asset?.kind === 'icon' ? asset : undefined;
}

export async function fetchAndCacheIcon(source: IconSource, domain: string, pageUrl = `https://${domain}`): Promise<IconFetchResult> {
  if (!(await hasIconPermission(source))) {
    throw new Error(`未授予 ${ICON_SOURCES[source].label} 的图标读取权限`);
  }

  if (source === 'browser') {
    try {
      return { asset: await cacheIcon(source, domain, await fetchBrowserIcon(pageUrl)), fallbackUsed: false };
    } catch (error) {
      throw new Error(`Chrome 内置图标获取失败：${errorMessage(error)}`);
    }
  }

  let sourceError: string;
  try {
    const blob = await fetchRemoteIcon(source, domain);
    return { asset: await cacheIcon(source, domain, blob), fallbackUsed: false };
  } catch (error) {
    sourceError = errorMessage(error);
  }

  try {
    return { asset: await cacheIcon(source, domain, await fetchBrowserIcon(pageUrl)), fallbackUsed: true };
  } catch (error) {
    throw new Error(`${ICON_SOURCES[source].label} 获取失败：${sourceError}；Chrome 内置回退也失败：${errorMessage(error)}`);
  }
}

async function fetchRemoteIcon(source: IconSource, domain: string): Promise<Blob> {
  const buildUrl = ICON_SOURCES[source].buildUrl;
  if (!buildUrl) throw new Error(`${ICON_SOURCES[source].label} 未配置图标地址`);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch(buildUrl(domain), {
      credentials: 'omit',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求 ${domain} 图标超时`);
    throw new Error(`请求 ${domain} 图标失败：${errorMessage(error)}`);
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`${ICON_SOURCES[source].label} 返回 HTTP ${response.status}`);
  return response.blob();
}

async function cacheIcon(source: IconSource, domain: string, blob: Blob): Promise<MediaAsset> {
  if (blob.size === 0) throw new Error(`${ICON_SOURCES[source].label} 返回空图标`);
  if (blob.size > MAX_ICON_BYTES) throw new Error(`${ICON_SOURCES[source].label} 返回的图标超过 256 KB`);
  if (!ALLOWED_ICON_TYPES.has(blob.type.toLowerCase())) {
    throw new Error(`${ICON_SOURCES[source].label} 返回了不支持的内容类型：${blob.type || '未知'}`);
  }

  const normalized = await normalizeIcon(blob);
  const asset: MediaAsset = {
    id: iconCacheId(source, domain),
    name: `${domain} (${source})`,
    type: normalized.type,
    kind: 'icon',
    size: normalized.size,
    importedAt: Date.now(),
    hash: `${source}:${domain}`,
    width: 64,
    height: 64,
    source,
    domain,
    blob: normalized,
  };
  try {
    await saveAsset(asset);
  } catch (error) {
    throw new Error(`图标已获取，但写入本地 IndexedDB 缓存失败：${errorMessage(error)}`);
  }
  return asset;
}

async function fetchBrowserIcon(pageUrl: string): Promise<Blob> {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.getURL) throw new Error('Chrome 内置图标接口仅在已加载的扩展页面中可用');
  const url = new URL(runtime.getURL('_favicon/'));
  url.searchParams.set('pageUrl', new URL(pageUrl).origin);
  url.searchParams.set('size', '64');
  const image = await loadImage(url.href);
  return rasterizeImage(image);
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
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图标响应不是可解码的图片'));
    image.src = source;
  });
}

async function rasterizeImage(image: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图标处理画布');
  context.drawImage(image, 0, 0, 64, 64);
  const normalized = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!normalized) throw new Error('图标转换为 PNG 失败');
  return normalized;
}

export async function clearIconCache(source?: IconSource): Promise<void> {
  const icons = await listAssets('icon');
  const targets = source ? icons.filter((asset) => asset.source === source) : icons;
  await Promise.all(targets.map((asset) => deleteAsset(asset.id)));
}

export async function purgeLegacyUploadedIcons(): Promise<void> {
  const icons = await listAssets('icon');
  const legacy = icons.filter((asset) => !asset.source);
  await Promise.all(legacy.map((asset) => deleteAsset(asset.id)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
