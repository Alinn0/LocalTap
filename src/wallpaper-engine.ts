import { WallpaperEngineEntry } from './models';

export interface ParsedWallpaperConfig {
  entries: WallpaperEngineEntry[];
  profiles: string[];
  skipped: number;
  skippedWeb: number;
  skippedLooseScene: number;
  skippedOther: number;
}

/**
 * 从 Wallpaper Engine 配置中递归收集 playlist.items / playlists 里的媒体路径。
 * `project.json` 声明 `file: "scene.json"` 的松散工程按场景处理，播放时读取同目录 scene.pkg。
 */
export function parseWallpaperEngineConfig(raw: unknown): ParsedWallpaperConfig {
  const entries = new Map<string, WallpaperEngineEntry>();
  const profiles: string[] = [];
  const skippedPaths = new Set<string>();
  const webPaths = new Set<string>();
  const loosePaths = new Set<string>();
  if (!raw || typeof raw !== 'object') throw new Error('配置文件不是有效的 JSON 对象。');

  const collect = (value: unknown, profile: string, monitor: string): void => {
    if (typeof value === 'string') {
      const classification = classifyWallpaperPath(value);
      if (!classification) {
        if (!value.trim()) return;
        if (isWebWallpaperPath(value)) webPaths.add(normalizePath(value));
        else skippedPaths.add(normalizePath(value));
        return;
      }
      if (isLooseScenePath(value)) loosePaths.add(normalizePath(value));
      const id = playlistEntryId(value);
      if (entries.has(id)) return;
      entries.set(id, {
        id,
        path: value.replace(/\\/g, '/'),
        name: isLooseScenePath(value) ? 'scene.pkg' : fileNameFromPath(value),
        kind: classification,
        profile,
        monitor,
      });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, profile, monitor);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) collect(record.items, profile, monitor);
    for (const [key, child] of Object.entries(record)) {
      if (key === 'items' || key === 'settings' || key === 'name') continue;
      if (key.toLowerCase() === 'playlist' || key.toLowerCase() === 'playlists') {
        collect(child, profile, monitor);
      }
    }
  };

  for (const [profile, profileValue] of Object.entries(raw as Record<string, unknown>)) {
    if (profile.startsWith('?')) continue;
    profiles.push(profile);
    if (!profileValue || typeof profileValue !== 'object') continue;
    visitProfile(profileValue as Record<string, unknown>, profile, '', collect);
  }

  const skippedWeb = webPaths.size;
  const skippedLooseScene = loosePaths.size;
  return {
    entries: [...entries.values()],
    profiles,
    skipped: skippedPaths.size + skippedWeb,
    skippedWeb,
    skippedLooseScene,
    skippedOther: skippedPaths.size,
  };
}

function visitProfile(
  node: Record<string, unknown>,
  profile: string,
  monitor: string,
  collect: (value: unknown, profile: string, monitor: string) => void,
): void {
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase();
    if (lower === 'playlist' || lower === 'playlists') {
      collect(value, profile, monitor);
      continue;
    }
    if (lower.startsWith('monitor')) {
      visitObject(value, profile, key, collect);
      continue;
    }
    visitObject(value, profile, monitor, collect);
  }
}

function visitObject(
  value: unknown,
  profile: string,
  monitor: string,
  collect: (value: unknown, profile: string, monitor: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visitObject(item, profile, monitor, collect);
    return;
  }
  if (!value || typeof value !== 'object') return;
  visitProfile(value as Record<string, unknown>, profile, monitor, collect);
}

export function classifyWallpaperPath(path: string): WallpaperEngineEntry['kind'] | undefined {
  const extension = extensionOf(path);
  if (extension === 'pkg') return 'scene';
  if (extension === 'mp4' || extension === 'webm') return 'video';
  if (extension === 'jpg' || extension === 'jpeg' || extension === 'png' || extension === 'webp') return 'image';
  if (isLooseScenePath(path)) return 'scene';
  return undefined;
}

/** 松散场景工程：config 里写的是 `.../scene.json`，实际播放时同目录的 scene.pkg。 */
export function isLooseScenePath(path: string): boolean {
  return /\/scene\.json$/i.test(path.replace(/\\/g, '/'));
}

/** 网页壁纸：config 里写的是 `index.html`，当前版本不渲染。 */
export function isWebWallpaperPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** 把配置里的路径换成实际要读取的媒体文件（scene.json → scene.pkg）。 */
export function mediaPathForEntry(path: string): string {
  return isLooseScenePath(path) ? siblingPath(path, 'scene.pkg') : path;
}

export function playlistEntryId(path: string): string {
  return `we:${normalizePath(path)}`;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * 同目录下的伴随文件路径（如 pkg 旁边的 project.json 或项目预览图）。
 */
export function siblingPath(path: string, fileName: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? fileName : `${normalized.slice(0, slash)}/${fileName}`;
}

export interface ProjectMetadata {
  title?: string;
  preview?: string;
}

/** 直接按绝对路径读取本地文件的通道（file:// 协议）。 */
export type DirectFileReader = (path: string) => Promise<Blob | undefined>;

export function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return encodeURI(`file:///${normalized}`);
}

/**
 * 在扩展页面里按绝对路径读取本地文件。需要用户在 chrome://extensions 为本扩展
 * 打开“允许访问文件网址”，以及 manifest 的 `file:///*` 主机权限。
 * Chrome 不允许 fetch() 读取 file://，因此使用 XHR 获取字节。
 */
export function readLocalFileViaProtocol(path: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const url = toFileUrl(path);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.onload = () => {
      const blob = xhr.response as Blob | null;
      if (!blob || blob.size === 0) {
        reject(new Error('读取结果为空，可能未开启“允许访问文件网址”。'));
        return;
      }
      const name = fileNameFromPath(path);
      const type = blob.type || mimeForPlaylistKind(classifyWallpaperPath(path) ?? 'image', name);
      resolve(new File([blob], name, { type }));
    };
    xhr.onerror = () => reject(new Error('浏览器拒绝了本地文件访问（需开启“允许访问文件网址”）。'));
    xhr.ontimeout = () => reject(new Error('读取本地文件超时。'));
    xhr.send();
  });
}

/**
 * 解析 Wallpaper Engine 项目目录中的 project.json，读取项目名与项目预览图文件名。
 * 预览图只接受同目录内的纯文件名，避免路径穿越。
 */
export function parseProjectMetadata(raw: unknown): ProjectMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : '';
  const preview = typeof record.preview === 'string' ? record.preview.trim() : '';
  const previewName = preview && !/[/\\]/.test(preview) && preview !== '.' && preview !== '..' && preview.length <= 120
    ? preview
    : '';
  return {
    ...(title ? { title } : {}),
    ...(previewName ? { preview: previewName } : {}),
  };
}

/**
 * 读取与媒体文件同目录的 project.json；缺失或格式错误时返回 undefined，不影响播放。
 */
export async function readProjectMetadata(
  mediaPath: string,
  read: DirectFileReader = readFileQuietly,
): Promise<ProjectMetadata | undefined> {
  try {
    const source = await read(siblingPath(mediaPath, 'project.json'));
    if (!source || source.size > 512 * 1024) return undefined;
    return parseProjectMetadata(JSON.parse(await source.text()));
  } catch {
    return undefined;
  }
}

/**
 * 读取项目目录中的预览图（preview.jpg / preview.gif 等），用于已播背景列表缩略图。
 */
export async function readProjectPreview(
  mediaPath: string,
  previewName: string | undefined,
  read: DirectFileReader = readFileQuietly,
): Promise<Blob | undefined> {
  if (!previewName) return undefined;
  if (!/\.(?:gif|jpe?g|png|webp)$/i.test(previewName)) return undefined;
  const blob = await read(siblingPath(mediaPath, previewName));
  if (!blob || blob.size === 0 || blob.size > 8 * 1024 * 1024) return undefined;
  return blob;
}

/** 读取失败时静默返回 undefined，供项目信息等可选文件使用。 */
async function readFileQuietly(path: string): Promise<Blob | undefined> {
  try {
    return await readLocalFileViaProtocol(path);
  } catch {
    return undefined;
  }
}

export function mimeForPlaylistKind(kind: WallpaperEngineEntry['kind'], fileName: string): string {
  if (kind === 'scene') return 'application/vnd.wallpaper-engine.pkg';
  const extension = extensionOf(fileName);
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}
