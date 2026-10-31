export type PlaybackMode = 'random' | 'order' | 'fixed';
export type MediaKind = 'image' | 'video' | 'scene' | 'icon';
export type IconSource = 'international' | 'domestic';
export type SearchEngineId = 'baidu' | 'google' | 'bing' | 'sogou' | 'so360' | 'duckduckgo' | 'yandex';
export type BackgroundSource = 'library' | 'wallpaper-engine';

export interface SearchEngineDefinition {
  id: SearchEngineId;
  label: string;
  urlTemplate: string;
}

export const SEARCH_ENGINES: SearchEngineDefinition[] = [
  { id: 'baidu', label: '百度', urlTemplate: 'https://www.baidu.com/s?wd=%s' },
  { id: 'google', label: 'Google', urlTemplate: 'https://www.google.com/search?q=%s' },
  { id: 'bing', label: '必应', urlTemplate: 'https://www.bing.com/search?q=%s' },
  { id: 'sogou', label: '搜狗', urlTemplate: 'https://www.sogou.com/web?query=%s' },
  { id: 'so360', label: '360 搜索', urlTemplate: 'https://www.so.com/s?q=%s' },
  { id: 'duckduckgo', label: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  { id: 'yandex', label: 'Yandex', urlTemplate: 'https://yandex.com/search/?text=%s' },
];

export function buildSearchUrl(engineId: SearchEngineId, query: string): string {
  const engine = SEARCH_ENGINES.find((item) => item.id === engineId) ?? SEARCH_ENGINES[0];
  return engine.urlTemplate.replace('%s', encodeURIComponent(query));
}

export function searchEngineLabel(engineId: SearchEngineId): string {
  return (SEARCH_ENGINES.find((item) => item.id === engineId) ?? SEARCH_ENGINES[0]).label;
}

export interface MediaAsset {
  id: string;
  name: string;
  type: string;
  kind: MediaKind;
  size: number;
  importedAt: number;
  hash: string;
  width: number;
  height: number;
  duration?: number;
  preview?: Blob;
  source?: IconSource;
  domain?: string;
  blob: Blob;
  /**
   * 直接从磁盘读取的地址（file://）。设置后播放时不再走 Blob，
   * 由浏览器流式读取，避免把上 GB 的视频一次性读进内存。
   */
  sourceUrl?: string;
}

export interface Shortcut {
  id: string;
  name: string;
  url: string;
}

export type WallpaperPropertyValue = boolean | number | string;

/** Wallpaper Engine 项目在 project.json 中声明的用户选项（可在本扩展中调整）。 */
export interface WallpaperUserProperty {
  name: string;
  label: string;
  type: string;
  value?: WallpaperPropertyValue;
  min?: number;
  max?: number;
  step?: number;
  fraction?: boolean;
  /** WE 的显示条件表达式；解析失败时按“可见”处理。 */
  condition?: string;
  options?: Array<{ label: string; value: string }>;
  order: number;
}

/** 从 `project.json` 提取的最小项目元数据，交给渲染引擎解析属性绑定。 */
export interface WallpaperProjectInfo {
  type: 'scene';
  file: string;
  title?: string;
  general: { properties: Record<string, Record<string, unknown>> };
}

export interface WallpaperEngineEntry {
  id: string;
  path: string;
  name: string;
  kind: Exclude<MediaKind, 'icon'>;
  profile: string;
  monitor: string;
  title?: string;
  previewFile?: string;
  previewFromProject?: boolean;
  playedAt?: number;
  preview?: Blob;
  /** 播放时确认文件不可用（不存在或无法解码）；随机池会跳过这些条目。 */
  missing?: boolean;
  /** 上次存在性检查时间（毫秒），用于避免重复扫描。 */
  checkedAt?: number;
  /** 用户从背景列表中移除；随机池与列表都跳过，重新导入配置后仍保持移除。 */
  removed?: boolean;
  /** 上次读取同目录 project.json 的时间；用于列表懒加载时避免重复读盘。 */
  metadataCheckedAt?: number;
  /** 上次尝试读取项目预览图的时间；预览图暂时读取失败时不会反复重试。 */
  previewCheckedAt?: number;
  /** project.json 中声明的用户选项（首次读取后缓存）。 */
  userProperties?: WallpaperUserProperty[];
  /** 供渲染引擎解析 `{user: ...}` 绑定的项目声明；缺失时用户选项只有脚本路径生效。 */
  projectInfo?: WallpaperProjectInfo;
  /** `config.json` 的 `wproperties` 里该壁纸的当前值（每次导入配置刷新）。 */
  configPropertyValues?: Record<string, WallpaperPropertyValue>;
  /** 用户在本扩展里调整过的选项值；优先于 `configPropertyValues`，并随条目持久化。 */
  propertyOverrides?: Record<string, WallpaperPropertyValue>;
  /** 上次读取用户选项的时间；用于兼容旧数据只补读一次。 */
  propertiesCheckedAt?: number;
  /** 项目声明（`projectInfo`）的解析版本；低于当前版本时会重新读取一次 project.json。 */
  projectInfoVersion?: number;
  /** 在配置文件播放列表中的顺序，用于列表展示。 */
  order?: number;
}

export interface AppSettings {
  shortcuts: Shortcut[];
  playbackMode: PlaybackMode;
  switchIntervalMinutes: number;
  currentMediaId: string | null;
  previousMediaId: string | null;
  backgroundSource: BackgroundSource;
  currentWallpaperEngineId: string | null;
  previousWallpaperEngineId: string | null;
  wallpaperConfigName: string;
  iconSource: IconSource;
  searchEngine: SearchEngineId;
  controlsCollapsed: boolean;
  mediaListCollapsed: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  shortcuts: [],
  playbackMode: 'random',
  switchIntervalMinutes: 30,
  currentMediaId: null,
  previousMediaId: null,
  backgroundSource: 'library',
  currentWallpaperEngineId: null,
  previousWallpaperEngineId: null,
  wallpaperConfigName: '',
  iconSource: 'domestic',
  searchEngine: 'baidu',
  controlsCollapsed: false,
  mediaListCollapsed: false,
};

export function isValidShortcutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
