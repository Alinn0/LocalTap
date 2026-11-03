import type { PropertyValue, SceneInstance } from 'webwallgl';

type PointerState = { u: number; v: number; buttons: number; mods: number };

type RendererMessage =
  | { type: 'load'; token: string; bytes: ArrayBuffer; key: string; title: string; project?: unknown; properties?: Record<string, PropertyValue>; viewX?: number; viewY?: number }
  | { type: 'properties'; token: string; properties: Record<string, PropertyValue> }
  | { type: 'view'; token: string; x: number; y: number }
  | { type: 'pause' | 'resume'; token: string }
  | ({ type: 'pointer'; token: string } & PointerState)
  | { type: 'pointer-leave'; token: string };

const host = getSceneHost();

let currentToken = '';
let generation = 0;
let paused = false;
let initialFrameCaptured = false;
let pendingPlaybackState: { token: string; paused: boolean } | undefined;
let lastPointer: PointerState | undefined;
let scene: SceneInstance | undefined;
let currentProperties: Record<string, PropertyValue> = {};
/** 画面位置：-100…100，0 为居中。内容比视口大时用它微调取景（X 水平 / Y 垂直）。 */
let currentViewX = 0;
let currentViewY = 0;
let refreshRatePromise: Promise<number> | undefined;
const rendererApi = loadRenderer();

window.addEventListener('message', (event: MessageEvent<RendererMessage>) => {
  if (event.source !== parent || !event.data || typeof event.data.token !== 'string') return;
  const message = event.data;
  if (message.type === 'load') {
    void loadScene(message);
    return;
  }
  if (message.token !== currentToken) {
    if (message.type === 'pause' || message.type === 'resume') {
      pendingPlaybackState = { token: message.token, paused: message.type === 'pause' };
    }
    return;
  }
  if (message.type === 'properties') {
    if (message.token !== currentToken) return;
    currentProperties = { ...message.properties };
    scene?.setProperties(currentProperties);
    return;
  }
  if (message.type === 'view') {
    currentViewX = clampViewOffset(message.x);
    currentViewY = clampViewOffset(message.y);
    applyView();
    return;
  }
  if (message.type === 'pointer') {
    lastPointer = { u: message.u, v: message.v, buttons: message.buttons, mods: message.mods };
    scene?.pushPointer(message.u, message.v, message.buttons, message.mods);
    return;
  }
  if (message.type === 'pointer-leave') {
    scene?.pointerLeave();
    return;
  }
  paused = message.type === 'pause';
  if (initialFrameCaptured) {
    if (paused) scene?.pause();
    else scene?.resume();
  }
});

parent.postMessage({ type: 'renderer-ready' }, '*');

async function loadScene(message: Extract<RendererMessage, { type: 'load' }>): Promise<void> {
  const loadGeneration = ++generation;
  currentToken = message.token;
  currentProperties = { ...(message.properties ?? {}) };
  currentViewX = clampViewOffset(message.viewX);
  currentViewY = clampViewOffset(message.viewY);
  paused = pendingPlaybackState?.token === message.token ? pendingPlaybackState.paused : false;
  pendingPlaybackState = undefined;
  initialFrameCaptured = false;
  scene?.destroy({ releasePkgCache: true });
  scene = undefined;
  try {
    const { bytesSource, mount } = await rendererApi;
    const fps = await detectRefreshRate();
    const instance = await mount(host, {
      source: bytesSource(
        new Uint8Array(message.bytes),
        // 必须带上 project.json 的属性声明：WebWallGL 只有拿到声明才会把
        // setProperties() 的值写回 scene.json 的 {user: ...} 绑定，否则画面不变。
        message.project ?? { type: 'scene', file: 'scene.json', title: message.title },
        message.key,
      ),
      fit: 'cover',
      fps,
      volume: 0,
      scripts: true,
      bake: false,
      properties: currentProperties,
    });
    if (loadGeneration !== generation) {
      instance.destroy({ releasePkgCache: true });
      return;
    }
    scene = instance;
    applyView();
    if (lastPointer) instance.pushPointer(lastPointer.u, lastPointer.v, lastPointer.buttons, lastPointer.mods);
    parent.postMessage({ type: 'scene-ready', token: currentToken }, '*');
    void sendPreview(instance, currentToken);
  } catch (error) {
    if (loadGeneration !== generation) return;
    parent.postMessage({
      type: 'scene-error',
      token: currentToken,
      message: error instanceof Error ? error.message : String(error),
    }, '*');
  }
}

/**
 * 用 requestAnimationFrame 采样估算显示器刷新率，作为场景渲染的帧率上限，
 * 让动画尽量跑满屏幕刷新率（60/120/144/165/240 Hz）。
 * 采样不足（后台标签页、被节流的渲染环境）时退到 240，等价于跟随 rAF 逐帧渲染。
 */
function detectRefreshRate(): Promise<number> {
  refreshRatePromise ??= new Promise<number>((resolve) => {
    const samples: number[] = [];
    let last = 0;
    let settled = false;
    const finish = (fps: number): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      console.info(`场景渲染帧率上限：${fps} fps`);
      resolve(fps);
    };
    const medianFps = (deltas: number[]): number => {
      const sorted = deltas.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
      return Math.max(24, Math.min(240, Math.round(1000 / median)));
    };
    const timer = window.setTimeout(() => {
      finish(samples.length >= 3 ? medianFps(samples) : 240);
    }, 600);
    const tick = (time: number): void => {
      if (settled) return;
      if (last) samples.push(time - last);
      last = time;
      if (samples.length >= 12) {
        finish(medianFps(samples.slice(3)));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return refreshRatePromise;
}

/**
 * 画面位置调整：把引擎画布按固定倍率放大，再在放大产生的余量里平移，
 * 这样平移时不会露出空白边缘。X / Y 各自独立，均可调（WE 客户端只能调 X）。
 */
const VIEW_OVERSCAN = 0.24;

function clampViewOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

function applyView(): void {
  const canvas = scene?.canvas;
  if (!canvas) return;
  const overscan = VIEW_OVERSCAN * 100;
  const size = `${Math.round((1 + VIEW_OVERSCAN) * 100)}%`;
  // -100 → 0%（贴左/上），0 → 一半余量（居中），100 → 全部余量（贴右/下）。
  const left = (overscan * (currentViewX + 100)) / 200;
  const top = (overscan * (currentViewY + 100)) / 200;
  canvas.style.width = size;
  canvas.style.height = size;
  canvas.style.left = `-${left.toFixed(2)}%`;
  canvas.style.top = `-${top.toFixed(2)}%`;
}

/** 视图尺寸变化后引擎会重设画布属性，这里补回位置样式。 */
window.addEventListener('resize', () => applyView());

async function sendPreview(instance: SceneInstance, token: string): Promise<void> {
  try {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const blob = await captureFrame(instance.canvas);
    if (token !== currentToken) return;
    const bytes = await blob.arrayBuffer();
    parent.postMessage({ type: 'scene-preview', token, bytes }, '*', [bytes]);
  } catch (error) {
    parent.postMessage({
      type: 'scene-preview-error',
      token,
      message: error instanceof Error ? error.message : String(error),
    }, '*');
  } finally {
    if (token === currentToken) {
      initialFrameCaptured = true;
      if (paused) instance.pause();
      else instance.resume();
    }
  }
}

async function captureFrame(canvas: HTMLCanvasElement): Promise<Blob> {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('场景画布不支持 WebGL2 首帧读取。');
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) throw new Error('场景画布尚无有效尺寸。');
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const context = source.getContext('2d');
  if (!context) throw new Error('无法创建首帧预览画布。');
  const image = context.createImageData(width, height);
  const rowSize = width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (height - row - 1) * rowSize;
    image.data.set(pixels.subarray(sourceOffset, sourceOffset + rowSize), row * rowSize);
  }
  context.putImageData(image, 0, 0);

  const scale = Math.min(1, 640 / width);
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(width * scale));
  output.height = Math.max(1, Math.round(height * scale));
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('无法缩放首帧预览。');
  outputContext.drawImage(source, 0, 0, output.width, output.height);
  return new Promise((resolve, reject) => {
    output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码场景首帧预览。')), 'image/jpeg', 0.82);
  });
}

function getSceneHost(): HTMLElement {
  const element = document.getElementById('scene-host');
  if (!element) throw new Error('找不到场景渲染容器。');
  return element;
}

async function loadRenderer(): Promise<typeof import('webwallgl')> {
  try {
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: undefined });
  } catch (error) {
    throw new Error(`无法在隔离渲染环境中禁用持久缓存：${error instanceof Error ? error.message : String(error)}`);
  }
  return import('webwallgl');
}
