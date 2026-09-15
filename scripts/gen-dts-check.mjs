// 生成 .liudungeon/liudungeon.d.ts 并用 tsc 检查语法，供自检脚本调用。
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'lddts-'));
const outfile = join(dir, 'gen.cjs');
await build({
  entryPoints: ['src/client/gen-dts.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
  loader: { '.json': 'json' }
});
const mod = await import(pathToFileURL(outfile).href);
const fn = mod.default?.default ?? mod.default ?? mod.generateDts;
const dts = fn('');

const target = join(dir, 'liudungeon.d.ts');
writeFileSync(target, dts, 'utf-8');
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--skipLibCheck', '--target', 'es2022', target], { stdio: 'pipe' });
rmSync(dir, { recursive: true, force: true });
console.log('d.ts 语法检查通过');
