import { AppSettings, BackgroundSource, DEFAULT_SETTINGS, IconSource, MediaAsset, PlaybackMode, SEARCH_ENGINES, SearchEngineId, Shortcut, WallpaperEngineEntry, buildSearchUrl, isValidShortcutUrl, searchEngineLabel } from './models';
import { captureImagePreview, captureVideoPreview, clearPlaylistPlayed, deleteAsset, deleteAssets, formatBytes, inspectMedia, listAssets, listPlaylistEntries, replacePlaylistEntries, saveAsset, savePlaylistEntry } from './media-db';
import { ICON_SOURCES, clearIconCache, fetchAndCacheIcon, getCachedIcon, hasIconPermission, iconCacheId, normalizedDomain, purgeLegacyUploadedIcons, requestIconPermission } from './icon-resolver';
import { loadSettings, saveSettings } from './storage';
import { mediaPathForEntry, mimeForPlaylistKind, parseWallpaperEngineConfig, readLocalFileViaProtocol, readProjectMetadata, readProjectPreview, toFileUrl } from './wallpaper-engine';
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
const weStatus = $('we-status') as HTMLParagraphElement;
const weRandomButton = $('we-random') as HTMLButtonElement;
const clearWePlayedButton = $('clear-we-played') as HTMLButtonElement;

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
/** Chrome 的“允许访问文件网址”开关状态；undefined 表示当前环境无法查询。 */
let fileSchemeAllowed: boolean | undefined;
const wePreviewJobs = new Set<string>();

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
  $('choose-we-config').addEventListener('click', () => weConfigInput.click());
  weConfigInput.addEventListener('change', () => {
    if (weConfigInput.files?.[0]) void importWallpaperEngineConfig(weConfigInput.files[0]);
    weConfigInput.value = '';
  });
  weRandomButton.addEventListener('click', () => void playRandomWallpaperEngineEntry({ reason: 'manual' }));
  $('we-probe').addEventListener('click', () => void probeDirectFileAccess());
  $('we-check-missing').addEventListener('click', () => void checkMissingWallpaperEngineEntries({ force: true }));
  clearWePlayedButton.addEventListener('click', () => void clearPlayedWallpaperEngineEntries());
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
    ? (settings.backgroundSource === 'wallpaper-engine' ? '展开已播背景列表' : '展开壁纸列表')
    : (settings.backgroundSource === 'wallpaper-engine' ? '折叠已播背景列表' : '折叠壁纸列表'));
}

function updateWeStatus(): void {
  const played = playedWallpaperEngineEntries();
  weRandomButton.disabled = playlistEntries.length === 0;
  clearWePlayedButton.disabled = played.length === 0;
  if (settings.backgroundSource !== 'wallpaper-engine') {
    weStatus.hidden = true;
    return;
  }
  if (playlistEntries.length === 0) {
    weStatus.hidden = false;
    weStatus.textContent = '尚未读取 Wallpaper Engine 配置。点击“选择 WE 配置”读取 config.json 中的 playlist.items 地址。';
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
    weStatus.textContent = `Chrome 的“允许访问文件网址”当前是关闭的${needed}：请在 chrome://extensions 打开本扩展的详情页勾选该项，然后点击“检测文件直读”确认。`;
    return;
  }
  weStatus.textContent = `读不到本地背景文件${needed}。若已在 chrome://extensions 打开本扩展的“允许访问文件网址”，请点击“检测文件直读”重新确认一次。`;
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
  const played = playedWallpaperEngineEntries();
  const missing = playlistEntries.filter((entry) => entry.missing);
  const listed = [
    ...played.filter((entry) => !entry.missing),
    ...missing.sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0)),
  ];
  const available = playlistEntries.length - missing.length;
  $('media-count').textContent = playlistEntries.length
    ? `播放列表 ${playlistEntries.length} 项 · 可用 ${available} 项${missing.length ? ` · 缺失 ${missing.length} 项` : ''}`
    : '尚未读取 Wallpaper Engine 配置';
  const query = mediaSearch.value.trim().toLocaleLowerCase();
  const visible = query
    ? listed.filter((entry) =>
      (entry.title ?? '').toLocaleLowerCase().includes(query) ||
      entry.name.toLocaleLowerCase().includes(query))
    : listed;
  mediaListCount.textContent = query
    ? `背景列表（${visible.length} / ${listed.length} 项）`
    : `背景列表（已播 ${played.filter((entry) => !entry.missing).length} · 缺失 ${missing.length}）`;
  if (!playlistEntries.length) {
    mediaListEmpty.textContent = '尚未读取 Wallpaper Engine 配置。';
  } else if (!listed.length) {
    mediaListEmpty.textContent = '还没有播放过的背景。点击“随机换一张”开始。';
  } else {
    mediaListEmpty.textContent = '没有匹配的背景。';
  }
  mediaListEmptyShouldShow = visible.length === 0;
  mediaListEmpty.hidden = !mediaListEmptyShouldShow;
  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = entry.missing ? 'media-row is-missing' : 'media-row';
    const preview = document.createElement('div');
    preview.className = 'media-preview';
    if (entry.preview) {
      const previewUrl = URL.createObjectURL(entry.preview);
      mediaPreviewUrls.push(previewUrl);
      preview.style.backgroundImage = `url("${previewUrl}")`;
    } else {
      preview.textContent = entry.missing ? '⚠' : entry.kind === 'scene' ? '◈' : entry.kind === 'video' ? '▶' : '▧';
    }
    const info = document.createElement('div');
    info.className = 'item-info';
    const displayName = wallpaperEngineDisplayName(entry);
    const name = document.createElement('strong');
    name.textContent = displayName;
    const detail = document.createElement('small');
    const kindLabel = entry.kind === 'video' ? '视频' : entry.kind === 'scene' ? '场景包' : '图片';
    detail.textContent = entry.missing ? `${kindLabel} · 缺失（文件不存在）` : `${kindLabel} · 已播放`;
    info.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const play = createButton(entry.id === settings.currentWallpaperEngineId ? '✓' : entry.missing ? '↻' : '▶',
      entry.missing ? `重试 ${displayName}` : `播放 ${displayName}`, 'media-play');
    play.dataset.playlistId = entry.id;
    const remove = createButton('×', `从背景列表移除 ${displayName}`, 'media-delete');
    remove.dataset.playlistId = entry.id;
    actions.append(play, remove);
    row.append(preview, info, actions);
    mediaList.append(row);
  }
  applyMediaListCollapsed();
}

function activeBackgroundAsset(): MediaAsset | undefined {
  if (settings.backgroundSource === 'wallpaper-engine') return currentWeAsset;
  return media.find((item) => item.id === settings.currentMediaId);
}

function activePoolSize(): number {
  return settings.backgroundSource === 'wallpaper-engine' ? playlistEntries.length : media.length;
}

function playedWallpaperEngineEntries(): WallpaperEngineEntry[] {
  return playlistEntries
    .filter((entry) => Boolean(entry.playedAt))
    .sort((a, b) => (b.playedAt ?? 0) - (a.playedAt ?? 0));
}

function wallpaperEngineDisplayName(entry: WallpaperEngineEntry): string {
  const title = entry.title?.trim();
  if (title) return title;
  if (entry.name.toLowerCase() === 'scene.pkg') {
    const parts = entry.path.split('/');
    const parent = parts[parts.length - 2];
    if (parent) return `${parent}/${entry.name}`;
  }
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
  if (!playlistEntries.length) return undefined;
  const usable = availableWallpaperEngineEntries();
  if (!usable.length) return undefined;
  const current = settings.currentWallpaperEngineId;
  const previous = settings.previousWallpaperEngineId;
  const preferred = usable.filter((entry) => entry.id !== current && entry.id !== previous);
  const pool = preferred.length ? preferred : usable.filter((entry) => entry.id !== current);
  return pool[Math.floor(Math.random() * pool.length)] ?? usable[0];
}

/**
 * 可参与随机播放的条目：排除已确认缺失的背景。
 * 如果全部都被标记缺失（例如整个盘符被拔掉），退回完整列表以便重新探测。
 */
function availableWallpaperEngineEntries(): WallpaperEngineEntry[] {
  const usable = playlistEntries.filter((entry) => !entry.missing);
  return usable.length ? usable : playlistEntries;
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
  const current = playlistEntries.find((entry) => entry.id === settings.currentWallpaperEngineId);
  if (current && await playWallpaperEngineEntry(current.id, { silent: true })) {
    void backfillWallpaperEngineMetadata();
    return;
  }
  await playRandomWallpaperEngineEntry({ reason: 'manual' });
  void backfillWallpaperEngineMetadata();
}

async function playRandomWallpaperEngineEntry(options: { reason: 'manual' | 'auto' | 'recover' }): Promise<void> {
  if (!playlistEntries.length) {
    if (options.reason === 'manual') notify('请先选择 Wallpaper Engine 配置文件。');
    return;
  }
  const initialCurrent = settings.currentWallpaperEngineId;
  const usable = availableWallpaperEngineEntries();
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
 * 检查播放列表条目的文件是否存在，并把结果标记到条目上。
 * `force` 为真时重新检查全部非场景条目，否则只检查尚未检查过的。
 */
async function checkMissingWallpaperEngineEntries(options: { force?: boolean; silent?: boolean } = {}): Promise<void> {
  if (!playlistEntries.length || weCheckRunning) return;
  if (!IS_EXTENSION_CONTEXT) {
    if (!options.silent) notify('当前是开发预览页面，无法检查本地文件。');
    return;
  }
  if (!(await verifyDirectChannel())) {
    updateWeStatus();
    if (!options.silent) notify(localFileHint());
    return;
  }
  const targets = playlistEntries.filter((entry) => entry.kind !== 'scene' && (options.force || !entry.checkedAt));
  if (!targets.length) {
    if (!options.silent) notify('所有背景都已检查过；如需重新检查，请再点一次“检查缺失”。');
    return;
  }
  weCheckRunning = true;
  const queue = targets.slice();
  const total = queue.length;
  let done = 0;
  let missingCount = 0;
  let restoredCount = 0;
  const reportProgress = (): void => {
    if (!options.silent) showImportStatus(`正在检查背景：${done}/${total}\n已发现缺失：${missingCount}`);
  };
  reportProgress();
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const exists = await probeWallpaperEngineEntry(entry);
      done += 1;
      if (exists === false) {
        if (!entry.missing) {
          missingCount += 1;
          await markWallpaperEngineMissing(entry.id, '检查时未找到文件', false);
        }
      } else if (exists === true && entry.missing) {
        restoredCount += 1;
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
    renderMediaList();
    updateWeStatus();
  }
  if (options.silent) return;
  hideImportStatus();
  const parts = [`已检查 ${total} 项`];
  if (missingCount) parts.push(`新发现 ${missingCount} 项缺失（已从随机播放中排除）`);
  if (restoredCount) parts.push(`${restoredCount} 项已恢复`);
  if (!missingCount && !restoredCount) parts.push('全部存在');
  notify(`${parts.join('，')}。场景包需整包解析，未参与本次检查。`);
}

/** 是否为已加载的扩展页面（chrome-extension:// 或具备 runtime.id）。 */
const IS_EXTENSION_CONTEXT = location.protocol === 'chrome-extension:' ||
  Boolean((globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);

function localFileHint(): string {
  if (!IS_EXTENSION_CONTEXT) {
    return '当前是开发预览页面：浏览器禁止普通网页读取本地文件（file://），请用已加载的扩展打开新标签页测试。';
  }
  if (fileSchemeAllowed === false) {
    return 'Chrome 的“允许访问文件网址”当前是关闭的：请在 chrome://extensions 打开本扩展详情页勾选该项，再点击“检测文件直读”。';
  }
  if (directReadState === 'ok') {
    return '这张背景读取失败（文件可能已被移动或删除），已尝试切换到其他背景。';
  }
  return '读不到本地背景文件。请点击“检测文件直读”重新确认一次。';
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
  const metadata = await readProjectMetadata(entry.path);
  if (metadata) await applyWallpaperEngineMetadata(entry.id, metadata);
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
      await applyWallpaperEnginePreview(entryId, projectPreview, true);
      return;
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

async function applyWallpaperEngineMetadata(entryId: string, metadata: { title?: string; preview?: string }): Promise<void> {
  const index = playlistEntries.findIndex((item) => item.id === entryId);
  if (index < 0) return;
  const entry = playlistEntries[index];
  const title = metadata.title?.trim();
  if ((!title || title === entry.title) && (!metadata.preview || metadata.preview === entry.previewFile)) return;
  const updated: WallpaperEngineEntry = {
    ...entry,
    ...(title ? { title } : {}),
    ...(metadata.preview ? { previewFile: metadata.preview } : {}),
  };
  playlistEntries[index] = updated;
  try {
    await savePlaylistEntry(updated);
  } catch (error) {
    console.warn(`保存 Wallpaper Engine 项目信息失败：${errorMessage(error)}`);
  }
  renderMediaList();
}

/**
 * 为已播记录补齐项目名与项目预览图（同目录 project.json），只处理列表中可见的已播条目，
 * 避免为整份播放列表逐个读取文件。
 */
async function backfillWallpaperEngineMetadata(): Promise<boolean> {
  const pending = playlistEntries.filter((entry) => Boolean(entry.playedAt) &&
    (!entry.title || (entry.previewFile && !entry.previewFromProject)));
  if (!pending.length || directReadState !== 'ok') return false;
  let updated = false;
  for (const entry of pending) {
    const metadata = await readProjectMetadata(entry.path, directFileReader);
    if (!metadata) continue;
    await applyWallpaperEngineMetadata(entry.id, metadata);
    updated = true;
    if (metadata.preview) {
      const projectPreview = await readProjectPreview(entry.path, metadata.preview, directFileReader);
      if (projectPreview) await applyWallpaperEnginePreview(entry.id, projectPreview, true);
    }
  }
  return updated;
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

async function importWallpaperEngineConfig(file: File): Promise<void> {
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
    playlistEntries = await replacePlaylistEntries(parsed.entries);
    settings.wallpaperConfigName = file.name;
    settings.backgroundSource = 'wallpaper-engine';
    if (!playlistEntries.some((entry) => entry.id === settings.currentWallpaperEngineId)) {
      settings.currentWallpaperEngineId = null;
      currentWeAsset = undefined;
    }
    await persist();
    applySettingsToControls();
    renderAll();
    const skipped = parsed.skipped
      ? `，跳过 ${parsed.skipped} 项（网页壁纸 ${parsed.skippedWeb}、其它 ${parsed.skippedOther}）`
      : '';
    notify(`已读取 ${parsed.entries.length} 个背景${skipped}。`);
    void enterWallpaperEngineMode();
    // 导入后自动检查一次文件是否存在，把缺失项从随机播放中排除。
    void checkMissingWallpaperEngineEntries();
  } catch (error) {
    notify(`读取 Wallpaper Engine 配置失败：${errorMessage(error)}`);
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
    if (settings.backgroundSource === 'wallpaper-engine') {
      await playRandomWallpaperEngineEntry({ reason: 'manual' });
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

function shuffleEntries<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

/** 是否已有任何可用壁纸：本地媒体库有导入，或播放列表里有背景。 */
function hasAnyWallpaper(): boolean {
  return media.length > 0 || playlistEntries.length > 0;
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
  fallbackUsed: number;
  failures: Array<{ domain: string; message: string }>;
  permissionDenied: boolean;
}

async function syncShortcutIcons(): Promise<IconSyncReport> {
  const targets = new Map<string, string>();
  for (const shortcut of settings.shortcuts) {
    const domain = normalizedDomain(shortcut.url);
    if (domain && !targets.has(domain)) targets.set(domain, shortcut.url);
  }
  if (!targets.size) return { updated: 0, fallbackUsed: 0, failures: [], permissionDenied: false };
  const source = settings.iconSource;
  if (!(await hasIconPermission(source))) return { updated: 0, fallbackUsed: 0, failures: [], permissionDenied: true };
  let updated = 0;
  let fallbackUsed = 0;
  const failures: IconSyncReport['failures'] = [];
  for (const [domain, pageUrl] of targets) {
    try {
      if (await getCachedIcon(source, domain)) continue;
      const result = await fetchAndCacheIcon(source, domain, pageUrl);
      if (result.fallbackUsed) fallbackUsed += 1;
      updated += 1;
    } catch (error) {
      failures.push({ domain, message: errorMessage(error) });
    }
  }
  if (updated > 0) {
    renderShortcuts();
  }
  return { updated, fallbackUsed, failures, permissionDenied: false };
}

function reportIconSync(source: IconSource, report: IconSyncReport): void {
  if (report.permissionDenied) {
    notify(`尚未授权${ICON_SOURCES[source].label}。请点击“按当前来源重新获取图标”并允许权限。`);
    return;
  }
  for (const failure of report.failures) console.warn(`获取 ${failure.domain} 的图标失败：${failure.message}`);
  if (!report.failures.length) {
    if (report.updated) {
      const fallback = report.fallbackUsed ? `（其中 ${report.fallbackUsed} 个由 Chrome 内置图标回退获取）` : '';
      notify(`已获取并缓存 ${report.updated} 个网站图标${fallback}。`);
    }
    return;
  }
  const details = report.failures.slice(0, 2).map(({ domain, message }) => `${domain}：${message}`).join('；');
  const remaining = report.failures.length > 2 ? `，另有 ${report.failures.length - 2} 个失败，详情见控制台` : '';
  const fallback = report.fallbackUsed ? `（${report.fallbackUsed} 个使用 Chrome 内置图标回退）` : '';
  notify(`图标获取成功 ${report.updated} 个，失败 ${report.failures.length} 个${fallback}。${details}${remaining}`);
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
  try {
    const bytes = await current.blob.arrayBuffer();
    if (sceneRendererFrame !== frame || sceneRendererToken !== token) return;
    frame.contentWindow.postMessage({
      type: 'load',
      token,
      bytes,
      key: `localtab:${current.id}`,
      title: current.name,
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
    const updated: WallpaperEngineEntry = { ...entry, playedAt: undefined, preview: undefined };
    playlistEntries[index] = updated;
    await savePlaylistEntry(updated);
    renderMediaList();
    updateWeStatus();
    notify(`已从已播背景列表移除：${entry.name}`);
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
    const replace = window.confirm('点击“确定”替换现有配置；点击“取消”则合并快捷方式。替换前会自动下载当前配置恢复点。');
    if (replace) await exportBackup();
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
  const iconSource: IconSource = record.settings.iconSource === 'browser'
    ? 'browser'
    : record.settings.iconSource === 'international' ? 'international' : 'domestic';
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
