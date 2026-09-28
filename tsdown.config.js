import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/index.js'],
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    format: 'esm',
    platform: 'node',
    dts: false,
  },
  {
    entry: ['src/client/index.js'],
    outDir: 'lib',
    
    minify: false,
    treeshake: false,
    format: 'iife',
    platform: 'browser',
    globalName: '__dshArchiveCenterClient',
    banner: `window.__ModuleLoader__.load({ id: "dsh-archive-center", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    footer: `module.exports = __dshArchiveCenterClient; return module.exports; } });`,
  },
]);
