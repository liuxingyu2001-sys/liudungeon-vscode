// esbuild 打包脚本：把语言服务与扩展主进程分别打成单文件，避免发布时带 node_modules。
import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** 两个入口：扩展主进程（需要 vscode 模块）与语言服务（纯 Node）。 */
const targets = [
  { entry: 'src/client/extension.ts', out: 'out/client/extension.js', external: ['vscode'] },
  { entry: 'src/server/server.ts', out: 'out/server/server.js', external: [] }
];

await rm('out', { recursive: true, force: true });

const options = targets.map((t) => ({
  entryPoints: [t.entry],
  outfile: t.out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  external: t.external,
  logLevel: 'info',
  // 数据文件以 JSON 内联进产物，安装后无需额外路径解析。
  loader: { '.json': 'json' }
}));

if (watch) {
  for (const opt of options) {
    const ctx = await context(opt);
    await ctx.watch();
    console.log(`[watch] ${opt.outfile}`);
  }
} else {
  for (const opt of options) {
    await build(opt);
  }
}
