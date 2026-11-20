import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/icon-resolver.ts', import.meta.url), 'utf8');
function harness({ fetcher, granted = true, browser = false } = {}) {
  const assets = new Map(), requests = [], permissions = [];
  const context = { exports: {}, require: () => ({ getAsset: async id => assets.get(id), saveAsset: async asset => assets.set(asset.id, asset) }),
    URL, Blob, Response, AbortController, AbortSignal, Uint8Array, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push(String(url)); return fetcher ? fetcher(String(url), options) : new Response('missing', { status: 404 }); },
    chrome: { permissions: { contains: async () => granted, request: async value => { permissions.push(value); return granted; } }, ...(browser ? { runtime: { getURL: path => `chrome-extension://test${path}` } } : {}) },
    DOMParser: class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; } },
  };
  vm.createContext(context);
  vm.runInContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }) + '\nnormalizeIcon = async blob => blob;', context);
  return { api: context.exports, assets, requests, permissions };
}
test('cache identity keeps scheme, port and path', () => {
  const { api } = harness();
  assert.equal(api.normalizedDomain('https://Example.com:8443/app?q=1'), 'https://example.com:8443/app?q=1');
  assert.equal(api.normalizedDomain('javascript:alert(1)'), undefined);
  assert.notEqual(api.iconCacheId('auto', 'https://a/x'), api.iconCacheId('auto', 'https://a/y'));
});
test('old provider cache is migrated locally without network calls', async () => {
  const { api, assets, requests } = harness();
  assets.set('icon:domestic:example.com', { kind: 'icon', blob: new Blob(['old']) });
  const icon = await api.fetchAndCacheIcon('auto', 'https://example.com/');
  assert.equal(await icon.blob.text(), 'old');
  assert.ok(assets.has('icon:auto:https://example.com/'));
  assert.equal(requests.length, 0);
});
test('explicit authorization requests all HTTP/HTTPS sites in one call', async () => {
  const { api, permissions } = harness();
  await api.requestIconPermission();
  assert.deepEqual(Array.from(permissions[0].origins), ['https://*/*', 'http://*/*']);
});
test('cache hit bypasses both network and permission prompts even when denied', async () => {
  const { api, assets, requests, permissions } = harness({ granted: false });
  const key = api.iconCacheId('auto', 'https://example.com/');
  const old = { kind: 'icon', blob: new Blob(['old']) }; assets.set(key, old);
  assert.equal(await api.fetchAndCacheIcon('auto', 'https://example.com/'), old);
  assert.equal(await api.fetchAndCacheIcon('auto', 'https://example.com/'), old);
  assert.equal(requests.length, 0); assert.equal(permissions.length, 0);
});
test('uncached denied sites skip remote requests without prompting', async () => {
  const { api, requests, permissions } = harness({ granted: false });
  await assert.rejects(api.fetchAndCacheIcon('auto', 'https://example.com/'));
  assert.equal(requests.length, 0); assert.equal(permissions.length, 0);
});
test('browser generic placeholder falls through to root favicon', async () => {
  const { api, requests } = harness({ browser: true, fetcher: url => url.startsWith('chrome-extension:') ? new Response('globe', { headers: { 'content-type': 'image/png' } }) : url.endsWith('/favicon.ico') ? new Response('site-icon', { headers: { 'content-type': 'image/x-icon' } }) : new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) });
  const asset = await api.fetchAndCacheIcon('auto', 'https://example.com/app');
  assert.equal(await asset.blob.text(), 'site-icon');
  assert.ok(requests.includes('https://example.com/favicon.ico'));
  assert.ok(!requests.some(url => url.includes('google.com') || url.includes('baidubce')));
});
test('valid browser icon avoids external requests', async () => {
  const { api, requests } = harness({ browser: true, fetcher: url => new Response(url.includes('localtab-missing') ? 'globe' : 'real-icon', { headers: { 'content-type': 'image/png' } }) });
  await api.fetchAndCacheIcon('auto', 'https://example.com/');
  assert.ok(requests.every(url => url.startsWith('chrome-extension:')));
});
test('oversized responses are rejected and not cached', async () => {
  const { api, assets } = harness({ fetcher: () => new Response(new Uint8Array(1024 * 1024 + 1)) });
  await assert.rejects(api.fetchAndCacheIcon('auto', 'https://example.com/'), /大小限制/);
  assert.equal(assets.size, 0);
});
test('all automatic sources failing never calls former third-party services', async () => {
  const { api, requests } = harness();
  await assert.rejects(api.fetchAndCacheIcon('auto', 'https://example.com/app'));
  assert.deepEqual(requests, ['https://example.com/app', 'https://example.com/favicon.ico']);
});
