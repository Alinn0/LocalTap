import { MediaAsset, MediaKind, WallpaperEngineEntry } from './models';

const DB_NAME = 'localtab-media';
const STORE_NAME = 'assets';
const PLAYLIST_STORE_NAME = 'playlist';
/** 旧版本用于保存目录句柄；保留仓库名以便打开已有数据库，但不再写入。 */
const HANDLE_STORE_NAME = 'handles';
const DB_VERSION = 2;
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
const HASH_CHUNK_SIZE = 4 * 1024 * 1024;
const PREVIEW_MAX_WIDTH = 320;
const PREVIEW_TIMEOUT_MS = 8000;

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PLAYLIST_STORE_NAME)) db.createObjectStore(PLAYLIST_STORE_NAME, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) db.createObjectStore(HANDLE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地媒体库'));
  });
  return databasePromise;
}

async function transaction<T>(operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return requestInStore(STORE_NAME, 'readwrite', operation);
}

async function requestInStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地媒体库操作失败'));
    tx.onabort = () => reject(tx.error ?? new Error('本地媒体库事务中断'));
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error('读取本地媒体库失败'));
  });
}

export async function listAssets(kind?: MediaKind): Promise<MediaAsset[]> {
  const all = await getAllFromStore<MediaAsset>(STORE_NAME);
  return kind ? all.filter((asset) => asset.kind === kind) : all;
}

export async function getAsset(id: string): Promise<MediaAsset | undefined> {
  return transaction((store) => store.get(id)) as Promise<MediaAsset | undefined>;
}

export async function saveAsset(asset: MediaAsset): Promise<void> {
  await transaction((store) => store.put(asset));
}

export async function deleteAsset(id: string): Promise<void> {
  await transaction((store) => store.delete(id));
}

export async function deleteAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('批量删除媒体失败'));
    tx.onabort = () => reject(tx.error ?? new Error('批量删除媒体事务中断'));
  });
}

export async function listPlaylistEntries(): Promise<WallpaperEngineEntry[]> {
  return getAllFromStore<WallpaperEngineEntry>(PLAYLIST_STORE_NAME);
}

export async function savePlaylistEntry(entry: WallpaperEngineEntry): Promise<void> {
  await requestInStore(PLAYLIST_STORE_NAME, 'readwrite', (store) => store.put(entry));
}

/**
 * 用新配置的路径替换播放列表，同时按路径 ID 保留已播时间与预览图。
 */
export async function replacePlaylistEntries(entries: WallpaperEngineEntry[]): Promise<WallpaperEngineEntry[]> {
  const previous = await listPlaylistEntries();
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  const merged = entries.map((entry) => {
    const old = previousById.get(entry.id);
    return old
      ? { ...entry, playedAt: old.playedAt, preview: old.preview }
      : entry;
  });
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
    const store = tx.objectStore(PLAYLIST_STORE_NAME);
    store.clear();
    for (const entry of merged) store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('保存 Wallpaper Engine 播放列表失败'));
    tx.onabort = () => reject(tx.error ?? new Error('保存 Wallpaper Engine 播放列表事务中断'));
  });
  return merged;
}

export async function clearPlaylistPlayed(): Promise<void> {
  const entries = await listPlaylistEntries();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
    const store = tx.objectStore(PLAYLIST_STORE_NAME);
    for (const entry of entries) {
      store.put({ ...entry, playedAt: undefined, preview: undefined });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('清除已播记录失败'));
    tx.onabort = () => reject(tx.error ?? new Error('清除已播记录事务中断'));
  });
}

export async function hashFile(file: Blob): Promise<string> {
  let state = new Uint8Array(32);
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_SIZE) {
    const chunk = new Uint8Array(await file.slice(offset, offset + HASH_CHUNK_SIZE).arrayBuffer());
    const input = new Uint8Array(state.length + chunk.length);
    input.set(state);
    input.set(chunk, state.length);
    state = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  }
  return [...state].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function inspectMedia(file: File): Promise<Omit<MediaAsset, 'id' | 'importedAt' | 'blob'>> {
  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.mpkg')) {
    throw new Error('Wallpaper Engine .mpkg（PKGM）暂不支持，请改用 .pkg 场景包。');
  }
  if (fileName.endsWith('.pkg')) {
    const header = new Uint8Array(await file.slice(0, 20).arrayBuffer());
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const magicLength = header.length >= 20 ? view.getUint32(0, true) : 0;
    const magic = magicLength >= 4 && magicLength <= 16 && header.length >= 4 + magicLength
      ? new TextDecoder().decode(header.subarray(4, 4 + magicLength))
      : '';
    if (!magic.startsWith('PKGV')) {
      throw new Error('不是 Wallpaper Engine scene.pkg：文件头不是 PKGV 魔数。');
    }
    return {
      name: file.name,
      type: 'application/vnd.wallpaper-engine.pkg',
      kind: 'scene',
      size: file.size,
      hash: await hashFile(file),
      width: 0,
      height: 0,
    };
  }

  if (!ALLOWED_MEDIA.has(file.type)) throw new Error('文件格式不支持，请选择 JPEG、PNG、WebP、MP4 或 WebM。');
  if (file.size === 0) throw new Error('文件为空。');

  const kind: MediaKind = file.type.startsWith('video/') ? 'video' : 'image';
  const url = URL.createObjectURL(file);
  try {
    const { width, height, duration } = await inspectDimensions(url, kind);
    const preview = kind === 'video' ? await captureVideoPreview(file).catch(() => undefined) : undefined;
    return {
      name: file.name,
      type: file.type,
      kind,
      size: file.size,
      hash: await hashFile(file),
      width,
      height,
      ...(duration === undefined ? {} : { duration }),
      ...(preview ? { preview } : {}),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 抽取视频第一帧并编码为 JPEG，用于设置中的壁纸列表预览；失败时返回 undefined，不阻断导入。
 */
export async function captureVideoPreview(source: Blob, maxWidth = PREVIEW_MAX_WIDTH): Promise<Blob | undefined> {
  const url = URL.createObjectURL(source);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await waitForFirstFrame(video, url);
    const { videoWidth: width, videoHeight: height } = video;
    if (!width || !height) return undefined;
    const scale = Math.min(1, maxWidth / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.72);
    });
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * 把图片等比缩放为小尺寸 JPEG，用于 Wallpaper Engine 播放列表的已播预览缓存。
 */
export async function captureImagePreview(source: Blob, maxWidth = PREVIEW_MAX_WIDTH): Promise<Blob | undefined> {
  const url = URL.createObjectURL(source);
  try {
    const image = await loadImage(url);
    if (!image.naturalWidth || !image.naturalHeight) return undefined;
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.75);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => reject(new Error('读取图片超时。')), PREVIEW_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('图片无法解码。'));
    };
    image.src = url;
  });
}

function waitForFirstFrame(video: HTMLVideoElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onFailed);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onFailed = () => finish(new Error('视频无法解码。'));
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onFailed, { once: true });
    timer = window.setTimeout(() => finish(new Error('读取视频首帧超时。')), PREVIEW_TIMEOUT_MS);
    video.src = url;
  });
}

function inspectDimensions(url: string, kind: MediaKind): Promise<{ width: number; height: number; duration?: number }> {
  return new Promise((resolve, reject) => {
    if (kind === 'image') {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('图片无法解码。'));
      image.src = url;
      return;
    }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve({
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
    });
    video.onerror = () => reject(new Error('视频无法读取或编码不受浏览器支持。'));
    video.src = url;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
