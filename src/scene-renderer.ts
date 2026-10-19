import type { SceneInstance } from 'webwallgl';

type PointerState = { u: number; v: number; buttons: number; mods: number };

type RendererMessage =
  | { type: 'load'; token: string; bytes: ArrayBuffer; key: string; title: string }
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
  paused = pendingPlaybackState?.token === message.token ? pendingPlaybackState.paused : false;
  pendingPlaybackState = undefined;
  initialFrameCaptured = false;
  scene?.destroy({ releasePkgCache: true });
  scene = undefined;
  try {
    const { bytesSource, mount } = await rendererApi;
    const instance = await mount(host, {
      source: bytesSource(
        new Uint8Array(message.bytes),
        { type: 'scene', file: 'scene.json', title: message.title },
        message.key,
      ),
      fit: 'cover',
      fps: 30,
      volume: 0,
      scripts: true,
      bake: false,
    });
    if (loadGeneration !== generation) {
      instance.destroy({ releasePkgCache: true });
      return;
    }
    scene = instance;
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
