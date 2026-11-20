/** Build-time adapter for webwallgl 3.0.2; never modifies node_modules. */
const MARKER = '/* localtab-cover-align */';

export function patchCoverAlign(source: string): string {
  if (source.includes(MARKER)) return source;
  const anchor = '    setProperties(props) {\n      const wire = {};';
  const redrawAnchor = '      c.addEventListener(\n        "webglcontextlost",';
  if (source.split(anchor).length !== 2 || source.split(redrawAnchor).length !== 2
    || !source.includes('rt.sceneCtl?.applyUserProperties(wire);')) {
    throw new Error('WebWallGL changed: review the LocalTab cover-align adapter before building.');
  }
  return source.replace(anchor, `
    ${MARKER}
    setCoverAlign(x, y) {
      const clamp = (n) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
      const ax = clamp(x), ay = clamp(y);
      Object.assign(rt.coverAlign, { x: ax, y: ay, tx: ax, ty: ay });
      return rt.paused ? rt.sceneCtl?.requestViewRender?.() : undefined;
    },
${anchor}`).replace(redrawAnchor,
    '      rt.sceneCtl.requestViewRender = renderOnce;\n' + redrawAnchor);
}

export function coverAlignPlugin() {
  return {
    name: 'localtab-webwallgl-cover-align',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.replaceAll('\\', '/').split('?')[0].endsWith('/webwallgl/webwallgl.mjs')) return;
      return { code: patchCoverAlign(code), map: null };
    },
  };
}
