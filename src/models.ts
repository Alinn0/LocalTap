export type PlaybackMode = 'random' | 'order' | 'fixed';
export type MediaKind = 'image' | 'video' | 'scene' | 'icon';
export type IconSource = 'browser' | 'international' | 'domestic';
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
  iconSource: 'browser',
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
