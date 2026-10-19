import { AppSettings, DEFAULT_SETTINGS, SEARCH_ENGINES } from './models';

const SETTINGS_KEY = 'localtab.settings.v1';

export async function loadSettings(): Promise<AppSettings> {
  if (globalThis.chrome?.storage?.local) {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  }

  const serialized = localStorage.getItem(SETTINGS_KEY);
  return normalizeSettings(serialized ? JSON.parse(serialized) : undefined);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  if (globalThis.chrome?.storage?.local) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return;
  }

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_SETTINGS);
  const candidate = value as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...candidate,
    shortcuts: Array.isArray(candidate.shortcuts) ? candidate.shortcuts.slice(0, 18) : [],
    playbackMode: ['random', 'order', 'fixed'].includes(candidate.playbackMode ?? '')
      ? candidate.playbackMode!
      : DEFAULT_SETTINGS.playbackMode,
    switchIntervalMinutes: Number.isInteger(candidate.switchIntervalMinutes) && candidate.switchIntervalMinutes! >= 1 && candidate.switchIntervalMinutes! <= 1440
      ? candidate.switchIntervalMinutes!
      : DEFAULT_SETTINGS.switchIntervalMinutes,
    backgroundSource: candidate.backgroundSource === 'wallpaper-engine' ? 'wallpaper-engine' : 'library',
    currentWallpaperEngineId: typeof candidate.currentWallpaperEngineId === 'string' ? candidate.currentWallpaperEngineId : null,
    previousWallpaperEngineId: typeof candidate.previousWallpaperEngineId === 'string' ? candidate.previousWallpaperEngineId : null,
    wallpaperConfigName: typeof candidate.wallpaperConfigName === 'string' ? candidate.wallpaperConfigName.slice(0, 200) : '',
    iconSource: candidate.iconSource === 'browser' || candidate.iconSource === 'international' || candidate.iconSource === 'domestic'
      ? candidate.iconSource
      : DEFAULT_SETTINGS.iconSource,
    searchEngine: SEARCH_ENGINES.some((engine) => engine.id === candidate.searchEngine)
      ? candidate.searchEngine!
      : DEFAULT_SETTINGS.searchEngine,
    controlsCollapsed: candidate.controlsCollapsed === true,
    mediaListCollapsed: candidate.mediaListCollapsed === true,
  };
}
