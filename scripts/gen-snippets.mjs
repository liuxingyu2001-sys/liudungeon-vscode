// 用 esbuild 以「打包成临时 CJS 再执行」的方式跑 TS 版生成器，避免额外的 ts-node 依赖。
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'ldgen-'));
const outfile = join(dir, 'gen.cjs');

await build({
  entryPoints: ['src/client/gen-snippets.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
  loader: { '.json': 'json' }
});

const mod = await import(pathToFileURL(outfile).href);
const fn = mod.default?.default ?? mod.default ?? mod.generate;
if (typeof fn !== 'function') {
  throw new Error('生成器没有导出可调用函数：' + Object.keys(mod).join(', '));
}
fn();
rmSync(dir, { recursive: true, force: true });
console.log('snippets/liudungeon-js.code-snippets, snippets/liudungeon-yaml.code-snippets 已更新');
