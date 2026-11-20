import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { patchCoverAlign, coverAlignPlugin } from '../build/webwallgl-align.ts';

const runtime = fs.readFileSync(new URL('../node_modules/webwallgl/webwallgl.mjs', import.meta.url), 'utf8');
const patched = patchCoverAlign(runtime);
const method = patched.slice(patched.indexOf('    setCoverAlign(x, y)'), patched.indexOf('    setProperties(props)', patched.indexOf('    setCoverAlign(x, y)')));
const compile = (source) => ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }).replace(/export \{\};?/g, '');

test('adapter checks upstream anchors, is idempotent, and handles Windows dev/build paths', () => {
  assert.equal(patchCoverAlign(patched), patched);
  assert.throws(() => patchCoverAlign(runtime.replace('setProperties(props)', 'setProperties(changed)')), /review/);
  assert.throws(() => patchCoverAlign(runtime + runtime), /review/);
  const plugin = coverAlignPlugin();
  assert.equal(plugin.transform(runtime, 'E:/Page/node_modules/webwallgl/webwallgl.mjs').code, patched);
  assert.equal(plugin.transform(runtime, 'E:\\Page\\node_modules\\webwallgl\\webwallgl.mjs?x').code, patched);
  assert.equal(plugin.transform(runtime, 'other.mjs'), undefined);
  assert.ok(patched.includes('rt.sceneCtl.requestViewRender = renderOnce;'));
});

test('actual injected method updates both axes and redraws paused scenes', async () => {
  let redraws = 0;
  const rt = { coverAlign: {}, paused: false, sceneCtl: { requestViewRender: async () => { redraws++; } } };
  const instance = new Function('rt', 'return ({' + method + '})')(rt);
  instance.setCoverAlign(0, 1);
  assert.deepEqual(rt.coverAlign, { x: 0, y: 1, tx: 0, ty: 1 });
  assert.equal(redraws, 0);
  rt.paused = true;
  await instance.setCoverAlign(-2, 4);
  assert.deepEqual(rt.coverAlign, { x: 0, y: 1, tx: 0, ty: 1 });
  assert.equal(redraws, 1);
  await instance.setCoverAlign(NaN, Infinity);
  assert.equal(rt.coverAlign.x, 0.5);
  assert.equal(rt.coverAlign.y, 0.5);
});

test('upstream projection reaches full horizontal/vertical crop without changing scale', () => {
  const start = runtime.indexOf('const DESIGN_ASPECTS =');
  const end = runtime.indexOf('function letterboxBands(');
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(runtime.slice(start, end), context);
  // fitWindow also uses the shared numeric clamp.
  vm.runInContext('function clamp01(v) { return Math.max(0, Math.min(1, v)); }', context);
  for (const [w,h] of [[4000,1000], [1000,4000]]) {
    const a = context.fitWindow('cover',w,h,1000,1000,0,0);
    const b = context.fitWindow('cover',w,h,1000,1000,1,1);
    assert.equal(a.offX,0); assert.equal(a.offY,0);
    assert.equal(b.offX + b.viewW,w); assert.equal(b.offY + b.viewH,h);
    assert.equal(a.viewW,b.viewW); assert.equal(a.viewH,b.viewH);
  }
});

test('renderer maps stored offsets, preserves canvas styles and reapplies on resize', () => {
  const source = fs.readFileSync(new URL('../src/scene-renderer.ts', import.meta.url),'utf8');
  const section = source.slice(source.indexOf('function clampViewOffset'),source.indexOf('async function sendPreview'));
  const events = {};
  const calls = [];
  const canvas = { style: { width:'100%', height:'100%', left:'0', top:'0' } };
  const scene = { canvas, setCoverAlign: (...args) => calls.push(args) };
  const context = vm.createContext({ scene, currentViewX:-100,currentViewY:100, console, window:{addEventListener:(name,fn)=>events[name]=fn} });
  vm.runInContext(compile(section),context);
  context.applyView();
  assert.deepEqual(calls.pop(),[0,1]);
  context.currentViewX=0; context.currentViewY=0;
  events.resize();
  assert.deepEqual(calls.pop(),[0.5,0.5]);
  assert.deepEqual(canvas.style,{width:'100%',height:'100%',left:'0',top:'0'});
  assert.equal(context.clampViewOffset(NaN),0);
  assert.equal(context.clampViewOffset(999),100);
});

test('preview updates both axes without saving; final save remains bound to the original wallpaper', async () => {
  const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url),'utf8');
  const start=source.indexOf('async function applyViewOffsetChange(');
  const end=source.indexOf('function applySceneView(',start);
  const saves=[], previews=[];
  const entries=[{id:'a'},{id:'b'}];
  const context=vm.createContext({playlistEntries:entries,settings:{currentWallpaperEngineId:'a'},CSS:{escape:x=>x},wePropertiesList:{querySelector:()=>null},$:()=>({hidden:false}),applySceneView:e=>previews.push(e),savePlaylistEntry:async e=>saves.push(e),notify:()=>{},errorMessage:String});
  vm.runInContext(compile(source.slice(start,end)),context);
  await context.applyViewOffsetChange('a','x',-100,false);
  await context.applyViewOffsetChange('a','y',100,false);
  assert.equal(saves.length,0); assert.equal(previews.length,2);
  assert.equal(entries[0].viewOffsetX,-100); assert.equal(entries[0].viewOffsetY,100);
  context.settings.currentWallpaperEngineId='b';
  await context.applyViewOffsetChange('a','y',100);
  assert.equal(saves[0].id,'a'); assert.equal(previews.length,2);
  assert.equal(entries[1].viewOffsetX,undefined);
});
