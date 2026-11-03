import { WallpaperEngineEntry, WallpaperProjectInfo, WallpaperPropertyValue, WallpaperUserProperty } from './models';

export interface ParsedWallpaperConfig {
  entries: WallpaperEngineEntry[];
  /** 实际读取的用户节点名（config.json 的顶层键）。 */
  user: string;
  /** 因不属于当前用户而忽略的顶层节点。 */
  ignoredUsers: string[];
  /** `wproperties`：路径 → 显示器 → 该壁纸的用户选项当前值。 */
  propertyValues: WallpaperPropertyOverrides;
  /** 配置里的 `?installdirectory`，用于推导配置文件自身所在的绝对路径。 */
  installDirectory?: string;
  skipped: number;
  skippedWeb: number;
  skippedLooseScene: number;
  skippedOther: number;
}

/** 规范化路径 → 显示器 → 属性名 → 值。 */
export type WallpaperPropertyOverrides = Record<string, Record<string, Record<string, WallpaperPropertyValue>>>;

/**
 * 从 Wallpaper Engine 配置中递归收集 playlist.items / playlists 里的媒体路径。
 * `project.json` 声明 `file: "scene.json"` 的松散工程按场景处理，播放时读取同目录 scene.pkg。
 */
export function parseWallpaperEngineConfig(raw: unknown): ParsedWallpaperConfig {
  const entries = new Map<string, WallpaperEngineEntry>();
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
        order: entries.size,
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

  const selected = selectCurrentUserNode(raw as Record<string, unknown>);
  visitProfile(selected.node, selected.name, '', collect);

  const skippedWeb = webPaths.size;
  const skippedLooseScene = loosePaths.size;
  return {
    entries: [...entries.values()],
    user: selected.name,
    ignoredUsers: selected.ignored,
    propertyValues: readPropertyValues(selected.node),
    ...(readInstallDirectory(raw) ? { installDirectory: readInstallDirectory(raw) } : {}),
    skipped: skippedPaths.size + skippedWeb,
    skippedWeb,
    skippedLooseScene,
    skippedOther: skippedPaths.size,
  };
}

/**
 * 读取配置里的 `?installdirectory`（Wallpaper Engine 安装目录）。
 * 配置文件本身就在该目录下，因此可用它推导出 `config.json` 的绝对路径。
 */
export function readInstallDirectory(raw: unknown): string | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== '?installdirectory') continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (trimmed) return trimmed.slice(0, 400);
  }
  return undefined;
}

/** 由安装目录推导配置文件路径；没有安装目录信息时返回 undefined。 */
export function configPathFromInstallDirectory(installDirectory: string | undefined): string | undefined {
  if (!installDirectory) return undefined;
  return `${installDirectory.replace(/\\/g, '/').replace(/\/+$/, '')}/config.json`;
}

/** 读取当前用户节点里的 `wproperties`（壁纸用户选项的当前值）。 */
function readPropertyValues(node: Record<string, unknown>): WallpaperPropertyOverrides {
  const raw = asRecord(node.wproperties);
  const result: WallpaperPropertyOverrides = {};
  if (!raw) return result;
  for (const [path, monitors] of Object.entries(raw)) {
    const monitorMap = asRecord(monitors);
    if (!monitorMap) continue;
    const bucket: Record<string, Record<string, WallpaperPropertyValue>> = {};
    for (const [monitor, values] of Object.entries(monitorMap)) {
      const props = asRecord(values);
      if (!props) continue;
      const flat: Record<string, WallpaperPropertyValue> = {};
      for (const [name, value] of Object.entries(props)) {
        const sanitized = sanitizePropertyValue(value);
        if (sanitized !== undefined) flat[name] = sanitized;
      }
      if (Object.keys(flat).length) bucket[monitor] = flat;
    }
    if (Object.keys(bucket).length) result[normalizePath(path)] = bucket;
  }
  return result;
}

/** 取某条壁纸的用户选项当前值：优先该显示器，否则合并该壁纸所有显示器的值。 */
export function propertyOverridesFor(
  values: WallpaperPropertyOverrides,
  path: string,
  monitor: string,
): Record<string, WallpaperPropertyValue> | undefined {
  const bucket = values[normalizePath(path)];
  if (!bucket) return undefined;
  if (monitor && bucket[monitor]) return bucket[monitor];
  const merged: Record<string, WallpaperPropertyValue> = {};
  for (const entry of Object.values(bucket)) Object.assign(merged, entry);
  return Object.keys(merged).length ? merged : undefined;
}

function sanitizePropertyValue(value: unknown): WallpaperPropertyValue | undefined {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

const DEFAULT_USER_KEY = 'defaultuser100000';

/**
 * Wallpaper Engine 的 config.json 顶层按 Windows 用户保存多份配置，
 * 另外还有 `?installdirectory` 元数据和 `defaultuser100000` 默认模板。
 * 扩展拿不到系统用户名，因此只选一个“当前用户”节点：优先含
 * `general.wallpaperconfig`（正在使用的壁纸配置）且数据最完整的节点，
 * 跳过元数据键与默认模板，避免把其他用户的播放列表混进来。
 */
export function selectCurrentUserNode(raw: Record<string, unknown>): { name: string; node: Record<string, unknown>; ignored: string[] } {
  const ignored: string[] = [];
  const candidates: Array<{ name: string; node: Record<string, unknown>; score: number }> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (name.startsWith('?')) continue;
    if (name.toLowerCase() === DEFAULT_USER_KEY) {
      ignored.push(name);
      continue;
    }
    const node = value as Record<string, unknown>;
    candidates.push({ name, node, score: userNodeScore(node) });
  }
  if (!candidates.length) {
    // 兼容旧格式或直接传入单个用户节点的配置。
    return { name: '', node: raw, ignored };
  }
  candidates.sort((a, b) => b.score - a.score);
  ignored.push(...candidates.slice(1).map((candidate) => candidate.name));
  return { name: candidates[0].name, node: candidates[0].node, ignored };
}

function userNodeScore(node: Record<string, unknown>): number {
  const general = asRecord(node.general);
  const config = asRecord(general?.wallpaperconfig);
  let score = 0;
  if (asRecord(general?.user)) score += 10;
  if (config) score += 1000;
  const selected = asRecord(config?.selectedwallpapers);
  if (selected && Object.keys(selected).length) score += 500;
  const properties = asRecord(node.wproperties);
  if (properties) score += Math.min(100, Object.keys(properties).length);
  return score;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
  properties?: WallpaperUserProperty[];
  /** 交给渲染引擎的项目声明（含未在界面上展示的选项）。 */
  projectInfo?: WallpaperProjectInfo;
}

/**
 * 可编辑的用户选项类型。其余类型（group/label/Text/directory/usershortcut 等）
 * 只是 WE 客户端里的排版与说明元素，不作为可编辑项展示。
 */
const DISPLAYABLE_PROPERTY_TYPES = new Set(['bool', 'color', 'slider', 'combo', 'textinput']);

/** WE 自身的保留选项：不属于壁纸内容，不展示（配色主题、音量等由 WE 客户端处理）。 */
const RESERVED_PROPERTY_NAMES = new Set(['schemecolor', 'volume', '_imgdir', 'imgdir', 'reset']);

/** 解析 `project.json` 的 `general.properties`，得到用户选项声明（已清洗文本、限制长度）。 */
export function parseProjectProperties(raw: unknown): WallpaperUserProperty[] | undefined {
  const record = asRecord(raw);
  const general = asRecord(record?.general);
  const properties = asRecord(general?.properties);
  if (!properties) return undefined;
  const result: WallpaperUserProperty[] = [];
  for (const [name, rawDecl] of Object.entries(properties)) {
    const decl = asRecord(rawDecl);
    if (!decl) continue;
    const type = typeof decl.type === 'string' ? decl.type.trim().toLowerCase() : '';
    if (!DISPLAYABLE_PROPERTY_TYPES.has(type)) continue;
    if (RESERVED_PROPERTY_NAMES.has(name.toLowerCase())) continue;
    const condition = typeof decl.condition === 'string' ? decl.condition.trim().slice(0, 500) : '';
    // `condition: "false"` 是 WE 用来隐藏历史遗留选项的约定。
    if (condition.toLowerCase() === 'false') continue;
    const property: WallpaperUserProperty = {
      name: name.slice(0, 120),
      label: propertyLabel(name, decl.text),
      type,
      order: typeof decl.order === 'number' && Number.isFinite(decl.order) ? decl.order : Number.MAX_SAFE_INTEGER,
    };
    if (condition) property.condition = condition;
    const value = sanitizePropertyValue(decl.value);
    if (value !== undefined) property.value = value;
    if (typeof decl.min === 'number' && Number.isFinite(decl.min)) property.min = decl.min;
    if (typeof decl.max === 'number' && Number.isFinite(decl.max)) property.max = decl.max;
    if (typeof decl.step === 'number' && Number.isFinite(decl.step) && decl.step > 0) property.step = decl.step;
    if (decl.fraction === true) property.fraction = true;
    if (Array.isArray(decl.options)) {
      const options = decl.options
        .map((option) => {
          const item = asRecord(option);
          const optionValue = sanitizePropertyValue(item?.value);
          if (optionValue === undefined) return undefined;
          const optionLabel = cleanPropertyText(item?.label) || String(optionValue);
          return { label: optionLabel, value: String(optionValue) };
        })
        .filter((option): option is { label: string; value: string } => Boolean(option))
        .slice(0, 64);
      if (options.length) property.options = options;
    }
    result.push(property);
  }
  if (!result.length) return undefined;
  return result.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

function propertyLabel(name: string, text: unknown): string {
  const cleaned = cleanPropertyText(text);
  if (!cleaned) return name;
  // `ui_*` 是 WE 的本地化键（原文交给客户端翻译），没有译文时用属性名更可读。
  if (/^ui_/.test(cleaned)) return name;
  return cleaned;
}

/** 去掉项目里的 HTML 片段与实体，只留纯文本（界面用 textContent 渲染，避免注入）。 */
function cleanPropertyText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z#0-9]+;/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
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
 * 解析 Wallpaper Engine 项目目录中的 project.json，读取项目名、项目预览图文件名与用户选项声明。
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
  const properties = parseProjectProperties(record);
  const projectInfo = buildProjectInfo(record);
  return {
    ...(title ? { title } : {}),
    ...(previewName ? { preview: previewName } : {}),
    ...(properties ? { properties } : {}),
    ...(projectInfo ? { projectInfo } : {}),
  };
}

/** 声明字段上限：只保留渲染与条件求值用得到的部分，避免把整份 project.json 存进 IndexedDB。 */
const PROJECT_DECL_FIELDS = ['type', 'value', 'min', 'max', 'step', 'precision', 'fraction', 'options', 'order', 'condition'] as const;
const MAX_PROJECT_DECLARATIONS = 400;

/**
 * 生成渲染引擎需要的项目声明。
 * WebWallGL 只有在 `project.general.properties` 里有属性声明时，才会把
 * `setProperties()` 推来的值写回 scene.json 的 `{user: ...}` 绑定；
 * 只有值没有声明时只会更新脚本环境，画面不会变。
 */
export function buildProjectInfo(raw: unknown): WallpaperProjectInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const general = asRecord(record.general);
  const properties = asRecord(general?.properties);
  if (!properties) return undefined;
  const declarations: Record<string, Record<string, unknown>> = {};
  let count = 0;
  for (const [name, rawDecl] of Object.entries(properties)) {
    if (count >= MAX_PROJECT_DECLARATIONS) break;
    const decl = asRecord(rawDecl);
    if (!decl) continue;
    const entry: Record<string, unknown> = {};
    for (const field of PROJECT_DECL_FIELDS) {
      const value = decl[field];
      if (value === undefined) continue;
      if (field === 'type') {
        if (typeof value === 'string' && value.trim()) entry.type = value.trim().toLowerCase();
      } else if (field === 'options') {
        const options = Array.isArray(value)
          ? value
            .map((option) => {
              const item = asRecord(option);
              if (!item) return undefined;
              const optionValue = sanitizePropertyValue(item.value);
              if (optionValue === undefined) return undefined;
              return { label: cleanPropertyText(item.label) || String(optionValue), value: String(optionValue) };
            })
            .filter((option): option is { label: string; value: string } => Boolean(option))
            .slice(0, 64)
          : [];
        if (options.length) entry.options = options;
      } else if (field === 'condition') {
        if (typeof value === 'string' && value.trim()) entry.condition = value.trim().slice(0, 500);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        entry[field] = value;
      } else if (typeof value === 'boolean') {
        entry[field] = value;
      } else if (typeof value === 'string') {
        entry[field] = value.slice(0, 200);
      }
    }
    if (!entry.type) continue;
    declarations[name.slice(0, 120)] = entry;
    count += 1;
  }
  if (!count) return undefined;
  const file = typeof record.file === 'string' && /\.json$/i.test(record.file.trim())
    ? record.file.trim().replace(/^\.?\//, '').slice(0, 200)
    : 'scene.json';
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : undefined;
  return {
    type: 'scene',
    file,
    ...(title ? { title } : {}),
    general: { properties: declarations },
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
 * 读取项目目录中的预览图（preview.jpg / preview.gif 等），用于背景列表缩略图。
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
