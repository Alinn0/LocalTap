import { AppSettings, BackgroundSource, DEFAULT_SETTINGS, IconSource, MediaAsset, PlaybackMode, SEARCH_ENGINES, SearchEngineId, Shortcut, WallpaperEngineEntry, WallpaperPropertyValue, WallpaperUserProperty, buildSearchUrl, isValidShortcutUrl, searchEngineLabel } from './models';
import { captureImagePreview, captureVideoPreview, clearPlaylistPlayed, deleteAsset, deleteAssets, formatBytes, inspectMedia, listAssets, listPlaylistEntries, loadConfigFileHandle, removePlaylistEntry, replacePlaylistEntries, restoreRemovedPlaylistEntries, saveAsset, saveConfigFileHandle, savePlaylistEntry } from './media-db';
import { ICON_SOURCES, clearIconCache, fetchAndCacheIcon, getCachedIcon, hasIconPermission, iconCacheId, normalizedDomain, purgeLegacyUploadedIcons, requestIconPermission } from './icon-resolver';
import { loadSettings, saveSettings } from './storage';
import { configPathFromInstallDirectory, mediaPathForEntry, mimeForPlaylistKind, parseWallpaperEngineConfig, propertyOverridesFor, readLocalFileViaProtocol, readProjectMetadata, readProjectPreview, toFileUrl } from './wallpaper-engine';
import './style.css';

const BACKUP_SCHEMA_VERSION = 3;

const $ = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`找不到页面元素：${id}`);
  return element as T;
};

const settingsToggle = $('settings-toggle') as HTMLButtonElement;
const settingsPanel = $('settings-panel') as HTMLElement;
const settingsClose = $('settings-close') as HTMLButtonElement;
const mediaInput = $('media-input') as HTMLInputElement;
const folderInput = $('folder-input') as HTMLInputElement;
const mediaList = $('media-list') as HTMLDivElement;
const dropzone = $('dropzone') as HTMLLabelElement;
const clearMediaButton = $('clear-media') as HTMLButtonElement;
const shortcutsRoot = $('shortcuts') as HTMLDivElement;
const searchForm = $('search-form') as HTMLFormElement;
const shortcutManager = $('shortcut-manager') as HTMLDivElement;
const shortcutDialog = $('shortcut-dialog') as HTMLDialogElement;
const mediaConflictDialog = $('media-conflict-dialog') as HTMLDialogElement;
const shortcutForm = $('shortcut-form') as HTMLFormElement;
const toast = $('toast') as HTMLDivElement;
const wallpaperBar = $('wallpaper-bar') as HTMLElement;
const toggleControls = $('toggle-controls') as HTMLButtonElement;
const mediaListHeading = $('media-list-heading') as HTMLDivElement;
const toggleMediaList = $('toggle-media-list') as HTMLButtonElement;
const mediaSearch = $('media-search') as HTMLInputElement;
const mediaListCount = $('media-list-count') as HTMLSpanElement;
const mediaListEmpty = $('media-list-empty') as HTMLParagraphElement;
const importStatus = $('import-status') as HTMLParagraphElement;
const backgroundSourceSelect = $('background-source') as HTMLSelectElement;
const libraryControls = $('library-controls') as HTMLDivElement;
const weControls = $('we-controls') as HTMLDivElement;
const weConfigInput = $('we-config-input') as HTMLInputElement;
const refreshWeConfigButton = $('refresh-we-config') as HTMLButtonElement;
const weStatus = $('we-status') as HTMLParagraphElement;
const weRandomButton = $('we-random') as HTMLButtonElement;
const clearWePlayedButton = $('clear-we-played') as HTMLButtonElement;
const restoreWeRemovedButton = $('we-restore-removed') as HTMLButtonElement;
const wePropertiesDialog = $('we-properties-dialog') as HTMLDialogElement;
const wePropertiesTitle = $('we-properties-title') as HTMLElement;
const wePropertiesNote = $('we-properties-note') as HTMLParagraphElement;
const wePropertiesList = $('we-properties-list') as HTMLDivElement;

let settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
let media: MediaAsset[] = [];
let mediaImportQueue: Promise<void> = Promise.resolve();
let activeObjectUrl: string | undefined;
let mediaPreviewUrls: string[] = [];
let toastTimer: number | undefined;
let importStatusTimer: number | undefined;
let autoSwitchTimer: number | undefined;
let renderAttempt = 0;
let dragShortcutId: string | undefined;
let sceneRendererFrame: HTMLIFrameElement | undefined;
let sceneRendererToken: string | undefined;
let sceneRendererSent = false;
let sceneRendererPaused = false;
let scenePointerState = { u: 0.5, v: 0.5, buttons: 0, mods: 0 };
let scenePointerKnown = false;
let playlistEntries: WallpaperEngineEntry[] = [];
let currentWeAsset: MediaAsset | undefined;
let weLoadToken = 0;
let mediaListEmptyShouldShow = false;
let directReadState: 'unknown' | 'ok' | 'failed' = 'unknown';
let lastDirectPath: string | undefined;
/** 用户上次选择的 WE 配置文件句柄：用于“下次默认打开同一目录”与“刷新重读”。 */
let configFileHandle: FileSystemFileHandle | undefined;
/** Chrome 的“允许访问文件网址”开关状态；undefined 表示当前环境无法查询。 */
let fileSchemeAllowed: boolean | undefined;
const wePreviewJobs = new Set<string>();
/** 播放列表缩略图懒加载：并发上限与可视区队列。 */
const WE_THUMB_CONCURRENCY = 3;
const weThumbQueue: string[] = [];
const weThumbQueued = new Set<string>();
const weRowElements = new Map<string, HTMLElement>();
let weThumbActive = 0;
let weThumbObserver: IntersectionObserver | undefined;

type SceneRendererResponse =
  | { type: 'renderer-ready' }
  | { type: 'scene-ready'; token: string }
  | { type: 'scene-error' | 'scene-preview-error'; token: string; message: string }
  | { type: 'scene-preview'; token: string; bytes: ArrayBuffer };

/**
 * 查询 Chrome 的“允许访问文件网址”开关。
 * 这是扩展 API，不受页面 origin 限制；预览环境没有该 API 时返回 undefined。
 */
async function queryFileSchemeAllowed(): Promise<boolean | undefined> {
  type FileAccessApi = ((callback?: (allowed: boolean) => void) => Promise<boolean> | void);
  const api = (globalThis as { chrome?: { extension?: { isAllowedFileSchemeAccess?: FileAccessApi } } })
    .chrome?.extension?.isAllowedFileSchemeAccess;
  if (typeof api !== 'function') return undefined;
  try {
    const result = api();
    if (result && typeof (result as Promise<boolean>).then === 'function') {
      return await (result as Promise<boolean>);
    }
  } catch {
    // 某些版本只接受回调形式，继续走下面的回调路径。
  }
  return new Promise<boolean | undefined>((resolve) => {
    try {
      api((allowed) => resolve(Boolean(allowed)));
    } catch {
      resolve(undefined);
    }
  });
}

async function refreshFileSchemeState(): Promise<void> {
  fileSchemeAllowed = await queryFileSchemeAllowed();
  if (fileSchemeAllowed === false) directReadState = 'failed';
}

async function start(): Promise<void> {
  try {
    settings = await loadSettings();
    media = (await listAssets()).filter((asset) => asset.kind !== 'icon');
    playlistEntries = await listPlaylistEntries();
    configFileHandle = await loadConfigFileHandle().catch(() => undefined);
    await purgeLegacyUploadedIcons();
    // 先确认“允许访问文件网址”开关与小文件可读性，避免首帧渲染前误显示提示。
    if (settings.backgroundSource === 'wallpaper-engine' && playlistEntries.length && IS_EXTENSION_CONTEXT) {
      await refreshFileSchemeState();
      if (fileSchemeAllowed !== false) await probeChannelWithSmallFile();
    }
    await pickMediaOnStartup();
    setupEvents();
    applySettingsToControls();
    renderAll();
    if (settings.backgroundSource === 'wallpaper-engine' && playlistEntries.length > 0 && !currentWeAsset) {
      notify(localFileHint());
    }
    window.setTimeout(() => void backfillVideoPreviews(), 0);
  } catch (error) {
    notify(`LocalTab 启动失败：${errorMessage(error)}`);
  }
}

/**
 * 为本次改动前导入、尚无首帧预览的视频补齐缩略图；串行执行以免同时解码多个视频。
 */
async function backfillVideoPreviews(): Promise<void> {
  const pending = media.filter((item) => item.kind === 'video' && !item.preview);
  let updated = false;
  for (const item of pending) {
    const preview = await captureVideoPreview(item.blob).catch(() => undefined);
    if (!preview) continue;
    const updatedAsset = { ...item, preview };
    try {
      await saveAsset(updatedAsset);
    } catch (error) {
      console.warn(`保存视频首帧预览失败：${errorMessage(error)}`);
      continue;
    }
    const index = media.findIndex((entry) => entry.id === item.id);
    if (index >= 0) media[index] = updatedAsset;
    updated = true;
  }
  if (updated) renderMediaList();
}

async function pickMediaOnStartup(): Promise<void> {
  if (settings.backgroundSource === 'wallpaper-engine') {
    if (playlistEntries.length === 0) {
      settings.currentWallpaperEngineId = null;
      return;
    }
    const entry = chooseRandomWallpaperEngineEntry();
    if (!entry) return;
    settings.currentWallpaperEngineId = entry.id;
    settings.previousWallpaperEngineId = null;
    await loadWallpaperEngineAsset(entry.id, { silent: true });
    await persist();
    return;
  }

  if (media.length === 0) {
    settings.currentMediaId = null;
    return;
  }
  if (settings.playbackMode === 'fixed' && media.some((item) => item.id === settings.currentMediaId)) return;

  if (settings.playbackMode === 'order' && settings.currentMediaId) {
    const currentIndex = media.findIndex((item) => item.id === settings.currentMediaId);
    settings.currentMediaId = media[(currentIndex + 1) % media.length].id;
  } else {
    settings.currentMediaId = chooseRandomMedia()?.id ?? media[0].id;
  }
  settings.previousMediaId = null;
  await persist();
}

function setupEvents(): void {
  const isHighlightTarget = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('.search, .shortcut-tile') !== null;

  document.addEventListener('pointerover', (event) => {
    if (isHighlightTarget(event.target)) {
      document.body.classList.remove('interaction-dismissed');
      document.body.classList.add('interaction-hover');
    }
  });
  document.addEventListener('pointerout', (event) => {
    if (isHighlightTarget(event.target) && !isHighlightTarget(event.relatedTarget)) {
      document.body.classList.remove('interaction-hover');
      document.body.classList.remove('interaction-dismissed');
    }
  });
  window.addEventListener('message', (event: MessageEvent<SceneRendererResponse>) => {
    void handleSceneRendererMessage(event);
  });
  document.addEventListener('focusin', (event) => {
    if (isHighlightTarget(event.target)) document.body.classList.add('interaction-focus');
  });
  document.addEventListener('focusout', (event) => {
    if (isHighlightTarget(event.target) && !isHighlightTarget(event.relatedTarget)) {
      document.body.classList.remove('interaction-focus');
    }
  });
  window.addEventListener('pointermove', (event) => {
    if (!updateScenePointerPosition(event)) return;
    postScenePointer();
  }, { passive: true });
  window.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isScenePointerBlocked(event.target)) return;
    if (!updateScenePointerPosition(event)) return;
    scenePointerState.buttons |= 1;
    document.body.classList.add('scene-pointer-active');
    event.preventDefault();
    postScenePointer();
  });
  window.addEventListener('pointerup', (event) => {
    if (event.button !== 0) return;
    if (sceneRendererFrame) updateScenePointerPosition(event);
    releaseScenePointerButton();
  });
  window.addEventListener('pointercancel', releaseScenePointerButton);
  window.addEventListener('blur', leaveScenePointer);
  document.addEventListener('mouseleave', leaveScenePointer);
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!settingsPanel.hidden && !settingsPanel.contains(target) && !target.closest('#settings-toggle')) {
      setPanelOpen(false);
    }
    if (target.closest('.shortcut-tile')) {
      document.body.classList.remove('interaction-pinned', 'interaction-hover', 'interaction-focus');
      document.body.classList.add('interaction-dismissed');
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    if (target.closest('.search')) {
      document.body.classList.add('interaction-pinned');
      return;
    }
    if (target.closest('.hero') || target.matches('.page') || target === document.body) {
      document.body.classList.remove('interaction-pinned');
      if (document.activeElement instanceof HTMLElement && isHighlightTarget(document.activeElement)) {
        document.activeElement.blur();
      }
    }
  });

  settingsToggle.addEventListener('click', () => setPanelOpen(settingsPanel.hidden));
  settingsClose.addEventListener('click', () => setPanelOpen(false));
  $('scroll-top').addEventListener('click', scrollSettingsToTop);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !shortcutDialog.open && !settingsPanel.hidden) {
      setPanelOpen(false);
      settingsToggle.focus();
    }
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = ($('search-input') as HTMLInputElement).value.trim();
    if (query) window.location.assign(buildSearchUrl(settings.searchEngine, query));
  });

  mediaInput.addEventListener('change', () => {
    queueMediaImport(Array.from(mediaInput.files ?? []));
    mediaInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    const files = Array.from(folderInput.files ?? []);
    const supportedFiles = files.filter(isSupportedMediaCandidate);
    const skippedCount = files.length - supportedFiles.length;
    queueMediaImport(supportedFiles, { folderImport: true, unsupportedCount: skippedCount });
    folderInput.value = '';
  });
  $('choose-folder').addEventListener('click', () => folderInput.click());
  clearMediaButton.addEventListener('click', () => void clearAllMedia());
  backgroundSourceSelect.addEventListener('change', () => {
    settings.backgroundSource = backgroundSourceSelect.value as BackgroundSource;
    mediaSearch.value = '';
    currentWeAsset = undefined;
    if (settings.backgroundSource === 'wallpaper-engine') {
      void enterWallpaperEngineMode();
    }
    void persist();
    renderAll();
  });
  $('choose-we-config').addEventListener('click', () => void pickWallpaperEngineConfig());
  weConfigInput.addEventListener('change', () => {
    if (weConfigInput.files?.[0]) void importWallpaperEngineConfig(weConfigInput.files[0]);
    weConfigInput.value = '';
  });
  refreshWeConfigButton.addEventListener('click', () => void refreshWallpaperEngineConfig());
  weRandomButton.addEventListener('click', () => void playRandomWallpaperEngineEntry({ reason: 'manual' }));
  $('we-probe').addEventListener('click', () => void probeDirectFileAccess());
  clearWePlayedButton.addEventListener('click', () => void clearPlayedWallpaperEngineEntries());
  restoreWeRemovedButton.addEventListener('click', () => void restoreRemovedWallpaperEngineEntries());
  $('we-properties-close').addEventListener('click', () => wePropertiesDialog.close());
  $('we-properties-done').addEventListener('click', () => wePropertiesDialog.close());
  $('we-properties-reset').addEventListener('click', () => void resetWallpaperEngineProperties());
  mediaConflictDialog.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[value]');
    if (button) mediaConflictDialog.close(button.value);
  });
  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
      if (eventName === 'drop') {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        queueMediaImport(files);
      }
    });
  }
  mediaList.addEventListener('click', (event) => void handleMediaAction(event));
  mediaSearch.addEventListener('input', () => renderMediaList());
  $('playback-mode').addEventListener('change', (event) => {
    settings.playbackMode = (event.currentTarget as HTMLSelectElement).value as PlaybackMode;
    applyPlaybackIntervalState();
    scheduleAutomaticSwitch();
    void persist();
  });
  $('switch-interval').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.valueAsNumber;
    if (!Number.isInteger(value) || value < 1 || value > 1440) {
      input.value = String(settings.switchIntervalMinutes);
      notify('自动切换间隔请输入 1 到 1440 之间的整数分钟。');
      return;
    }
    settings.switchIntervalMinutes = value;
    scheduleAutomaticSwitch();
    void persist();
  });
  $('previous-media').addEventListener('click', () => void stepMedia(-1));
  $('next-media').addEventListener('click', () => void stepMedia(1));
  $('toggle-playback').addEventListener('click', togglePlayback);
  toggleControls.addEventListener('click', () => {
    settings.controlsCollapsed = !settings.controlsCollapsed;
    applyControlsCollapsed();
    void persist();
  });
  toggleMediaList.addEventListener('click', () => {
    settings.mediaListCollapsed = !settings.mediaListCollapsed;
    applyMediaListCollapsed();
    void persist();
  });
  $('add-shortcut').addEventListener('click', () => openShortcutEditor());
  $('icon-source').addEventListener('change', (event) => {
    const select = event.currentTarget as HTMLSelectElement;
    settings.iconSource = select.value === 'international' ? 'international' : 'domestic';
    void changeIconSource();
  });
  $('search-engine').addEventListener('change', (event) => {
    const select = event.currentTarget as HTMLSelectElement;
    settings.searchEngine = select.value as SearchEngineId;
    void persist();
    applySearchPlaceholder();
    notify(`搜索将使用：${searchEngineLabel(settings.searchEngine)}`);
  });
  $('refresh-icons').addEventListener('click', () => {
    void refreshIcons();
  });
  shortcutManager.addEventListener('click', (event) => void handleShortcutManagerAction(event));
  shortcutManager.addEventListener('dragstart', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-shortcut-id]');
    if (!row) return;
    dragShortcutId = row.dataset.shortcutId;
    event.dataTransfer?.setData('text/plain', dragShortcutId ?? '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  shortcutManager.addEventListener('dragover', (event) => {
    if ((event.target as HTMLElement).closest('[data-shortcut-id]')) event.preventDefault();
  });
  shortcutManager.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-shortcut-id]');
    const targetId = target?.dataset.shortcutId;
    if (dragShortcutId && targetId && dragShortcutId !== targetId) reorderShortcut(dragShortcutId, targetId);
    dragShortcutId = undefined;
  });
  shortcutManager.addEventListener('dragend', () => {
    dragShortcutId = undefined;
  });
  shortcutForm.addEventListener('submit', (event) => void submitShortcut(event));
  $('dialog-close').addEventListener('click', closeShortcutEditor);
  $('cancel-edit').addEventListener('click', closeShortcutEditor);
  $('export-backup').addEventListener('click', () => void exportBackup());
  $('import-backup').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.[0]) void importBackup(input.files[0]);
    input.value = '';
  });
}

function setPanelOpen(open: boolean): void {
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
  if (open) settingsClose.focus();
}

/** 回到设置面板最顶上（面板是页面里唯一可滚动的区域）。 */
function scrollSettingsToTop(): void {
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  settingsPanel.scrollTo({ top: 0, behavior });
}

function applySettingsToControls(): void {
  const searchEngineSelect = $('search-engine') as HTMLSelectElement;
  if (!searchEngineSelect.options.length) {
    for (const engine of SEARCH_ENGINES) {
      const option = document.createElement('option');
      option.value = engine.id;
      option.textContent = engine.label;
      searchEngineSelect.append(option);
    }
  }
  searchEngineSelect.value = settings.searchEngine;
  ($('icon-source') as HTMLSelectElement).value = settings.iconSource;
  ($('playback-mode') as HTMLSelectElement).value = settings.playbackMode;
  ($('switch-interval') as HTMLInputElement).value = String(settings.switchIntervalMinutes);
  backgroundSourceSelect.value = settings.backgroundSource;
  applyPlaybackIntervalState();
  applySearchPlaceholder();
  applyControlsCollapsed();
  applyBackgroundSource();
  applyMediaListCollapsed();
}

function applyControlsCollapsed(): void {
  wallpaperBar.classList.toggle('collapsed', settings.controlsCollapsed);
  toggleControls.setAttribute('aria-expanded', String(!settings.controlsCollapsed));
  toggleControls.setAttribute('aria-label', settings.controlsCollapsed ? '展开壁纸控制栏' : '折叠壁纸控制栏');
}

function applyPlaybackIntervalState(): void {
  ($('switch-interval') as HTMLInputElement).disabled = settings.playbackMode === 'fixed';
}

function scheduleAutomaticSwitch(): void {
  if (autoSwitchTimer !== undefined) {
    window.clearTimeout(autoSwitchTimer);
    autoSwitchTimer = undefined;
  }
  if (settings.playbackMode === 'fixed' || activePoolSize() < 2) return;
  if (settings.backgroundSource === 'wallpaper-engine') {
    const currentId = settings.currentWallpaperEngineId;
    if (!currentId) return;
    autoSwitchTimer = window.setTimeout(() => {
      autoSwitchTimer = undefined;
      if (settings.currentWallpaperEngineId !== currentId) return;
      void playRandomWallpaperEngineEntry({ reason: 'auto' });
    }, settings.switchIntervalMinutes * 60_000);
    return;
  }
  if (!settings.currentMediaId) return;

  const currentId = settings.currentMediaId;
  autoSwitchTimer = window.setTimeout(() => {
    autoSwitchTimer = undefined;
    if (settings.currentMediaId !== currentId) return;
    const currentIndex = media.findIndex((item) => item.id === currentId);
    const next = settings.playbackMode === 'order'
      ? media[(currentIndex + 1) % media.length]
      : chooseRandomMedia();
    if (!next || next.id === currentId) return;
    settings.previousMediaId = currentId;
    settings.currentMediaId = next.id;
    renderAll();
    void persist();
  }, settings.switchIntervalMinutes * 60_000);
}

function applySearchPlaceholder(): void {
  const input = $('search-input') as HTMLInputElement;
  input.placeholder = `使用${searchEngineLabel(settings.searchEngine)}搜索，按 Enter`;
  input.setAttribute('aria-label', input.placeholder);
}

function applyBackgroundSource(): void {
  const isWallpaperEngine = settings.backgroundSource === 'wallpaper-engine';
  libraryControls.hidden = isWallpaperEngine;
  weControls.hidden = !isWallpaperEngine;
  backgroundSourceSelect.value = settings.backgroundSource;
  mediaSearch.placeholder = isWallpaperEngine ? '搜索背景' : '搜索已导入壁纸';
  mediaSearch.setAttribute('aria-label', mediaSearch.placeholder);
  updateWeStatus();
}

function applyMediaListCollapsed(): void {
  const hasMedia = settings.backgroundSource === 'wallpaper-engine'
    ? playlistEntries.length > 0
    : media.length > 0;
  mediaListHeading.hidden = !hasMedia;
  mediaSearch.hidden = !hasMedia || settings.mediaListCollapsed;
  mediaList.hidden = !hasMedia || settings.mediaListCollapsed;
  mediaListEmpty.hidden = !mediaListEmptyShouldShow || mediaList.hidden;
  toggleMediaList.textContent = settings.mediaListCollapsed ? '展开' : '折叠';
  toggleMediaList.setAttribute('aria-expanded', String(!settings.mediaListCollapsed));
  toggleMediaList.setAttribute('aria-label', settings.mediaListCollapsed
    ? (settings.backgroundSource === 'wallpaper-engine' ? '展开背景列表' : '展开壁纸列表')
    : (settings.backgroundSource === 'wallpaper-engine' ? '折叠背景列表' : '折叠壁纸列表'));
}

function updateWeStatus(): void {
  const active = playlistEntries.filter((entry) => !entry.removed);
  const played = playedWallpaperEngineEntries();
  const removedCount = playlistEntries.length - active.length;
  weRandomButton.disabled = active.length === 0;
  clearWePlayedButton.disabled = played.length === 0;
  // 记住过配置文件（句柄或路径）才有东西可刷新。
  refreshWeConfigButton.disabled = !(configFileHandle || settings.wallpaperConfigPath || settings.wallpaperConfigName);
  restoreWeRemovedButton.hidden = removedCount === 0;
  restoreWeRemovedButton.disabled = removedCount === 0;
  restoreWeRemovedButton.textContent = `恢复已移除（${removedCount}）`;
  if (settings.backgroundSource !== 'wallpaper-engine') {
    weStatus.hidden = true;
    return;
  }
  if (playlistEntries.length === 0) {
    weStatus.hidden = false;
    const saved = settings.wallpaperConfigPath || settings.wallpaperConfigName;
    weStatus.textContent = saved
      ? `尚未读取背景列表。上次的配置：${saved}，可点击“刷新壁纸列表”重新读取，或“选择 WE 配置”换一个文件。`
      : '尚未读取 Wallpaper Engine 配置。点击“选择 WE 配置”读取 config.json 中的 playlist.items 地址。';
    return;
  }
  if (active.length === 0) {
    weStatus.hidden = false;
    weStatus.textContent = `全部 ${playlistEntries.length} 项背景都已被移除，点击“恢复已移除”可以找回。`;
    return;
  }
  // 只有确认“读不到文件”时才提示，避免每开一个标签页都显示授权说明。
  if (!IS_EXTENSION_CONTEXT) {
    weStatus.hidden = false;
    weStatus.textContent = '当前是开发预览页面（http 地址），浏览器禁止网页读取本地文件；请在已加载的扩展新标签页中查看真实效果。';
    return;
  }
  weStatus.hidden = directReadState !== 'failed';
  if (weStatus.hidden) return;
  const neededPath = wallpaperEngineRelativeRoot();
  const needed = neededPath ? `（需要读取 ${neededPath}）` : '';
  if (fileSchemeAllowed === false) {
    weStatus.textContent = `Chrome 的“允许访问文件网址”当前是关闭的${needed}：请在 chrome://extensions 打开本扩展的详情页勾选该项，然后点击“获取权限”确认。`;
    return;
  }
  weStatus.textContent = `读不到本地背景文件${needed}。若已在 chrome://extensions 打开本扩展的“允许访问文件网址”，请点击“获取权限”重新确认一次。`;
}

async function persist(): Promise<void> {
  try {
    await saveSettings(settings);
  } catch (error) {
    notify(`保存设置失败：${errorMessage(error)}`);
  }
}

function renderAll(): void {
  applyBackgroundSource();
  renderMediaList();
  renderShortcuts();
  renderShortcutManager();
  renderBackdrop();
  renderPlaybackStatus();
}

function renderMediaList(): void {
  mediaPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaPreviewUrls = [];
  mediaList.replaceChildren();
  disconnectWallpaperEngineThumbnails();
  if (settings.backgroundSource === 'wallpaper-engine') {
    renderWallpaperEngineList();
    return;
  }
  const total = media.reduce((sum, item) => sum + item.size, 0);
  $('media-count').textContent = media.length
    ? `${media.length} 项 · ${formatBytes(total)}`
    : '尚未导入媒体';
  clearMediaButton.disabled = media.length === 0;
  const query = mediaSearch.value.trim().toLocaleLowerCase();
  const visible = query ? media.filter((item) => item.name.toLocaleLowerCase().includes(query)) : media;
  mediaListCount.textContent = query
    ? `壁纸列表（${visible.length} / ${media.length} 项）`
    : `壁纸列表（共 ${media.length} 项）`;
  mediaListEmptyShouldShow = visible.length === 0 && media.length > 0;
  mediaListEmpty.hidden = !mediaListEmptyShouldShow;
  for (const item of visible) {
    const row = document.createElement('div');
    row.className = 'media-row';
    const preview = document.createElement('div');
    preview.className = 'media-preview';
    const previewBlob = item.kind === 'image' ? item.blob : item.preview;
    if (previewBlob) {
      const previewUrl = URL.createObjectURL(previewBlob);
      mediaPreviewUrls.push(previewUrl);
      preview.style.backgroundImage = `url("${previewUrl}")`;
    } else if (item.kind === 'scene') {
      preview.textContent = '◈';
    } else {
      preview.textContent = '▶';
    }
    const info = document.createElement('div');
    info.className = 'item-info';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const detail = document.createElement('small');
    const kindLabel = item.kind === 'video' ? '视频' : item.kind === 'scene' ? '场景包' : '图片';
    detail.textContent = `${kindLabel} · ${formatBytes(item.size)}`;
    info.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const play = createButton(item.id === settings.currentMediaId ? '✓' : '▶', '播放这张壁纸', 'media-play');
    play.dataset.id = item.id;
    const remove = createButton('×', `删除 ${item.name}`, 'media-delete');
    remove.dataset.id = item.id;
    actions.append(play, remove);
    row.append(preview, info, actions);
    mediaList.append(row);
  }
  applyMediaListCollapsed();
}

function renderWallpaperEngineList(): void {
  // 显示配置中的全部播放列表条目；当前播放的排在最前，缩略图只对可视区的行按需读取。
  const active = playlistEntries.filter((entry) => !entry.removed);
  const removedCount = playlistEntries.length - active.length;
  const total = active.length;
  const missing = active.filter((entry) => entry.missing).length;
  const playedCount = active.filter((entry) => entry.playedAt).length;
  $('media-count').textContent = total
    ? `播放列表 ${total} 项 · 可用 ${total - missing} 项 · 已播 ${playedCount} 项${missing ? ` · 已跳过 ${missing} 项` : ''}${removedCount ? ` · 已移除 ${removedCount} 项` : ''}`
    : '尚未读取 Wallpaper Engine 配置';
  const currentId = settings.currentWallpaperEngineId;
  const ordered = active
    .slice()
    .sort((a, b) => {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  const query = mediaSearch.value.trim().toLocaleLowerCase();
  const visible = query
    ? ordered.filter((entry) =>
      (entry.title ?? '').toLocaleLowerCase().includes(query) ||
      entry.name.toLocaleLowerCase().includes(query))
    : ordered;
  mediaListCount.textContent = query
    ? `背景列表（${visible.length} / ${total} 项）`
    : `背景列表（共 ${total} 项）`;
  mediaListEmpty.textContent = total
    ? '没有匹配的背景。'
    : playlistEntries.length ? '所有背景都已移除，可点击“恢复已移除”找回。' : '尚未读取 Wallpaper Engine 配置。';
  mediaListEmptyShouldShow = visible.length === 0;
  mediaListEmpty.hidden = !mediaListEmptyShouldShow;
  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = 'media-row';
    row.dataset.entryId = entry.id;
    if (entry.missing) row.classList.add('media-row-missing');
    const preview = document.createElement('div');
    preview.className = 'media-preview';
    if (!entry.preview) preview.textContent = entry.kind === 'scene' ? '◈' : entry.kind === 'video' ? '▶' : '▧';
    const info = document.createElement('div');
    info.className = 'item-info';
    const displayName = wallpaperEngineDisplayName(entry);
    const name = document.createElement('strong');
    name.textContent = displayName;
    const detail = document.createElement('small');
    detail.textContent = wallpaperEngineDetailText(entry);
    info.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const play = createButton(entry.id === settings.currentWallpaperEngineId ? '✓' : '▶', `播放 ${displayName}`, 'media-play');
    play.dataset.playlistId = entry.id;
    const remove = createButton('×', `从背景列表移除 ${displayName}`, 'media-delete');
    remove.dataset.playlistId = entry.id;
    actions.append(play);
    if (hasEditableProperties(entry)) actions.append(createPropertiesButton(entry));
    actions.append(remove);
    row.append(preview, info, actions);
    mediaList.append(row);
    weRowElements.set(entry.id, row);
    if (entry.preview) applyWallpaperEngineRowPreview(row, entry.preview);
  }
  observeWallpaperEngineThumbnails();
  applyMediaListCollapsed();
}

/**
 * 该场景包是否可配置。所有场景包都提供内置的“显示位置”滑块，
 * 声明了用户选项的还会额外列出这些选项。
 */
function hasEditableProperties(entry: WallpaperEngineEntry): boolean {
  return entry.kind === 'scene';
}

function createPropertiesButton(entry: WallpaperEngineEntry): HTMLButtonElement {
  const button = createButton('⚙', `配置 ${wallpaperEngineDisplayName(entry)}`, 'media-properties');
  button.dataset.playlistId = entry.id;
  return button;
}

function wallpaperEngineDetailText(entry: WallpaperEngineEntry): string {
  const kindLabel = entry.kind === 'video' ? '视频' : entry.kind === 'scene' ? '场景包' : '图片';
  const state = entry.missing ? '文件缺失' : entry.playedAt ? '已播放' : '未播放';
  const fileName = entry.name === wallpaperEngineDisplayName(entry) ? '' : entry.name;
  return [kindLabel, state, fileName].filter(Boolean).join(' · ');
}

function applyWallpaperEngineRowPreview(row: HTMLElement, preview: Blob): void {
  const container = row.querySelector<HTMLElement>('.media-preview');
  if (!container) return;
  const previous = row.dataset.previewUrl;
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(preview);
  row.dataset.previewUrl = url;
  mediaPreviewUrls.push(url);
  container.textContent = '';
  container.style.backgroundImage = `url("${url}")`;
}

function updateWallpaperEngineRow(entry: WallpaperEngineEntry): void {
  const row = weRowElements.get(entry.id);
  if (!row) return;
  const displayName = wallpaperEngineDisplayName(entry);
  const name = row.querySelector('.item-info strong');
  if (name) name.textContent = displayName;
  const detail = row.querySelector('.item-info small');
  if (detail) detail.textContent = wallpaperEngineDetailText(entry);
  const play = row.querySelector<HTMLButtonElement>('button.media-play');
  play?.setAttribute('aria-label', `播放 ${displayName}`);
  const remove = row.querySelector<HTMLButtonElement>('button.media-delete');
  remove?.setAttribute('aria-label', `从背景列表移除 ${displayName}`);
  syncWallpaperEngineRowActions(row, entry);
  if (entry.preview) applyWallpaperEngineRowPreview(row, entry.preview);
}

/** 元数据是懒加载的，读到用户选项后即时补上或去掉“配置”按钮。 */
function syncWallpaperEngineRowActions(row: HTMLElement, entry: WallpaperEngineEntry): void {
  const actions = row.querySelector<HTMLElement>('.item-actions');
  if (!actions) return;
  const existing = actions.querySelector<HTMLButtonElement>('button.media-properties');
  if (!hasEditableProperties(entry)) {
    existing?.remove();
    return;
  }
  if (!existing) {
    const remove = actions.querySelector('button.media-delete');
    actions.insertBefore(createPropertiesButton(entry), remove ?? null);
    return;
  }
  existing.dataset.playlistId = entry.id;
  existing.setAttribute('aria-label', `配置 ${wallpaperEngineDisplayName(entry)}`);
}

function disconnectWallpaperEngineThumbnails(): void {
  weThumbObserver?.disconnect();
  weThumbObserver = undefined;
  weThumbQueue.length = 0;
  weThumbQueued.clear();
  weRowElements.clear();
}

function observeWallpaperEngineThumbnails(): void {
  if (typeof IntersectionObserver !== 'function') {
    for (const entryId of weRowElements.keys()) enqueueWallpaperEngineThumbnail(entryId);
    return;
  }
  // 不做预加载：只有真正进入可视区的行才读 project.json 与预览图。
  const observer = new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      observer.unobserve(record.target);
      const entryId = (record.target as HTMLElement).dataset.entryId;
      if (entryId) enqueueWallpaperEngineThumbnail(entryId);
    }
  });
  for (const row of weRowElements.values()) observer.observe(row);
  weThumbObserver = observer;
}

function enqueueWallpaperEngineThumbnail(entryId: string): void {
  if (weThumbQueued.has(entryId)) return;
  const entry = playlistEntries.find((item) => item.id === entryId);
  if (!entry) return;
  // 已有预览且项目信息也读过时无事可做；否则至少要读一次 project.json（决定是否显示“配置”按钮）。
  const needMetadata = !entry.metadataCheckedAt;
  const needPreview = !entry.preview && Boolean(entry.previewFile) && !entry.previewCheckedAt;
  if (!needMetadata && !needPreview) return;
  if (!IS_EXTENSION_CONTEXT || directReadState === 'failed' || fileSchemeAllowed === false) return;
  weThumbQueued.add(entryId);
  weThumbQueue.push(entryId);
  pumpWallpaperEngineThumbnails();
}

function pumpWallpaperEngineThumbnails(): void {
  while (weThumbActive < WE_THUMB_CONCURRENCY && weThumbQueue.length) {
    const entryId = weThumbQueue.shift();
    if (!entryId) return;
    weThumbActive += 1;
    void loadWallpaperEngineThumbnail(entryId)
      .catch((error: unknown) => console.warn(`读取背景缩略图失败：${errorMessage(error)}`))
      .finally(() => {
        weThumbActive -= 1;
        weThumbQueued.delete(entryId);
        pumpWallpaperEngineThumbnails();
      });
  }
}

/**
 * 懒加载单个条目的项目名与预览图：只读取同目录的小文件（project.json、
 * 预览图），不读取媒体本体；结果按条目缓存，重新渲染时不会重复读盘。
 */
async function loadWallpaperEngineThumbnail(entryId: string): Promise<void> {
  let entry = await ensureWallpaperEngineMetadata(entryId);
  if (!entry || !entry.previewFile || entry.previewCheckedAt) return;
  const index = playlistEntries.findIndex((item) => item.id === entryId);
  if (index < 0) return;
  const file = await readProjectPreview(entry.path, entry.previewFile, directFileReader);
  const thumbnail = file ? await captureImagePreview(file) : undefined;
  entry = {
    ...entry,
    previewCheckedAt: Date.now(),
    ...(thumbnail ? { preview: thumbnail, previewFromProject: true } : {}),
  };
  playlistEntries[index] = entry;
  try {
    await savePlaylistEntry(entry);
  } catch (error) {
    console.warn(`保存背景缩略图失败：${errorMessage(error)}`);
  }
  updateWallpaperEngineRow(entry);
}

/**
 * 读取同目录 project.json 以补齐背景名称与用户选项；每个条目只读一次。
 * `force` 用于右键查看用户选项时重试此前读取失败的条目。
 */
const PROJECT_INFO_VERSION = 2;

async function ensureWallpaperEngineMetadata(entryId: string, force = false): Promise<WallpaperEngineEntry | undefined> {
  const index = playlistEntries.findIndex((item) => item.id === entryId);
  if (index < 0) return undefined;
  const entry = playlistEntries[index];
  if (!force && entry.metadataCheckedAt && entry.propertiesCheckedAt
    && entry.projectInfoVersion === PROJECT_INFO_VERSION) {
    return entry;
  }
  const metadata = await readProjectMetadata(entry.path, directFileReader);
  const updated: WallpaperEngineEntry = {
    ...entry,
    metadataCheckedAt: Date.now(),
    ...(metadata ? { propertiesCheckedAt: Date.now(), projectInfoVersion: PROJECT_INFO_VERSION } : {}),
    ...(metadata?.title ? { title: metadata.title } : {}),
    ...(metadata?.preview ? { previewFile: metadata.preview } : {}),
    ...(metadata?.properties ? { userProperties: metadata.properties } : {}),
    ...(metadata?.projectInfo ? { projectInfo: metadata.projectInfo } : {}),
  };
  playlistEntries[index] = updated;
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    console.warn(`保存背景信息失败：${errorMessage(error)}`);
  }
  updateWallpaperEngineRow(updated);
  renderWallpaperName();
  return updated;
}

let propertyDialogEntryId: string | undefined;
let propertyDialogRows: Array<{ row: HTMLElement; property: WallpaperUserProperty }> = [];

/** 打开某条场景包的用户选项（由行内“配置”按钮触发）。 */
async function showWallpaperEngineProperties(entryId: string): Promise<void> {
  let entry = await ensureWallpaperEngineMetadata(entryId);
  if (!entry) return;
  // 之前读取失败或版本较旧（缺少项目声明）时，打开对话框再读一次。
  if ((!entry.userProperties?.length || entry.projectInfoVersion !== PROJECT_INFO_VERSION)
    && IS_EXTENSION_CONTEXT && directReadState !== 'failed') {
    entry = (await ensureWallpaperEngineMetadata(entryId, true)) ?? entry;
  }
  propertyDialogEntryId = entry.id;
  propertyDialogRows = [];
  wePropertiesTitle.textContent = wallpaperEngineDisplayName(entry);
  wePropertiesList.replaceChildren();
  const properties = (entry.userProperties ?? []).filter((property) => !isReservedProperty(property));
  wePropertiesNote.hidden = false;
  // 内置的“显示位置”对所有场景包可用：内容比屏幕大时用它修正取景。
  for (const row of renderViewOffsetRows(entry)) wePropertiesList.append(row);
  if (!properties.length) {
    const canRead = IS_EXTENSION_CONTEXT && directReadState !== 'failed' && fileSchemeAllowed !== false;
    const known = entry.propertiesCheckedAt !== undefined;
    if (canRead && known) {
      wePropertiesNote.textContent = '该场景包没有声明额外选项，可调整“水平位置 / 垂直位置”来修正画面取景。';
      if (!wePropertiesDialog.open) wePropertiesDialog.showModal();
      $('we-properties-reset').hidden = !entry.viewOffsetX && !entry.viewOffsetY;
      return;
    }
    wePropertiesNote.hidden = true;
    wePropertiesList.append(createEmptyPropertiesHint());
    if (!wePropertiesDialog.open) wePropertiesDialog.showModal();
    $('we-properties-reset').hidden = !entry.viewOffsetX && !entry.viewOffsetY;
    return;
  }
  {
    const customized = properties.filter((property) => entry.propertyOverrides?.[property.name] !== undefined).length;
    const position = entry.viewOffsetX || entry.viewOffsetY ? '，画面位置已调整' : '';
    wePropertiesNote.textContent = customized
      ? `${properties.length} 项壁纸选项，其中 ${customized} 项已由你调整（蓝色标出）${position}。改动会立即生效并保存在本机，不修改壁纸文件。`
      : `${properties.length} 项壁纸选项，另有水平和垂直位置滑块${position}。调整后立即生效并保存在本机，不修改壁纸文件。`;
    for (const property of properties) {
      const row = renderPropertyRow(entry, property);
      propertyDialogRows.push({ row, property });
      wePropertiesList.append(row);
    }
    applyPropertyConditions(entry);
  }
  if (!wePropertiesDialog.open) wePropertiesDialog.showModal();
  $('we-properties-reset').hidden = (!entry.propertyOverrides || !Object.keys(entry.propertyOverrides).length)
    && !entry.viewOffsetX && !entry.viewOffsetY;
}

/**
 * 内置“显示位置”滑块（X 水平 / Y 垂直）：-100 显示左（上）侧，0 居中，100 显示右（下）侧。
 * Wallpaper Engine 客户端只能调 X，这里两轴都给。
 */
function renderViewOffsetRows(entry: WallpaperEngineEntry): HTMLElement[] {
  return [
    createViewOffsetRow(entry, 'x', '水平位置', entry.viewOffsetX ?? 0),
    createViewOffsetRow(entry, 'y', '垂直位置', entry.viewOffsetY ?? 0),
  ];
}

function createViewOffsetRow(
  entry: WallpaperEngineEntry,
  axis: 'x' | 'y',
  labelText: string,
  value: number,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'property-row';
  const name = document.createElement('div');
  name.className = 'property-name';
  const label = document.createElement('strong');
  label.textContent = labelText;
  const meta = document.createElement('small');
  meta.textContent = '画面比屏幕大时用来修正取景';
  name.append(label, meta);
  const cell = document.createElement('div');
  cell.className = 'property-value';
  const wrapper = document.createElement('div');
  wrapper.className = 'property-slider';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '-100';
  input.max = '100';
  input.step = '1';
  input.value = String(value);
  input.dataset.viewOffset = `${entry.id}:${axis}`;
  input.setAttribute('aria-label', `${labelText} ${viewOffsetLabel(axis, value)}`);
  const output = document.createElement('span');
  output.textContent = viewOffsetLabel(axis, value);
  input.addEventListener('input', () => {
    output.textContent = viewOffsetLabel(axis, Number(input.value));
    input.setAttribute('aria-label', `${labelText} ${output.textContent}`);
  });
  input.addEventListener('change', () => {
    void applyViewOffsetChange(entry.id, axis, Number(input.value));
  });
  wrapper.append(input, output);
  cell.append(wrapper);
  row.classList.toggle('is-custom', value !== 0);
  row.append(name, cell);
  return row;
}

function viewOffsetLabel(axis: 'x' | 'y', value: number): string {
  if (!value) return '居中';
  if (axis === 'x') return value > 0 ? `右 ${value}` : `左 ${Math.abs(value)}`;
  return value > 0 ? `下 ${value}` : `上 ${Math.abs(value)}`;
}

async function applyViewOffsetChange(entryId: string, axis: 'x' | 'y', value: number): Promise<void> {
  const index = playlistEntries.findIndex((item) => item.id === entryId);
  if (index < 0) return;
  const offset = Math.max(-100, Math.min(100, Math.round(value)));
  const updated: WallpaperEngineEntry = axis === 'x'
    ? { ...playlistEntries[index], viewOffsetX: offset === 0 ? undefined : offset }
    : { ...playlistEntries[index], viewOffsetY: offset === 0 ? undefined : offset };
  playlistEntries[index] = updated;
  const row = wePropertiesList.querySelector<HTMLElement>(
    `[data-view-offset="${CSS.escape(`${entryId}:${axis}`)}"]`,
  )?.closest('.property-row');
  row?.classList.toggle('is-custom', offset !== 0);
  $('we-properties-reset').hidden = (!updated.propertyOverrides || !Object.keys(updated.propertyOverrides).length)
    && !updated.viewOffsetX && !updated.viewOffsetY;
  if (settings.currentWallpaperEngineId === updated.id) applySceneView(updated);
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    notify(`保存画面位置失败：${errorMessage(error)}`);
  }
}

/** 把画面位置（X / Y）推给正在播放的场景。 */
function applySceneView(entry: WallpaperEngineEntry): void {
  const frame = sceneRendererFrame;
  const token = sceneRendererToken;
  if (!frame?.contentWindow || !token) return;
  frame.contentWindow.postMessage({
    type: 'view',
    token,
    x: entry.viewOffsetX ?? 0,
    y: entry.viewOffsetY ?? 0,
  }, '*');
}

/** WE 的保留项（配色主题、音量等）不在壁纸内容里，不展示。 */
function isReservedProperty(property: WallpaperUserProperty): boolean {
  const name = property.name.toLowerCase();
  return name === 'schemecolor' || name === 'volume' || name === '_imgdir' || name === 'imgdir';
}

/** 选项当前生效值：用户调整 > config.json 记录 > 壁纸默认值。 */
function effectivePropertyValue(entry: WallpaperEngineEntry, property: WallpaperUserProperty): WallpaperPropertyValue | undefined {
  const override = entry.propertyOverrides?.[property.name];
  if (override !== undefined) return override;
  const fromConfig = entry.configPropertyValues?.[property.name];
  if (fromConfig !== undefined) return fromConfig;
  return property.value;
}

/** 汇总要送给渲染器的属性表（只包含该壁纸声明过的选项）。 */
function effectiveProperties(entry: WallpaperEngineEntry): Record<string, WallpaperPropertyValue> {
  const result: Record<string, WallpaperPropertyValue> = {};
  for (const property of entry.userProperties ?? []) {
    const value = effectivePropertyValue(entry, property);
    if (value !== undefined) result[property.name] = value;
  }
  return result;
}

/** WE 的 `condition` 只支持简单比较；解析不了就当可见，避免误藏选项。 */
function evaluatePropertyCondition(condition: string | undefined, entry: WallpaperEngineEntry): boolean {
  if (!condition) return true;
  const text = condition.trim();
  if (!text) return true;
  if (text.toLowerCase() === 'false') return false;
  if (text.toLowerCase() === 'true') return true;
  const orParts = splitTopLevel(text, '||');
  if (orParts.length > 1) return orParts.some((part) => evaluatePropertyCondition(part, entry));
  const andParts = splitTopLevel(text, '&&');
  if (andParts.length > 1) return andParts.every((part) => evaluatePropertyCondition(part, entry));
  if (text.startsWith('(') && text.endsWith(')')) return evaluatePropertyCondition(text.slice(1, -1), entry);
  const match = /^([a-z0-9_*.\-]+?)\.value\s*(==|!=|>=|<=|>|<)\s*(.+)$/i.exec(text);
  if (!match) return true;
  const [, name, operator, rawLiteral] = match;
  const property = (entry.userProperties ?? []).find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!property) return true;
  const actual = effectivePropertyValue(entry, property);
  const literal = parseConditionLiteral(rawLiteral);
  if (literal === undefined) return true;
  if (operator === '==' || operator === '!=') {
    const equal = comparePropertyValues(actual, literal);
    return operator === '==' ? equal : !equal;
  }
  const left = typeof actual === 'number' ? actual : Number(actual);
  const right = typeof literal === 'number' ? literal : Number(literal);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
  if (operator === '>') return left > right;
  if (operator === '<') return left < right;
  if (operator === '>=') return left >= right;
  return left <= right;
}

function splitTopLevel(text: string, separator: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(start, index));
      index += separator.length - 1;
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseConditionLiteral(raw: string): WallpaperPropertyValue | undefined {
  const text = raw.trim();
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^['"](.*)['"]$/.exec(text);
  if (quoted) return quoted[1];
  return undefined;
}

function comparePropertyValues(actual: WallpaperPropertyValue | undefined, literal: WallpaperPropertyValue): boolean {
  if (actual === undefined) return false;
  if (typeof actual === 'boolean' || typeof literal === 'boolean') {
    return String(actual) === String(literal);
  }
  if (typeof actual === 'number' || typeof literal === 'number') {
    const left = Number(actual);
    const right = Number(literal);
    if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
  }
  return String(actual) === String(literal);
}

function applyPropertyConditions(entry: WallpaperEngineEntry): void {
  for (const { row, property } of propertyDialogRows) {
    row.hidden = !evaluatePropertyCondition(property.condition, entry);
  }
}

function createEmptyPropertiesHint(): HTMLElement {
  const hint = document.createElement('p');
  hint.className = 'source-note';
  hint.textContent = !IS_EXTENSION_CONTEXT
    ? '当前是开发预览页面，浏览器禁止网页读取本地文件，读不到 project.json 中的用户选项。'
    : directReadState === 'failed' || fileSchemeAllowed === false
      ? '未开启“允许访问文件网址”，暂时读不到 project.json 中的用户选项。'
      : '该场景包没有在 project.json 中声明可选配置。';
  return hint;
}

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  bool: '开关',
  color: '颜色',
  slider: '滑块',
  combo: '下拉',
  textinput: '文本',
};

/** 渲染一行可编辑控件；改动立即写入条目并同步到正在播放的场景。 */
function renderPropertyRow(entry: WallpaperEngineEntry, property: WallpaperUserProperty): HTMLElement {
  const row = document.createElement('label');
  row.className = 'property-row';
  const name = document.createElement('div');
  name.className = 'property-name';
  const label = document.createElement('strong');
  label.textContent = property.label;
  const meta = document.createElement('small');
  meta.textContent = propertyTypeLabel(property);
  name.append(label, meta);
  const cell = document.createElement('div');
  cell.className = 'property-value';
  const value = effectivePropertyValue(entry, property);
  const input = createPropertyInput(entry, property, value, row);
  cell.append(input);
  if (entry.propertyOverrides?.[property.name] !== undefined) row.classList.add('is-custom');
  row.append(name, cell);
  return row;
}

function createPropertyInput(
  entry: WallpaperEngineEntry,
  property: WallpaperUserProperty,
  value: WallpaperPropertyValue | undefined,
  row: HTMLElement,
): HTMLElement {
  if (property.type === 'bool') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    input.addEventListener('change', () => {
      void applyPropertyChange(entry, property, input.checked, row);
    });
    return input;
  }
  if (property.type === 'slider') {
    const min = property.min ?? 0;
    const max = property.max ?? 100;
    const step = property.step ?? (property.fraction ? 0.001 : 1);
    const numeric = Number(value);
    const wrapper = document.createElement('div');
    wrapper.className = 'property-slider';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : min);
    const output = document.createElement('span');
    output.textContent = formatPropertyNumber(Number(input.value));
    input.addEventListener('input', () => {
      output.textContent = formatPropertyNumber(Number(input.value));
    });
    input.addEventListener('change', () => {
      void applyPropertyChange(entry, property, Number(input.value), row);
    });
    wrapper.append(input, output);
    return wrapper;
  }
  if (property.type === 'combo' && property.options?.length) {
    const select = document.createElement('select');
    for (const option of property.options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.append(element);
    }
    select.value = value === undefined ? property.options[0].value : String(value);
    select.addEventListener('change', () => {
      void applyPropertyChange(entry, property, select.value, row);
    });
    return select;
  }
  if (property.type === 'color') {
    const rgb = typeof value === 'string' ? parseColorTriplet(value) : undefined;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = rgb ? toHexColor(rgb) : '#ffffff';
    input.addEventListener('change', () => {
      const next = hexToTriplet(input.value);
      void applyPropertyChange(entry, property, next, row);
    });
    return input;
  }
  // textinput 与其它只读值
  if (property.type === 'textinput') {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.value = value === undefined ? '' : String(value);
    input.addEventListener('change', () => {
      void applyPropertyChange(entry, property, input.value, row);
    });
    return input;
  }
  const span = document.createElement('span');
  span.textContent = propertyValueText(property, value);
  return span;
}

async function applyPropertyChange(
  entry: WallpaperEngineEntry,
  property: WallpaperUserProperty,
  value: WallpaperPropertyValue,
  row: HTMLElement,
): Promise<void> {
  const index = playlistEntries.findIndex((item) => item.id === entry.id);
  if (index < 0) return;
  const current = playlistEntries[index];
  const overrides = { ...(current.propertyOverrides ?? {}) };
  // 调回壁纸默认值时不留 override，重新导入配置后仍能跟随 config.json。
  if (property.value !== undefined && String(value) === String(property.value)) {
    delete overrides[property.name];
  } else {
    overrides[property.name] = value;
  }
  const updated: WallpaperEngineEntry = {
    ...current,
    propertyOverrides: Object.keys(overrides).length ? overrides : undefined,
  };
  playlistEntries[index] = updated;
  row.classList.toggle('is-custom', updated.propertyOverrides?.[property.name] !== undefined);
  $('we-properties-reset').hidden = !updated.propertyOverrides || !Object.keys(updated.propertyOverrides).length;
  applyPropertyConditions(updated);
  if (settings.currentWallpaperEngineId === updated.id) {
    // 只有拿到 project.json 的属性声明，引擎才能把值写回 scene.json 的 {user: ...} 绑定。
    if (!updated.projectInfo) notifyMissingProjectDeclarations();
    applySceneProperties(updated);
  }
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    notify(`保存壁纸配置失败：${errorMessage(error)}`);
  }
}

/** 把当前条目的属性值推给正在播放的场景（只在该条目正在显示时调用）。 */
function applySceneProperties(entry: WallpaperEngineEntry): void {
  const frame = sceneRendererFrame;
  const token = sceneRendererToken;
  if (!frame?.contentWindow || !token) return;
  frame.contentWindow.postMessage({ type: 'properties', token, properties: effectiveProperties(entry) }, '*');
}

let missingDeclarationsNotified = false;

/** 缺少 project.json 声明时，脚本类属性仍会更新，但画面绑定不会变，必须明确告知。 */
function notifyMissingProjectDeclarations(): void {
  if (missingDeclarationsNotified) return;
  missingDeclarationsNotified = true;
  notify('已保存设置，但读不到该壁纸的 project.json，画面可能不会立即变化：请在 chrome://extensions 打开“允许访问文件网址”后重新播放该背景。');
}

async function resetWallpaperEngineProperties(): Promise<void> {
  const entryId = propertyDialogEntryId;
  if (!entryId) return;
  const index = playlistEntries.findIndex((item) => item.id === entryId);
  if (index < 0) return;
  const updated: WallpaperEngineEntry = {
    ...playlistEntries[index],
    propertyOverrides: undefined,
    viewOffsetX: undefined,
    viewOffsetY: undefined,
  };
  playlistEntries[index] = updated;
  propertyDialogRows = [];
  wePropertiesList.replaceChildren();
  for (const row of renderViewOffsetRows(updated)) wePropertiesList.append(row);
  const properties = (updated.userProperties ?? []).filter((property) => !isReservedProperty(property));
  for (const property of properties) {
    const row = renderPropertyRow(updated, property);
    propertyDialogRows.push({ row, property });
    wePropertiesList.append(row);
  }
  applyPropertyConditions(updated);
  wePropertiesNote.textContent = properties.length
    ? `${properties.length} 项可选配置，已恢复为壁纸与配置文件的默认值。`
    : '已恢复为默认取景。';
  $('we-properties-reset').hidden = true;
  if (settings.currentWallpaperEngineId === updated.id) {
    applySceneProperties(updated);
    applySceneView(updated);
  }
  try {
    await savePlaylistEntry(updated);
    notify('已恢复该壁纸的默认配置。');
  } catch (error) {
    notify(`恢复默认配置失败：${errorMessage(error)}`);
  }
}

function propertyTypeLabel(property: WallpaperUserProperty): string {
  const base = PROPERTY_TYPE_LABELS[property.type] ?? property.type;
  if (property.type === 'slider') {
    const range = property.min !== undefined && property.max !== undefined
      ? ` ${formatPropertyNumber(property.min)}–${formatPropertyNumber(property.max)}`
      : '';
    return `${base}${range}`;
  }
  if (property.type === 'combo' && property.options) return `${base} · ${property.options.length} 个选项`;
  return base;
}

function propertyValueText(property: WallpaperUserProperty, value: WallpaperPropertyValue | undefined): string {
  if (value === undefined) return '（未设置）';
  if (property.type === 'bool') return value ? '开' : '关';
  if (property.type === 'combo') {
    const option = property.options?.find((item) => item.value === String(value));
    return option?.label ?? String(value);
  }
  if (typeof value === 'number') return formatPropertyNumber(value);
  return String(value);
}

function formatPropertyNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10000) / 10000);
}

/** `0.733 0.533 0.478` 这类 0–1 浮点三元组转成 0–255。 */
function parseColorTriplet(value: string): [number, number, number] | undefined {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const scale = parts.some((part) => part > 1) ? 1 : 255;
  return parts.map((part) => Math.max(0, Math.min(255, Math.round(part * scale)))) as [number, number, number];
}

/** WE 的颜色是 0–1 三元组字符串，这里在色板取值与字符串之间转换。 */
function toHexColor(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function hexToTriplet(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '1 1 1';
  const value = match[1];
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  return channels.map((channel) => String(Math.round(channel * 1000) / 1000)).join(' ');
}

function activeBackgroundAsset(): MediaAsset | undefined {
  if (settings.backgroundSource === 'wallpaper-engine') return currentWeAsset;
  return media.find((item) => item.id === settings.currentMediaId);
}

function activePoolSize(): number {
  return settings.backgroundSource === 'wallpaper-engine'
    ? playlistEntries.filter((entry) => !entry.removed).length
    : media.length;
}

function playedWallpaperEngineEntries(): WallpaperEngineEntry[] {
  return playlistEntries
    .filter((entry) => Boolean(entry.playedAt) && !entry.removed)
    .sort((a, b) => (b.playedAt ?? 0) - (a.playedAt ?? 0));
}

function wallpaperEngineDisplayName(entry: WallpaperEngineEntry): string {
  const title = entry.title?.trim();
  if (title) return title;
  const parts = entry.path.split('/');
  const parent = parts[parts.length - 2];
  // 场景包文件名固定是 scene.pkg，改用所在作品目录名充当壁纸名。
  if (entry.name.toLowerCase() === 'scene.pkg' && parent) return parent;
  return entry.name;
}

/**
 * 只显示需要读取的目录后缀（如 steamapps/workshop/content/431960），不暴露本机绝对路径。
 */
function wallpaperEngineRelativeRoot(): string {
  const counts = new Map<string, number>();
  for (const entry of playlistEntries) {
    const parts = entry.path.replace(/\\/g, '/').split('/').filter(Boolean);
    const contentIndex = parts.findIndex((part, index) =>
      part.toLowerCase() === 'content' && index + 1 < parts.length - 1);
    const root = contentIndex > 0
      ? parts.slice(Math.max(0, contentIndex - 2), contentIndex + 2).join('/')
      : parts.slice(0, Math.max(0, parts.length - 2)).join('/');
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [root, count] of counts) {
    if (count > bestCount) {
      best = root;
      bestCount = count;
    }
  }
  return best;
}

function chooseRandomWallpaperEngineEntry(): WallpaperEngineEntry | undefined {
  if (!playlistEntries.some((entry) => !entry.removed)) return undefined;
  const usable = availableWallpaperEngineEntries();
  if (!usable.length) return undefined;
  const current = settings.currentWallpaperEngineId;
  const previous = settings.previousWallpaperEngineId;
  const preferred = usable.filter((entry) => entry.id !== current && entry.id !== previous);
  const pool = preferred.length ? preferred : usable.filter((entry) => entry.id !== current);
  return pool[Math.floor(Math.random() * pool.length)] ?? usable[0];
}

/**
 * 可参与随机播放的条目：排除已移除与已确认缺失的背景。
 * 如果全部都被标记缺失（例如整个盘符被拔掉），退回未移除的完整列表以便重新探测。
 */
function availableWallpaperEngineEntries(): WallpaperEngineEntry[] {
  const active = playlistEntries.filter((entry) => !entry.removed);
  const usable = active.filter((entry) => !entry.missing);
  return usable.length ? usable : active;
}

/** 不做状态标记的直读，用于探测与回退判断。 */
async function rawDirectRead(path: string): Promise<File | undefined> {
  // 预览环境（http 页面）被浏览器禁止读取 file://，直接返回避免刷屏报错。
  if (!IS_EXTENSION_CONTEXT) return undefined;
  try {
    return await readLocalFileViaProtocol(path);
  } catch {
    return undefined;
  }
}

/**
 * 走 file:// 直读（需用户开启“允许访问文件网址”）。
 * 单次读取失败可能只是该文件被删除或路径失效，不能据此判定通道不可用，
 * 所以这里不做“失败即永久禁用”的处理，状态降级只由小文件探测决定。
 */
async function tryDirectRead(path: string): Promise<File | undefined> {
  const file = await rawDirectRead(path);
  if (file) {
    directReadState = 'ok';
    // 只把体积小的文件记为通道样本，避免后续复核时重复读取上百 MB 的场景包。
    if (isSmallProbePath(path)) lastDirectPath = path;
    return file;
  }
  return undefined;
}

function isSmallProbePath(path: string): boolean {
  return /\.(?:json|jpe?g|png|webp|gif)$/i.test(path);
}

const directFileReader = (path: string): Promise<Blob | undefined> => tryDirectRead(path);

async function enterWallpaperEngineMode(): Promise<void> {
  if (!playlistEntries.length) {
    updateWeStatus();
    return;
  }
  const current = playlistEntries.find((entry) => entry.id === settings.currentWallpaperEngineId && !entry.removed);
  if (current && await playWallpaperEngineEntry(current.id, { silent: true })) {
    return;
  }
  await playRandomWallpaperEngineEntry({ reason: 'manual' });
}

async function playRandomWallpaperEngineEntry(options: { reason: 'manual' | 'auto' | 'recover' }): Promise<void> {
  if (!playlistEntries.length) {
    if (options.reason === 'manual') notify('请先选择 Wallpaper Engine 配置文件。');
    return;
  }
  const initialCurrent = settings.currentWallpaperEngineId;
  const usable = availableWallpaperEngineEntries();
  if (!usable.length) {
    currentWeAsset = undefined;
    settings.currentWallpaperEngineId = null;
    renderAll();
    await persist();
    if (options.reason === 'manual') notify('所有背景都已被移除，请点击“恢复已移除”找回。');
    return;
  }
  const pool = shuffleEntries(usable.filter((entry) => entry.id !== initialCurrent));
  const candidates = pool.length ? pool : shuffleEntries(usable.slice());
  let attempts = 0;
  for (const entry of candidates) {
    // 允许第一次尝试重新验证通道，之后再确认失败才提前结束。
    if (attempts >= 8 || (attempts >= 1 && directReadState === 'failed')) break;
    attempts += 1;
    if (await playWallpaperEngineEntry(entry.id, { silent: true })) return;
  }
  currentWeAsset = undefined;
  settings.currentWallpaperEngineId = null;
  renderAll();
  await persist();
  updateWeStatus();
  if (options.reason !== 'auto') notify(localFileHint());
}

/**
 * 把条目标记为缺失并持久化；随机池会跳过它，直到重新检查或重新导入配置。
 */
async function markWallpaperEngineMissing(entryId: string, reason: string, refresh = true): Promise<void> {
  const index = playlistEntries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return;
  const entry = playlistEntries[index];
  if (entry.missing) return;
  const updated: WallpaperEngineEntry = { ...entry, missing: true, checkedAt: Date.now() };
  playlistEntries[index] = updated;
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    console.warn(`保存缺失标记失败：${errorMessage(error)}`);
  }
  console.info(`标记背景缺失（${reason}）：${entry.path}`);
  if (refresh) {
    renderMediaList();
    updateWeStatus();
  }
}

/** 确认条目存在：清除缺失标记并记录检查时间。 */
async function markWallpaperEnginePresent(entryId: string): Promise<void> {
  const index = playlistEntries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return;
  const entry = playlistEntries[index];
  if (!entry.missing && entry.checkedAt) return;
  const updated: WallpaperEngineEntry = { ...entry, missing: undefined, checkedAt: Date.now() };
  playlistEntries[index] = updated;
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    console.warn(`保存检查结果失败：${errorMessage(error)}`);
  }
}

const WE_CHECK_TIMEOUT_MS = 8000;
const WE_CHECK_CONCURRENCY = 4;
let weCheckRunning = false;

/**
 * 轻量存在性探测：视频只读元数据、图片只解码一次，不读取媒体内容。
 * 场景包需要整包解析，这里不探测（改由播放失败时标记）。
 */
function probeWallpaperEngineEntry(entry: WallpaperEngineEntry): Promise<boolean | undefined> {
  if (entry.kind === 'scene' || !IS_EXTENSION_CONTEXT) return Promise.resolve(undefined);
  const url = toFileUrl(mediaPathForEntry(entry.path));
  return new Promise((resolve) => {
    let settled = false;
    const element = entry.kind === 'video'
      ? document.createElement('video')
      : new Image();
    const finish = (exists: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeAttribute('src');
      if (element instanceof HTMLVideoElement) element.load();
      resolve(exists);
    };
    const timer = window.setTimeout(() => finish(undefined), WE_CHECK_TIMEOUT_MS);
    if (element instanceof HTMLVideoElement) {
      element.preload = 'metadata';
      element.muted = true;
      element.addEventListener('loadedmetadata', () => finish(true), { once: true });
      element.addEventListener('error', () => finish(false), { once: true });
    } else {
      element.addEventListener('load', () => finish(true), { once: true });
      element.addEventListener('error', () => finish(false), { once: true });
    }
    element.src = url;
  });
}

/**
 * 导入配置后在后台检查文件是否存在，把缺失的条目标记下来并从随机池与列表中跳过。
 * 没有手动入口：缺失即跳过，不做额外提示。
 */
async function checkMissingWallpaperEngineEntries(): Promise<void> {
  if (!playlistEntries.length || weCheckRunning || !IS_EXTENSION_CONTEXT) return;
  if (!(await verifyDirectChannel())) {
    updateWeStatus();
    return;
  }
  const targets = playlistEntries.filter((entry) => entry.kind !== 'scene' && !entry.checkedAt && !entry.removed);
  if (!targets.length) return;
  weCheckRunning = true;
  const queue = targets.slice();
  const total = queue.length;
  let done = 0;
  let missingCount = 0;
  const reportProgress = (): void => {
    showImportStatus(`正在检查背景：${done}/${total}\n已跳过：${missingCount}`);
  };
  reportProgress();
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const exists = await probeWallpaperEngineEntry(entry);
      done += 1;
      if (exists === false && !entry.missing) {
        missingCount += 1;
        await markWallpaperEngineMissing(entry.id, '检查时未找到文件', false);
      } else if (exists === true && entry.missing) {
        await markWallpaperEnginePresent(entry.id);
      }
      if (done % 5 === 0 || done === total) reportProgress();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(WE_CHECK_CONCURRENCY, total) }, () => worker()));
  } catch (error) {
    console.warn(`检查背景完整性失败：${errorMessage(error)}`);
  } finally {
    weCheckRunning = false;
    hideImportStatus();
    renderMediaList();
    updateWeStatus();
  }
}

/** 是否为已加载的扩展页面（chrome-extension:// 或具备 runtime.id）。 */
const IS_EXTENSION_CONTEXT = location.protocol === 'chrome-extension:' ||
  Boolean((globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);

function localFileHint(): string {
  if (!IS_EXTENSION_CONTEXT) {
    return '当前是开发预览页面：浏览器禁止普通网页读取本地文件（file://），请用已加载的扩展打开新标签页测试。';
  }
  if (fileSchemeAllowed === false) {
    return 'Chrome 的“允许访问文件网址”当前是关闭的：请在 chrome://extensions 打开本扩展详情页勾选该项，再点击“获取权限”。';
  }
  if (directReadState === 'ok') {
    return '这张背景读取失败（文件可能已被移动或删除），已尝试切换到其他背景。';
  }
  return '读不到本地背景文件。请点击“获取权限”重新确认一次。';
}

async function playWallpaperEngineEntry(entryId: string, options: { silent?: boolean }): Promise<boolean> {
  const loaded = await loadWallpaperEngineAsset(entryId, options);
  if (!loaded) return false;
  renderAll();
  await persist();
  return true;
}

async function loadWallpaperEngineAsset(entryId: string, options: { silent?: boolean }): Promise<boolean> {
  const entry = playlistEntries.find((item) => item.id === entryId);
  if (!entry) return false;
  const mediaPath = mediaPathForEntry(entry.path);
  const token = ++weLoadToken;
  let asset: MediaAsset;
  if (entry.kind === 'scene') {
    // 场景包必须整包交给 WebWallGL 解析；视频/图片则改用 file:// 直连流式播放。
    const file = await tryDirectRead(mediaPath);
    if (!file) {
      const channelOk = await verifyDirectChannel();
      updateWeStatus();
      if (channelOk) {
        await markWallpaperEngineMissing(entry.id, '读取场景包失败');
        if (!options.silent) notify('该场景包读取失败（文件可能已被移动或过大），已标记为缺失并跳过。');
      } else if (!options.silent) {
        notify(localFileHint());
      }
      return false;
    }
    asset = {
      id: entry.id,
      name: entry.name,
      type: file.type || mimeForPlaylistKind(entry.kind, entry.name),
      kind: entry.kind,
      size: file.size,
      importedAt: Date.now(),
      hash: entry.id,
      width: 0,
      height: 0,
      blob: file,
    };
  } else {
    const type = mimeForPlaylistKind(entry.kind, entry.name);
    asset = {
      id: entry.id,
      name: entry.name,
      type,
      kind: entry.kind,
      size: 0,
      importedAt: Date.now(),
      hash: entry.id,
      width: 0,
      height: 0,
      blob: new Blob([], { type }),
      sourceUrl: toFileUrl(mediaPath),
    };
  }
  await ensureWallpaperEngineMetadata(entry.id);
  if (token !== weLoadToken) return false;
  settings.previousWallpaperEngineId = settings.currentWallpaperEngineId;
  settings.currentWallpaperEngineId = entry.id;
  currentWeAsset = asset;
  updateWeStatus();
  return true;
}

function markWallpaperEnginePlayed(entryId: string): void {
  const index = playlistEntries.findIndex((entry) => entry.id === entryId);
  if (index < 0) return;
  const entry = playlistEntries[index];
  entry.playedAt = Date.now();
  void savePlaylistEntry({ ...entry })
    .then(() => {
      renderMediaList();
      updateWeStatus();
    })
    .catch((error: unknown) => console.warn(`保存已播地址失败：${errorMessage(error)}`));
  if (currentWeAsset?.id === entryId && entry.kind !== 'scene') {
    void cacheWallpaperEnginePreview(entryId, currentWeAsset.sourceUrl ?? currentWeAsset.blob);
  }
}

async function cacheWallpaperEnginePreview(entryId: string, source: Blob | string): Promise<void> {
  if (wePreviewJobs.has(entryId)) return;
  const entry = playlistEntries.find((item) => item.id === entryId);
  if (!entry || entry.previewFromProject) return;
  if (entry.preview && !entry.previewFile) return;
  wePreviewJobs.add(entryId);
  try {
    const projectPreview = await readProjectPreview(
      entry.path,
      entry.previewFile,
      directFileReader,
    );
    if (projectPreview) {
      const thumbnail = await captureImagePreview(projectPreview);
      if (thumbnail) {
        await applyWallpaperEnginePreview(entryId, thumbnail, true);
        return;
      }
    }
    if (entry.preview) return;
    const preview = entry.kind === 'video'
      ? await captureVideoPreview(source)
      : await captureImagePreview(source);
    if (preview) await applyWallpaperEnginePreview(entryId, preview);
  } catch (error) {
    console.warn(`生成已播预览失败：${errorMessage(error)}`);
  } finally {
    wePreviewJobs.delete(entryId);
  }
}

async function applyWallpaperEnginePreview(entryId: string, preview: Blob, fromProject = false): Promise<void> {
  const index = playlistEntries.findIndex((item) => item.id === entryId);
  if (index < 0) return;
  const updated: WallpaperEngineEntry = {
    ...playlistEntries[index],
    preview,
    previewFromProject: fromProject,
    playedAt: playlistEntries[index].playedAt ?? Date.now(),
  };
  playlistEntries[index] = updated;
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    console.warn(`保存已播预览失败：${errorMessage(error)}`);
  }
  renderMediaList();
  updateWeStatus();
}

async function importWallpaperEngineConfig(
  file: File,
  options: { handle?: FileSystemFileHandle; refresh?: boolean } = {},
): Promise<void> {
  if (file.size > 20 * 1024 * 1024) {
    notify('Wallpaper Engine 配置文件超过 20 MB 限制。');
    return;
  }
  try {
    const parsedRaw: unknown = JSON.parse(await file.text());
    const parsed = parseWallpaperEngineConfig(parsedRaw);
    if (!parsed.entries.length) {
      notify('配置中没有找到受支持的壁纸路径（MP4、WebM、JPEG、PNG、WebP 或 PKGV .pkg）。');
      return;
    }
    if (options.handle) {
      configFileHandle = options.handle;
      // 句柄无法 JSON 序列化，只能存 IndexedDB；同时把可比对的路径写进设置。
      await saveConfigFileHandle(options.handle).catch((error: unknown) =>
        console.warn(`保存配置文件句柄失败：${errorMessage(error)}`));
    }
    const configPath = configPathFromInstallDirectory(parsed.installDirectory);
    const entries = parsed.entries.map((entry) => {
      const overrides = propertyOverridesFor(parsed.propertyValues, entry.path, entry.monitor);
      return overrides ? { ...entry, configPropertyValues: overrides } : entry;
    });
    playlistEntries = await replacePlaylistEntries(entries);
    settings.wallpaperConfigName = file.name;
    settings.wallpaperConfigPath = configPath ?? settings.wallpaperConfigPath;
    settings.backgroundSource = 'wallpaper-engine';
    // 刷新时保持当前正在播放的背景；只有该条目已不在配置里才换成随机一张。
    const currentEntry = playlistEntries.find(
      (entry) => entry.id === settings.currentWallpaperEngineId && !entry.removed,
    );
    const keepPlaying = Boolean(options.refresh && currentEntry && currentWeAsset);
    if (!currentEntry) {
      settings.currentWallpaperEngineId = null;
      currentWeAsset = undefined;
    }
    await persist();
    applySettingsToControls();
    renderAll();
    const skipped = parsed.skipped
      ? `，跳过 ${parsed.skipped} 项（网页壁纸 ${parsed.skippedWeb}、其它 ${parsed.skippedOther}）`
      : '';
    const user = parsed.user ? `${parsed.user} 的 ` : '';
    const ignored = parsed.ignoredUsers.length
      ? `，忽略其它用户配置 ${parsed.ignoredUsers.length} 个`
      : '';
    const removedCount = playlistEntries.filter((entry) => entry.removed).length;
    const removed = removedCount ? `，${removedCount} 项保持已移除` : '';
    const prefix = options.refresh ? '已刷新配置' : '已读取';
    notify(`${prefix}${user}${entries.length} 个背景${skipped}${ignored}${removed}。`);
    if (keepPlaying) {
      renderWallpaperName();
    } else {
      void enterWallpaperEngineMode();
    }
    // 导入/刷新后自动检查一次文件是否存在，把缺失项从随机播放中排除。
    void checkMissingWallpaperEngineEntries();
  } catch (error) {
    notify(`读取 Wallpaper Engine 配置失败：${errorMessage(error)}`);
  }
}

/** 选择 WE 配置：优先用文件句柄（下次默认打开上次目录，且刷新可无弹窗重读）。 */
async function pickWallpaperEngineConfig(): Promise<void> {
  if (typeof window.showOpenFilePicker !== 'function') {
    // 不支持 File System Access 的环境退回普通文件选择器（无法记住目录）。
    weConfigInput.click();
    return;
  }
  const options: OpenFilePickerOptions = {
    multiple: false,
    suggestedName: 'config.json',
    types: [{ description: 'Wallpaper Engine 配置', accept: { 'application/json': ['.json'] } }],
  };
  try {
    let handles: FileSystemFileHandle[];
    try {
      handles = await window.showOpenFilePicker(
        configFileHandle ? { ...options, startIn: configFileHandle } : options,
      );
    } catch (error) {
      // 记住的句柄失效（文件被移动/删除）时，退回不带起始位置再问一次。
      if (!configFileHandle || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      console.warn(`上次的配置位置已失效：${errorMessage(error)}`);
      handles = await window.showOpenFilePicker(options);
    }
    const handle = handles[0];
    if (!handle) return;
    await importWallpaperEngineConfig(await handle.getFile(), { handle });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    notify(`打开配置文件失败：${errorMessage(error)}`);
  }
}

/**
 * 刷新配置：用上次记住的句柄直接重读同一个文件（不再弹对话框）；
 * 句柄不可用时退回按记录的绝对路径直读（需要“允许访问文件网址”）。
 */
async function refreshWallpaperEngineConfig(): Promise<void> {
  const handle = configFileHandle ?? (configFileHandle = await loadConfigFileHandle().catch(() => undefined));
  if (handle) {
    try {
      if (!(await ensureConfigHandlePermission(handle))) {
        notify('已失去配置文件的读取权限，请点“选择 WE 配置”重新选择一次。');
        return;
      }
      await importWallpaperEngineConfig(await handle.getFile(), { handle, refresh: true });
      return;
    } catch (error) {
      console.warn(`读取已记住的配置文件失败：${errorMessage(error)}`);
    }
  }
  const path = settings.wallpaperConfigPath;
  if (path) {
    if (!IS_EXTENSION_CONTEXT) {
      notify('开发预览页面读不到本地文件；请先在已加载的扩展里选择一次配置。');
      return;
    }
    try {
      const file = await readLocalFileViaProtocol(path);
      await importWallpaperEngineConfig(file, { refresh: true });
      return;
    } catch (error) {
      notify(`刷新失败：${errorMessage(error)}。请在 chrome://extensions 打开“允许访问文件网址”，或点“选择 WE 配置”重新选择。`);
      return;
    }
  }
  notify('还没有记录配置文件，请先点“选择 WE 配置”。');
}

/** 句柄可能因权限过期需要重新授权；没有该 API 时交给 getFile() 抛错。 */
async function ensureConfigHandlePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const target = handle as FileSystemFileHandle & FileSystemHandlePermissionMixin;
  try {
    if (target.queryPermission) {
      const state = await target.queryPermission({ mode: 'read' });
      if (state === 'granted') return true;
    }
    if (target.requestPermission) {
      return (await target.requestPermission({ mode: 'read' })) === 'granted';
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * 检测 file:// 直读是否可用。先查询 Chrome 的“允许访问文件网址”开关，
 * 再只用小文件（project.json / 预览图）探测，连续多个都读不到才判定不可用。
 */
async function probeDirectFileAccess(): Promise<void> {
  if (!playlistEntries.length) {
    notify('请先选择 Wallpaper Engine 配置。');
    return;
  }
  if (!IS_EXTENSION_CONTEXT) {
    notify('当前是开发预览页面，浏览器禁止网页读取本地文件；请在已加载的扩展新标签页中测试。');
    return;
  }
  await refreshFileSchemeState();
  if (fileSchemeAllowed === false) {
    directReadState = 'failed';
    updateWeStatus();
    notify('Chrome 的“允许访问文件网址”当前是关闭的：请在 chrome://extensions 打开本扩展详情页勾选该项。');
    return;
  }
  const previous = directReadState;
  const result = await probeChannelWithSmallFile();
  updateWeStatus();
  renderMediaList();
  if (result === 'ok') {
    notify('本地文件读取正常，无需在 chrome://extensions 重新授权。');
    // 只补上“还没有背景”的情况；已有背景时保持不动，避免点按钮就换壁纸。
    if (!currentWeAsset && settings.backgroundSource === 'wallpaper-engine' && playlistEntries.length) {
      const current = playlistEntries.find((entry) => entry.id === settings.currentWallpaperEngineId);
      if (!current || !(await playWallpaperEngineEntry(current.id, { silent: true }))) {
        await playRandomWallpaperEngineEntry({ reason: 'manual' });
      }
    }
    return;
  }
  if (previous === 'ok') {
    directReadState = 'ok';
    updateWeStatus();
    notify('文件读取仍可用；本次抽样的小文件都不存在，请检查配置里的路径是否已被移动或删除。');
    return;
  }
  directReadState = 'failed';
  updateWeStatus();
  notify('本地文件读取不可用：请在 chrome://extensions 打开本扩展的“允许访问文件网址”，重新加载扩展后再试。');
}

/**
 * 探测候选（只选小文件）：已播条目的 project.json → 预览图 → 非场景媒体。
 * 绝不把 scene.pkg（可能上千 MB）当作探测样本，避免大文件读取失败被误判成权限丢失。
 */
function buildProbeCandidates(): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    paths.push(value);
  };
  if (lastDirectPath) push(lastDirectPath);
  const played = playlistEntries.filter((entry) => entry.playedAt);
  const ordered = [...played, ...playlistEntries];
  for (const entry of ordered.slice(0, 20)) {
    const slash = entry.path.lastIndexOf('/');
    if (slash > 0) push(`${entry.path.slice(0, slash)}/project.json`);
    if (entry.previewFile && slash > 0) push(`${entry.path.slice(0, slash)}/${entry.previewFile}`);
  }
  for (const entry of ordered) {
    if (entry.kind === 'video' || entry.kind === 'image') push(mediaPathForEntry(entry.path));
  }
  return paths.slice(0, 8);
}

/**
 * 用小文件探测通道状态。
 * - 任一成功 → 可用
 * - 连续 3 个不同的小文件都失败 → 判定权限不可用
 * - 否则维持未知（不误报）
 */
async function probeChannelWithSmallFile(): Promise<'ok' | 'unknown' | 'failed'> {
  const candidates = buildProbeCandidates();
  let tried = 0;
  for (const path of candidates) {
    if (tried >= 4) break;
    tried += 1;
    const probe = await rawDirectRead(path);
    if (probe) {
      directReadState = 'ok';
      lastDirectPath = path;
      return 'ok';
    }
  }
  // 刚重新加载扩展时首个 file:// 请求偶发失败，稍后重试一次再下结论。
  if (tried > 0) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    const retry = await rawDirectRead(candidates[0]);
    if (retry) {
      directReadState = 'ok';
      lastDirectPath = candidates[0];
      return 'ok';
    }
  }
  if (tried >= 3) {
    directReadState = 'failed';
    return 'failed';
  }
  return directReadState;
}

/**
 * 复核 file:// 通道是否仍然可用。只读小文件，成功即说明“只是当前背景缺失”，
 * 从而避免因为播放到被删除的条目或大体积场景包而误报“未授权”。
 */
async function verifyDirectChannel(): Promise<boolean> {
  if (directReadState === 'ok') {
    // 已确认可用时，只有连续小文件探测失败才降级。
    if (!lastDirectPath) return true;
    const probe = await rawDirectRead(lastDirectPath);
    if (probe) return true;
  }
  return (await probeChannelWithSmallFile()) === 'ok';
}

async function clearPlayedWallpaperEngineEntries(): Promise<void> {
  const count = playedWallpaperEngineEntries().length;
  if (!count) return;
  if (!window.confirm(`清除 ${count} 条已播地址记录和预览图？不会删除磁盘文件或 Wallpaper Engine 配置。`)) return;
  try {
    await clearPlaylistPlayed();
    playlistEntries = await listPlaylistEntries();
    renderMediaList();
    updateWeStatus();
    notify(`已清除 ${count} 条已播记录。`);
  } catch (error) {
    notify(`清除已播记录失败：${errorMessage(error)}`);
  }
}

async function restoreRemovedWallpaperEngineEntries(): Promise<void> {
  const removedCount = playlistEntries.filter((entry) => entry.removed).length;
  if (!removedCount) return;
  try {
    playlistEntries = await restoreRemovedPlaylistEntries();
    renderAll();
    notify(`已恢复 ${removedCount} 项背景，重新参与随机切换。`);
  } catch (error) {
    notify(`恢复已移除背景失败：${errorMessage(error)}`);
  }
}

function shuffleEntries<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

/** 是否已有任何可用壁纸：本地媒体库有导入，或播放列表里有未移除的背景。 */
function hasAnyWallpaper(): boolean {
  return media.length > 0 || playlistEntries.some((entry) => !entry.removed);
}

function renderShortcuts(): void {
  shortcutsRoot.replaceChildren();
  // 只有全新状态（没有任何壁纸/背景，也没有快捷方式）才显示引导文案。
  const welcome = $('welcome') as HTMLElement;
  welcome.hidden = settings.shortcuts.length > 0 || hasAnyWallpaper();
  for (const shortcut of settings.shortcuts) {
    const link = document.createElement('a');
    link.className = 'shortcut-tile';
    link.href = shortcut.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${shortcut.name}，在新标签页打开`);
    const icon = document.createElement('span');
    icon.className = 'shortcut-icon';
    icon.textContent = makeInitial(shortcut.name);
    void applyShortcutIcon(icon, shortcut.url, makeInitial(shortcut.name));
    const label = document.createElement('span');
    label.className = 'shortcut-label';
    label.textContent = shortcut.name;
    link.append(icon, label);
    shortcutsRoot.append(link);
  }
}

async function applyShortcutIcon(icon: HTMLSpanElement, url: string, fallback: string): Promise<void> {
  const domain = normalizedDomain(url);
  if (!domain) return;
  try {
    const asset = await getCachedIcon(settings.iconSource, domain);
    if (!asset) return;
    const objectUrl = URL.createObjectURL(asset.blob);
    const image = document.createElement('img');
    image.alt = '';
    image.addEventListener('load', () => {
      URL.revokeObjectURL(objectUrl);
      icon.replaceChildren(image);
    }, { once: true });
    image.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl);
      icon.textContent = fallback;
      console.warn(`本地图标缓存无法解码：${domain}`);
      notify(`${domain} 的缓存图标无法解码，已回退为首字母。`);
    }, { once: true });
    image.src = objectUrl;
  } catch (error) {
    console.error(`读取 ${domain} 的本地图标缓存失败`, error);
    notify(`读取 ${domain} 的图标缓存失败：${errorMessage(error)}`);
  }
}

interface IconSyncReport {
  updated: number;
  failures: Array<{ domain: string; message: string }>;
  permissionDenied: boolean;
}

async function syncShortcutIcons(): Promise<IconSyncReport> {
  const targets = new Map<string, string>();
  for (const shortcut of settings.shortcuts) {
    const domain = normalizedDomain(shortcut.url);
    if (domain && !targets.has(domain)) targets.set(domain, shortcut.url);
  }
  if (!targets.size) return { updated: 0, failures: [], permissionDenied: false };
  const source = settings.iconSource;
  if (!(await hasIconPermission(source))) return { updated: 0, failures: [], permissionDenied: true };
  let updated = 0;
  const failures: IconSyncReport['failures'] = [];
  for (const [domain] of targets) {
    try {
      if (await getCachedIcon(source, domain)) continue;
      await fetchAndCacheIcon(source, domain);
      updated += 1;
    } catch (error) {
      failures.push({ domain, message: errorMessage(error) });
    }
  }
  if (updated > 0) {
    renderShortcuts();
  }
  return { updated, failures, permissionDenied: false };
}

function reportIconSync(source: IconSource, report: IconSyncReport): void {
  if (report.permissionDenied) {
    notify(`尚未授权${ICON_SOURCES[source].label}。请点击“按当前来源重新获取图标”并允许权限。`);
    return;
  }
  for (const failure of report.failures) console.warn(`获取 ${failure.domain} 的图标失败：${failure.message}`);
  if (!report.failures.length) {
    if (report.updated) notify(`已获取并缓存 ${report.updated} 个网站图标。`);
    return;
  }
  const details = report.failures.slice(0, 2).map(({ domain, message }) => `${domain}：${message}`).join('；');
  const remaining = report.failures.length > 2 ? `，另有 ${report.failures.length - 2} 个失败，详情见控制台` : '';
  notify(`图标获取成功 ${report.updated} 个，失败 ${report.failures.length} 个。${details}${remaining}`);
}

async function changeIconSource(): Promise<void> {
  const source = settings.iconSource;
  const permissionRequest = requestIconPermission(source);
  try {
    const granted = await permissionRequest;
    renderShortcuts();
    await persist();
    if (!granted) {
      notify(`${ICON_SOURCES[source].label} 未获权限，仍使用本地缓存或首字母。`);
      return;
    }
    reportIconSync(source, await syncShortcutIcons());
  } catch (error) {
    notify(`切换图标来源失败：${errorMessage(error)}`);
    return;
  }
}

async function refreshIcons(): Promise<void> {
  const source = settings.iconSource;
  if (!settings.shortcuts.length) {
    notify('请先添加快捷方式，再获取网站图标。');
    return;
  }
  const permissionRequest = requestIconPermission(source);
  try {
    if (!(await permissionRequest)) {
      notify(`${ICON_SOURCES[source].label} 未获权限，图标保持本地缓存或首字母回退。`);
      return;
    }
    await clearIconCache(source);
    renderShortcuts();
    reportIconSync(source, await syncShortcutIcons());
  } catch (error) {
    notify(`重新获取图标失败：${errorMessage(error)}`);
  }
}

function renderShortcutManager(): void {
  shortcutManager.replaceChildren();
  $('shortcut-count').textContent = `${settings.shortcuts.length} / 18`;
  if (!settings.shortcuts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = '还没有快捷方式，添加常用网站。';
    shortcutManager.append(empty);
    return;
  }
  settings.shortcuts.forEach((shortcut, index) => {
    const row = document.createElement('div');
    row.className = 'manage-row';
    row.draggable = true;
    row.dataset.shortcutId = shortcut.id;
    const info = document.createElement('div');
    info.className = 'item-info';
    const name = document.createElement('strong');
    name.textContent = shortcut.name;
    const url = document.createElement('small');
    url.textContent = new URL(shortcut.url).hostname;
    info.append(name, url);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const up = createButton('↑', '上移快捷方式', 'shortcut-up');
    up.dataset.index = String(index);
    up.disabled = index === 0;
    const down = createButton('↓', '下移快捷方式', 'shortcut-down');
    down.dataset.index = String(index);
    down.disabled = index === settings.shortcuts.length - 1;
    const edit = createButton('···', `编辑 ${shortcut.name}`, 'shortcut-edit');
    edit.dataset.id = shortcut.id;
    const remove = createButton('×', `删除 ${shortcut.name}`, 'shortcut-delete');
    remove.dataset.id = shortcut.id;
    actions.append(up, down, edit, remove);
    row.append(info, actions);
    shortcutManager.append(row);
  });
}

function renderBackdrop(): void {
  const current = activeBackgroundAsset();
  const target = $('backdrop') as HTMLDivElement;
  resetScenePointer();
  if (!current) {
    if (autoSwitchTimer !== undefined) window.clearTimeout(autoSwitchTimer);
    autoSwitchTimer = undefined;
    target.replaceChildren();
    releaseActiveUrl();
    return;
  }
  releaseActiveUrl();
  if (current.kind === 'scene') {
    const frame = document.createElement('iframe');
    frame.className = 'scene-wallpaper-frame';
    frame.title = `${current.name} Wallpaper Engine 场景`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = 'scene-renderer.html';
    sceneRendererFrame = frame;
    sceneRendererToken = crypto.randomUUID();
    sceneRendererSent = false;
    sceneRendererPaused = false;
    target.replaceChildren(frame);
    renderPlaybackStatus();
    return;
  }
  activeObjectUrl = current.sourceUrl ? undefined : URL.createObjectURL(current.blob);
  const source = current.sourceUrl ?? activeObjectUrl!;
  if (current.kind === 'image') {
    const image = document.createElement('img');
    image.src = source;
    image.alt = '';
    image.onload = () => {
      if (activeBackgroundAsset()?.id !== current.id) return;
      renderAttempt = 0;
      if (settings.backgroundSource === 'wallpaper-engine') markWallpaperEnginePlayed(current.id);
      scheduleAutomaticSwitch();
    };
    image.onerror = () => void recoverFailedMedia(current.id);
    target.replaceChildren(image);
    return;
  }
  const video = document.createElement('video');
  video.src = source;
  video.autoplay = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.addEventListener('error', () => void recoverFailedMedia(current.id), { once: true });
  video.addEventListener('loadeddata', () => {
    if (activeBackgroundAsset()?.id !== current.id) return;
    renderAttempt = 0;
    if (settings.backgroundSource === 'wallpaper-engine') markWallpaperEnginePlayed(current.id);
    scheduleAutomaticSwitch();
    const playAttempt = video.play();
    if (playAttempt) void playAttempt.catch(() => {
      notify(`${current.name}：浏览器阻止了自动播放，点击左下角播放按钮开始。`);
      $('toggle-playback').textContent = '▶';
    });
  }, { once: true });
  target.replaceChildren(video);
}

function renderPlaybackStatus(): void {
  const video = $('backdrop').querySelector('video');
  const playing = video ? !video.paused : Boolean(sceneRendererFrame && !sceneRendererPaused);
  $('toggle-playback').textContent = playing ? 'Ⅱ' : '▶';
  $('toggle-playback').setAttribute('aria-label', playing ? '暂停壁纸' : '播放壁纸');
  renderWallpaperName();
}

/** 左下角控制栏显示当前背景的名称；没有背景时隐藏。 */
function renderWallpaperName(): void {
  const name = $('wallpaper-name');
  const label = currentBackgroundName();
  name.textContent = label ?? '';
  name.title = label ?? '';
  name.hidden = !label;
}

function currentBackgroundName(): string | undefined {
  if (settings.backgroundSource === 'wallpaper-engine') {
    // 只有确实加载成功的背景才显示名字，避免残留旧名字误导。
    if (!currentWeAsset) return undefined;
    const entry = playlistEntries.find((item) => item.id === currentWeAsset?.id);
    return entry ? wallpaperEngineDisplayName(entry) : undefined;
  }
  const asset = media.find((item) => item.id === settings.currentMediaId);
  return asset?.name;
}

const SCENE_POINTER_BLOCKING_SELECTOR = '.topbar, .footer, .search, .shortcut-tile, .settings-panel, .toast, dialog';

function isScenePointerBlocked(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SCENE_POINTER_BLOCKING_SELECTOR) !== null;
}

function postScenePointer(): void {
  const frame = sceneRendererFrame;
  const token = sceneRendererToken;
  if (!frame?.contentWindow || !token) return;
  frame.contentWindow.postMessage({ type: 'pointer', token, ...scenePointerState }, '*');
}

function resetScenePointer(): void {
  scenePointerState.buttons = 0;
  scenePointerKnown = false;
  document.body.classList.remove('scene-pointer-active');
}

function updateScenePointerPosition(event: PointerEvent): boolean {
  const frame = sceneRendererFrame;
  if (!frame) return false;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  scenePointerState.u = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  scenePointerState.v = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  scenePointerState.mods = (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
  scenePointerKnown = true;
  return true;
}

function releaseScenePointerButton(): void {
  document.body.classList.remove('scene-pointer-active');
  if (!(scenePointerState.buttons & 1)) return;
  scenePointerState.buttons &= ~1;
  postScenePointer();
}

function leaveScenePointer(): void {
  releaseScenePointerButton();
  const frame = sceneRendererFrame;
  const token = sceneRendererToken;
  if (frame?.contentWindow && token) frame.contentWindow.postMessage({ type: 'pointer-leave', token }, '*');
}

async function handleSceneRendererMessage(event: MessageEvent<SceneRendererResponse>): Promise<void> {
  if (!sceneRendererFrame || event.source !== sceneRendererFrame.contentWindow) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'renderer-ready') {
    if (!sceneRendererSent) await sendScenePackage();
    return;
  }
  if (!sceneRendererToken || message.token !== sceneRendererToken) return;
  if (message.type === 'scene-ready') {
    renderAttempt = 0;
    if (scenePointerKnown) postScenePointer();
    if (settings.backgroundSource === 'wallpaper-engine' && settings.currentWallpaperEngineId) {
      markWallpaperEnginePlayed(settings.currentWallpaperEngineId);
    }
    scheduleAutomaticSwitch();
    renderPlaybackStatus();
    return;
  }
  if (message.type === 'scene-error') {
    console.error(`Wallpaper Engine 场景渲染失败：${message.message}`);
    notify(`场景渲染失败：${message.message}`);
    const failedId = activeBackgroundAsset()?.id;
    if (failedId) await recoverFailedMedia(failedId);
    return;
  }
  if (message.type === 'scene-preview-error') {
    console.warn(`无法生成场景首帧预览：${message.message}`);
    return;
  }
  if (message.type === 'scene-preview') {
    const preview = new Blob([message.bytes], { type: 'image/jpeg' });
    if (settings.backgroundSource === 'wallpaper-engine' && settings.currentWallpaperEngineId) {
      await applyWallpaperEnginePreview(settings.currentWallpaperEngineId, preview);
      return;
    }
    const asset = media.find((item) => item.id === settings.currentMediaId && item.kind === 'scene');
    if (!asset) return;
    const updatedAsset = { ...asset, preview };
    try {
      await saveAsset(updatedAsset);
      const index = media.findIndex((item) => item.id === asset.id);
      if (index >= 0) {
        media[index] = updatedAsset;
        renderMediaList();
      }
    } catch (error) {
      notify(`保存场景首帧预览失败：${errorMessage(error)}`);
    }
  }
}

async function sendScenePackage(): Promise<void> {
  const frame = sceneRendererFrame;
  const token = sceneRendererToken;
  const current = activeBackgroundAsset();
  if (!frame || !token || !current || current.kind !== 'scene' || !frame.contentWindow) return;
  sceneRendererSent = true;
  const entry = playlistEntries.find((item) => item.id === current.id);
  try {
    const bytes = await current.blob.arrayBuffer();
    if (sceneRendererFrame !== frame || sceneRendererToken !== token) return;
    frame.contentWindow.postMessage({
      type: 'load',
      token,
      bytes,
      key: `localtab:${current.id}`,
      title: current.name,
      project: entry?.projectInfo,
      properties: entry ? effectiveProperties(entry) : {},
      viewX: entry?.viewOffsetX ?? 0,
      viewY: entry?.viewOffsetY ?? 0,
    }, '*', [bytes]);
  } catch (error) {
    notify(`读取场景包失败：${errorMessage(error)}`);
    await recoverFailedMedia(current.id);
  }
}

async function importMedia(
  files: File[],
  options: { folderImport: boolean; unsupportedCount: number } = { folderImport: false, unsupportedCount: 0 },
): Promise<void> {
  let batchConflictChoice: 'overwrite' | 'skip' | 'rename' | undefined;
  let importedCount = 0;
  let skippedCount = options.unsupportedCount;
  const failures: string[] = [];
  const batchTotal = files.length;
  if (batchTotal > 0) {
    showImportStatus(`正在导入：（准备中）\n已导入：0/${batchTotal}`);
  }
  for (const [index, file] of files.entries()) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const name = relativePath || file.name;
    showImportStatus(`正在导入：${name}\n已导入：${importedCount}/${batchTotal}`);
    try {
      const inspected = await inspectMedia(file);
      const existing = media.find((asset) =>
        asset.name.toLocaleLowerCase() === name.toLocaleLowerCase() ||
        (asset.kind === inspected.kind && asset.hash === inspected.hash),
      );
      let conflictId: string | undefined;
      let importedName = name;
      if (existing) {
        if (!batchConflictChoice) {
          batchConflictChoice = await chooseBatchConflictResolution(name);
        }
        if (batchConflictChoice === 'skip') {
          skippedCount += 1;
          if (!options.folderImport) notify(`已跳过冲突壁纸：${name}`);
          continue;
        }
        if (batchConflictChoice === 'overwrite') {
          conflictId = existing.id;
        } else {
          importedName = nextAvailableMediaName(name);
        }
      }
      const asset: MediaAsset = {
        ...inspected,
        name: importedName,
        type: inspected.type || file.type,
        id: conflictId ?? crypto.randomUUID(),
        importedAt: Date.now(),
        blob: file,
      };
      await saveAsset(asset);
      if (asset.kind !== 'icon') {
        const existingIndex = media.findIndex((item) => item.id === asset.id);
        if (existingIndex === -1) media.push(asset);
        else media[existingIndex] = asset;
      }
      importedCount += 1;
      if (!options.folderImport) notify(`已导入：${file.name}`);
    } catch (error) {
      const message = `${file.name}：${errorMessage(error)}`;
      if (options.folderImport) failures.push(message);
      else notify(message);
    } finally {
      if (index + 1 === batchTotal) {
        showImportStatus(`正在导入：（已完成）\n已导入：${importedCount}/${batchTotal}`, 3000);
      }
    }
  }
  if (!media.some((item) => item.id === settings.currentMediaId) && media.length) {
    settings.currentMediaId = media[0].id;
  }
  await persist();
  renderAll();
  if (options.folderImport) {
    const summary = [`已导入或覆盖 ${importedCount} 项`, `跳过 ${skippedCount} 项`];
    if (failures.length) summary.push(`失败 ${failures.length} 项（${failures[0]}）`);
    notify(`文件夹导入完成：${summary.join('；')}。`);
  }
}

function queueMediaImport(
  files: File[],
  options: { folderImport: boolean; unsupportedCount: number } = { folderImport: false, unsupportedCount: 0 },
): void {
  mediaImportQueue = mediaImportQueue
    .then(() => importMedia(files, options))
    .catch((error: unknown) => notify(`批量导入失败：${errorMessage(error)}`));
}

function chooseBatchConflictResolution(name: string): Promise<'overwrite' | 'skip' | 'rename'> {
  $('media-conflict-name').textContent = `“${name}”与媒体库中的壁纸冲突。请选择本批次的处理方式：`;
  return new Promise((resolve) => {
    mediaConflictDialog.returnValue = '';
    mediaConflictDialog.addEventListener('close', () => {
      const choice = mediaConflictDialog.returnValue;
      resolve(choice === 'overwrite' || choice === 'rename' ? choice : 'skip');
    }, { once: true });
    mediaConflictDialog.showModal();
  });
}

function nextAvailableMediaName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > name.lastIndexOf('/') ? name.slice(0, dot) : name;
  const extension = dot > name.lastIndexOf('/') ? name.slice(dot) : '';
  const existingNames = new Set(media.map((item) => item.name.toLocaleLowerCase()));
  let suffix = 2;
  let candidate = `${base} (${suffix})${extension}`;
  while (existingNames.has(candidate.toLocaleLowerCase())) {
    suffix += 1;
    candidate = `${base} (${suffix})${extension}`;
  }
  return candidate;
}

function isSupportedMediaCandidate(file: File): boolean {
  return /\.(?:jpe?g|png|webp|mp4|webm|pkg)$/i.test(file.name);
}

async function clearAllMedia(): Promise<void> {
  if (!media.length) return;
  const count = media.length;
  if (!window.confirm(`确定清除全部 ${count} 项已导入壁纸吗？仅清除 LocalTab 中的导入记录及本地副本，不会删除原始文件或文件夹。`)) return;
  try {
    await deleteAssets(media.map((item) => item.id));
    media = [];
    hideImportStatus();
    settings.currentMediaId = null;
    settings.previousMediaId = null;
    scheduleAutomaticSwitch();
    await persist();
    renderAll();
    notify(`已清除全部壁纸（${count} 项）。`);
  } catch (error) {
    notify(`清除壁纸失败：${errorMessage(error)}`);
  }
}

async function handleMediaAction(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-id], button[data-playlist-id]');
  if (!button) return;
  if (button.dataset.playlistId) {
    const index = playlistEntries.findIndex((entry) => entry.id === button.dataset.playlistId);
    if (index < 0) return;
    const entry = playlistEntries[index];
    if (button.classList.contains('media-play')) {
      await playWallpaperEngineEntry(entry.id, {});
      return;
    }
    if (button.classList.contains('media-properties')) {
      await showWallpaperEngineProperties(entry.id);
      return;
    }
    // × 把该条目移出背景列表与随机池；重新导入配置后仍保持移除，可用“恢复已移除”找回。
    await removePlaylistEntry(entry);
    entry.removed = true;
    const remainingEntries = playlistEntries.filter((item) => !item.removed);
    const remaining = remainingEntries.length;
    const wasCurrent = settings.currentWallpaperEngineId === entry.id;
    if (wasCurrent) {
      settings.currentWallpaperEngineId = null;
      settings.previousWallpaperEngineId = null;
      currentWeAsset = undefined;
      releaseActiveUrl();
    }
    await persist();
    renderAll();
    // 移除的正是当前背景时立刻自动换一张，不让页面停在无背景状态。
    if (wasCurrent && remaining > 0) {
      notify(`已从背景列表移除：${wallpaperEngineDisplayName(entry)}，正在自动切换背景（剩余 ${remaining} 项）。`);
      await playRandomWallpaperEngineEntry({ reason: 'recover' });
      return;
    }
    notify(`已从背景列表移除：${wallpaperEngineDisplayName(entry)}（剩余 ${remaining} 项，可用“恢复已移除”找回）`);
    return;
  }
  const asset = media.find((item) => item.id === button.dataset.id);
  if (!asset) return;
  if (button.classList.contains('media-play')) {
    settings.currentMediaId = asset.id;
    settings.previousMediaId = null;
    renderAll();
    await persist();
    return;
  }
  const answer = window.confirm(`确定删除“${asset.name}”吗？只会删除 LocalTab 中的副本，不会删除磁盘原文件。`);
  if (!answer) return;
  await deleteAsset(asset.id);
  media = media.filter((item) => item.id !== asset.id);
  if (settings.currentMediaId === asset.id) {
    settings.currentMediaId = media[0]?.id ?? null;
    settings.previousMediaId = null;
  }
  await persist();
  renderAll();
  notify(`已删除：${asset.name}`);
}

async function stepMedia(direction: 1 | -1): Promise<void> {
  if (settings.backgroundSource === 'wallpaper-engine') {
    if (!playlistEntries.length) {
      notify('请先选择 Wallpaper Engine 配置文件。');
      return;
    }
    await playRandomWallpaperEngineEntry({ reason: 'manual' });
    return;
  }
  if (!media.length) {
    notify('先导入图片、视频或 Wallpaper Engine 场景包作为壁纸。');
    return;
  }
  const currentIndex = media.findIndex((item) => item.id === settings.currentMediaId);
  const nextIndex = (currentIndex + direction + media.length) % media.length;
  const next = media[nextIndex];
  settings.previousMediaId = settings.currentMediaId;
  settings.currentMediaId = next.id;
  renderAll();
  await persist();
}

function chooseRandomMedia(): MediaAsset | undefined {
  const candidates = media.filter((item) => item.id !== settings.previousMediaId && item.id !== settings.currentMediaId);
  const pool = candidates.length ? candidates : media.filter((item) => item.id !== settings.currentMediaId);
  return pool[Math.floor(Math.random() * pool.length)];
}

async function recoverFailedMedia(failedId: string): Promise<void> {
  if (settings.backgroundSource === 'wallpaper-engine') {
    if (settings.currentWallpaperEngineId !== failedId) return;
    renderAttempt += 1;
    // 先确认通道：权限/开关被关掉时不再空转，直接说明原因。
    if (!(await verifyDirectChannel())) {
      currentWeAsset = undefined;
      settings.currentWallpaperEngineId = null;
      renderAll();
      await persist();
      updateWeStatus();
      notify(localFileHint());
      return;
    }
    if (renderAttempt >= 3 || playlistEntries.length === 0) {
      currentWeAsset = undefined;
      settings.currentWallpaperEngineId = null;
      renderAll();
      await persist();
      notify('连续多个背景无法播放（文件可能已被移动或格式不受支持），已回退到默认背景。');
      return;
    }
    await markWallpaperEngineMissing(failedId, '播放失败');
    notify('该背景无法播放（文件可能已被移动或格式不受支持），已标记为缺失并切换到其他背景。');
    await playRandomWallpaperEngineEntry({ reason: 'recover' });
    return;
  }
  if (settings.currentMediaId !== failedId) return;
  renderAttempt += 1;
  if (renderAttempt >= media.length || media.length === 0) {
    settings.currentMediaId = null;
    renderAll();
    await persist();
    notify('当前列表中的媒体无法播放，已回退到默认背景。');
    return;
  }
  const failedIndex = media.findIndex((item) => item.id === failedId);
  settings.currentMediaId = media[(failedIndex + 1) % media.length].id;
  renderAll();
  await persist();
}

function togglePlayback(): void {
  if (sceneRendererFrame && sceneRendererToken) {
    sceneRendererPaused = !sceneRendererPaused;
    sceneRendererFrame.contentWindow?.postMessage({
      type: sceneRendererPaused ? 'pause' : 'resume',
      token: sceneRendererToken,
    }, '*');
    renderPlaybackStatus();
    return;
  }
  const video = $('backdrop').querySelector('video');
  if (!video) {
    notify('当前壁纸不是视频。');
    return;
  }
  if (video.paused) {
    void video.play().then(renderPlaybackStatus).catch(() => notify('视频无法播放，请尝试其他文件。'));
  } else {
    video.pause();
    renderPlaybackStatus();
  }
}

function openShortcutEditor(shortcut?: Shortcut): void {
  shortcutForm.reset();
  $('form-error').textContent = '';
  ($('shortcut-id') as HTMLInputElement).value = shortcut?.id ?? '';
  ($('shortcut-name') as HTMLInputElement).value = shortcut?.name ?? '';
  ($('shortcut-url') as HTMLInputElement).value = shortcut?.url ?? '';
  $('dialog-title').textContent = shortcut ? '编辑快捷方式' : '添加快捷方式';
  shortcutDialog.showModal();
  ($('shortcut-name') as HTMLInputElement).focus();
}

function closeShortcutEditor(): void {
  shortcutDialog.close();
  $('add-shortcut').focus();
}

async function submitShortcut(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const id = ($('shortcut-id') as HTMLInputElement).value;
  const name = ($('shortcut-name') as HTMLInputElement).value.trim();
  const url = ($('shortcut-url') as HTMLInputElement).value.trim();
  const error = $('form-error');
  if (!name) {
    error.textContent = '请填写快捷方式名称。';
    return;
  }
  if (!isValidShortcutUrl(url)) {
    error.textContent = '网址仅支持 http:// 或 https://，不允许 javascript:、data: 等协议。';
    return;
  }
  const existing = settings.shortcuts.find((shortcut) => shortcut.id === id);
  if (!existing && settings.shortcuts.length >= 18) {
    error.textContent = '最多添加 18 个快捷方式。';
    return;
  }

  const shortcut: Shortcut = { id: existing?.id ?? crypto.randomUUID(), name, url };
  if (existing) {
    settings.shortcuts = settings.shortcuts.map((item) => item.id === existing.id ? shortcut : item);
  } else {
    settings.shortcuts.push(shortcut);
  }
  await persist();
  renderShortcuts();
  renderShortcutManager();
  closeShortcutEditor();
  notify(existing ? '快捷方式已更新。' : '快捷方式已添加。');
  void syncShortcutIcons()
    .then((report) => reportIconSync(settings.iconSource, report))
    .catch((error: unknown) => notify(`同步网站图标失败：${errorMessage(error)}`));
}

async function handleShortcutManagerAction(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button) return;
  const id = button.dataset.id;
  if (button.classList.contains('shortcut-edit')) {
    const shortcut = settings.shortcuts.find((item) => item.id === id);
    if (shortcut) openShortcutEditor(shortcut);
    return;
  }
  if (button.classList.contains('shortcut-delete') && id) {
    const shortcut = settings.shortcuts.find((item) => item.id === id);
    if (!shortcut || !window.confirm(`删除快捷方式“${shortcut.name}”？`)) return;
    settings.shortcuts = settings.shortcuts.filter((item) => item.id !== id);
    await persist();
    renderShortcuts();
    renderShortcutManager();
    return;
  }
  const index = Number(button.dataset.index);
  if (button.classList.contains('shortcut-up') && index > 0) {
    [settings.shortcuts[index - 1], settings.shortcuts[index]] = [settings.shortcuts[index], settings.shortcuts[index - 1]];
    await persist();
    renderShortcuts();
    renderShortcutManager();
  } else if (button.classList.contains('shortcut-down') && index < settings.shortcuts.length - 1) {
    [settings.shortcuts[index + 1], settings.shortcuts[index]] = [settings.shortcuts[index], settings.shortcuts[index + 1]];
    await persist();
    renderShortcuts();
    renderShortcutManager();
  }
}

function reorderShortcut(fromId: string, toId: string): void {
  const from = settings.shortcuts.findIndex((item) => item.id === fromId);
  const to = settings.shortcuts.findIndex((item) => item.id === toId);
  if (from < 0 || to < 0) return;
  const [item] = settings.shortcuts.splice(from, 1);
  settings.shortcuts.splice(to, 0, item);
  void persist();
  renderShortcuts();
  renderShortcutManager();
}

async function exportBackup(): Promise<void> {
  try {
    const source = settings.iconSource;
    const icons: Record<string, { type: string; data: string }> = {};
    for (const shortcut of settings.shortcuts) {
      const domain = normalizedDomain(shortcut.url);
      if (!domain || icons[domain]) continue;
      const asset = await getCachedIcon(source, domain);
      if (asset) icons[domain] = { type: asset.type, data: await blobToDataUrl(asset.blob) };
    }
    const backup = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      settings: {
        ...settings,
        currentMediaId: null,
        previousMediaId: null,
        currentWallpaperEngineId: null,
        previousWallpaperEngineId: null,
      },
      icons,
    };
    downloadJson(backup, `localtab-config-${new Date().toISOString().slice(0, 10)}.json`);
    notify('配置备份已导出（含图标缓存，不含媒体文件）。');
  } catch (error) {
    notify(`导出失败：${errorMessage(error)}`);
  }
}

async function importBackup(file: File): Promise<void> {
  if (file.size > 5 * 1024 * 1024) {
    notify('备份文件超过 5 MB 限制。');
    return;
  }
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const backup = validateBackup(parsed);
    const replace = window.confirm('点击“确定”替换现有配置；点击“取消”则合并快捷方式。替换前不会自动下载恢复点，如需保留当前配置请先导出 JSON。');
    const importedShortcuts: Shortcut[] = [];
    for (const entry of backup.settings.shortcuts) {
      const domain = normalizedDomain(entry.url);
      const icon = domain ? backup.icons[domain] : undefined;
      if (icon && domain) {
        const blob = dataUrlToBlob(icon.data, icon.type);
        const asset: MediaAsset = {
          id: iconCacheId(backup.settings.iconSource, domain),
          name: `${domain} (${backup.settings.iconSource})`,
          type: icon.type,
          kind: 'icon',
          size: blob.size,
          importedAt: Date.now(),
          hash: `${backup.settings.iconSource}:${domain}`,
          width: 64,
          height: 64,
          source: backup.settings.iconSource,
          domain,
          blob,
        };
        await saveAsset(asset);
      }
      importedShortcuts.push(entry);
    }
    const nextSettings: AppSettings = {
      ...(replace ? DEFAULT_SETTINGS : settings),
      ...backup.settings,
      currentMediaId: media.some((item) => item.id === settings.currentMediaId) ? settings.currentMediaId : null,
      previousMediaId: null,
      shortcuts: replace
        ? importedShortcuts.slice(0, 18)
        : [...settings.shortcuts, ...importedShortcuts.filter((item) => !settings.shortcuts.some((saved) => saved.url === item.url))].slice(0, 18),
    };
    settings = nextSettings;
    if (settings.backgroundSource === 'wallpaper-engine' && playlistEntries.length === 0) {
      settings.backgroundSource = 'library';
    }
    await persist();
    applySettingsToControls();
    renderAll();
    notify(`导入完成：恢复 ${importedShortcuts.length} 个快捷方式。`);
  } catch (error) {
    notify(`导入失败：${errorMessage(error)}`);
  }
}

interface BackupData {
  schemaVersion: number;
  settings: AppSettings;
  icons: Record<string, { type: string; data: string }>;
}

function validateBackup(value: unknown): BackupData {
  if (!value || typeof value !== 'object') throw new Error('JSON 根节点格式不正确。');
  const record = value as Partial<BackupData>;
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error('备份版本不受支持。');
  }
  if (!record.settings || !Array.isArray(record.settings.shortcuts)) {
    throw new Error('备份数据结构不受支持。');
  }
  if (record.settings.shortcuts.length > 100) throw new Error('快捷方式数量异常。');
  const shortcuts: Shortcut[] = [];
  for (const entry of record.settings.shortcuts) {
    if (!entry || typeof entry.name !== 'string' || entry.name.length > 40 || typeof entry.url !== 'string' || !isValidShortcutUrl(entry.url)) {
      throw new Error('备份中含有无效名称或不安全网址。');
    }
    shortcuts.push({ id: crypto.randomUUID(), name: entry.name, url: entry.url });
  }
  const rawIcons = record.icons && typeof record.icons === 'object' ? record.icons : {};
  const icons: Record<string, { type: string; data: string }> = {};
  for (const [key, icon] of Object.entries(rawIcons)) {
    if (!icon || !['image/png', 'image/jpeg', 'image/webp'].includes(icon.type) || typeof icon.data !== 'string' || icon.data.length > 3_000_000) {
      throw new Error('备份中的图标格式或大小不符合要求。');
    }
    icons[key] = { type: icon.type, data: icon.data };
  }
  const iconSource: IconSource = record.settings.iconSource === 'international' ? 'international' : 'domestic';
  const searchEngine = SEARCH_ENGINES.some((engine) => engine.id === record.settings!.searchEngine)
    ? record.settings!.searchEngine as SearchEngineId
    : DEFAULT_SETTINGS.searchEngine;
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    settings: {
      shortcuts,
      playbackMode: ['random', 'order', 'fixed'].includes(record.settings.playbackMode) ? record.settings.playbackMode : 'random',
      switchIntervalMinutes: Number.isInteger(record.settings.switchIntervalMinutes) && record.settings.switchIntervalMinutes! >= 1 && record.settings.switchIntervalMinutes! <= 1440
        ? record.settings.switchIntervalMinutes!
        : DEFAULT_SETTINGS.switchIntervalMinutes,
      currentMediaId: null,
      previousMediaId: null,
      backgroundSource: record.settings.backgroundSource === 'wallpaper-engine' ? 'wallpaper-engine' : 'library',
      currentWallpaperEngineId: null,
      previousWallpaperEngineId: null,
      wallpaperConfigName: typeof record.settings.wallpaperConfigName === 'string'
        ? record.settings.wallpaperConfigName.slice(0, 200)
        : '',
      wallpaperConfigPath: typeof record.settings.wallpaperConfigPath === 'string'
        ? record.settings.wallpaperConfigPath.slice(0, 500)
        : '',
      iconSource,
      searchEngine,
      controlsCollapsed: record.settings.controlsCollapsed === true,
      mediaListCollapsed: record.settings.mediaListCollapsed === true,
    },
    icons,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图标失败。'));
    reader.onerror = () => reject(reader.error ?? new Error('读取图标失败。'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(data: string, mime: string): Blob {
  const comma = data.indexOf(',');
  if (!data.startsWith(`data:${mime};base64,`) || comma < 0) throw new Error('备份图标内容无效。');
  const binary = atob(data.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('备份图标超过 2 MB。');
  return new Blob([bytes], { type: mime });
}

function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createButton(label: string, accessibleName: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', accessibleName);
  button.className = `item-action ${className}`;
  return button;
}

function makeInitial(name: string): string {
  return [...name.trim()][0]?.toLocaleUpperCase() ?? '?';
}

function releaseActiveUrl(): void {
  sceneRendererFrame?.remove();
  sceneRendererFrame = undefined;
  sceneRendererToken = undefined;
  sceneRendererSent = false;
  sceneRendererPaused = false;
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = undefined;
}

function notify(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3500);
}

function showImportStatus(text: string, hideAfterMs = 0): void {
  importStatus.textContent = text;
  importStatus.hidden = false;
  if (importStatusTimer) window.clearTimeout(importStatusTimer);
  importStatusTimer = hideAfterMs > 0
    ? window.setTimeout(() => { importStatus.hidden = true; }, hideAfterMs)
    : undefined;
}

function hideImportStatus(): void {
  if (importStatusTimer) window.clearTimeout(importStatusTimer);
  importStatusTimer = undefined;
  importStatus.hidden = true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void start();
