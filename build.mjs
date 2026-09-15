// 构建入口：先按 API 数据生成片段文件，再用 esbuild 打包扩展与语言服务。
//   node build.mjs            开发构建（带 sourcemap）
//   node build.mjs --watch    监听
//   node build.mjs --production  压缩（打包 .vsix 用）
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

mkdirSync('out', { recursive: true });

// 1. 生成片段（需要先编译 TS，故走 esbuild 的 register 能力：直接调用 node 版脚本生成）
const gen = spawnSync(process.execPath, ['scripts/gen-snippets.mjs'], { stdio: 'inherit' });
if (gen.status !== 0) {
    console.error('生成片段失败');
    process.exit(gen.status ?? 1);
}

// 2. 打包
const args = ['esbuild.mjs'];
if (production) args.push('--production');
if (watch) args.push('--watch');
const build = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(build.status ?? 0);
