// 把插件仓库的使用说明同步进扩展的 docs/（扩展里再打包给用户看）。
//
//   node scripts/sync-docs.mjs           # 复制（插件仓库改了文档后跑一次）
//   node scripts/sync-docs.mjs --check   # 只校验是否同步，过期则非 0 退出
//
// 为什么需要它：扩展内置这 12 篇文档靠的是**人工复制**，没有任何机制保证一致。
// 2026-09-16 就踩过一次：插件侧 06/07/10/11 都改过了（06 新增了 enable/hide 两节、
// 10 新增了复活与热替换排错），扩展里还是旧版 —— 用户装完扩展打开文档，
// 看到的是一份缺了新功能的说明，而且没有任何提示说它过期了。
//
// 源目录是插件仓库的 docs/05-使用说明/（文件名一一对应，直接整篇复制，不改内容）。
// 插件仓库位置：环境变量 LD_PLUGIN_DIR，默认 /home/liu/plugins/liudungeon
// （与 test/lsp-harness.mjs 用同一个变量与默认值）。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN_DIR = process.env.LD_PLUGIN_DIR ?? '/home/liu/plugins/liudungeon';
const SRC = join(PLUGIN_DIR, 'docs/05-使用说明');
const DST = join(ROOT, 'docs');
const checkOnly = process.argv.includes('--check');

if (!existsSync(SRC)) {
    // 插件仓库不在旁边（例如只 clone 了扩展仓库）：明确说清楚，不当成"同步完成"
    console.error('找不到插件文档目录: ' + SRC);
    console.error('设 LD_PLUGIN_DIR 指向插件仓库（含 docs/05-使用说明/）。');
    process.exit(2);
}

const srcFiles = readdirSync(SRC).filter((f) => f.endsWith('.md')).sort();
if (srcFiles.length === 0) {
    console.error('插件文档目录里没有 .md: ' + SRC);
    process.exit(2);
}

mkdirSync(DST, { recursive: true });
const dstFiles = readdirSync(DST).filter((f) => f.endsWith('.md')).sort();

const stale = [];
const added = [];
for (const f of srcFiles) {
    const want = readFileSync(join(SRC, f), 'utf8');
    const cur = existsSync(join(DST, f)) ? readFileSync(join(DST, f), 'utf8') : null;
    if (cur === null) added.push(f);
    else if (cur !== want) stale.push(f);
}
// 扩展里有、插件里已删的：留着就是死文档（用户点开看到的是被删掉的旧内容）
const removed = dstFiles.filter((f) => !srcFiles.includes(f));

if (checkOnly) {
    if (stale.length === 0 && added.length === 0 && removed.length === 0) {
        console.log('✓ 扩展内置文档与插件仓库一致（' + srcFiles.length + ' 篇）');
        process.exit(0);
    }
    console.error('✗ 扩展内置文档与插件仓库不一致：');
    for (const f of stale) console.error('  - 内容过期: ' + f);
    for (const f of added) console.error('  - 插件有、扩展缺: ' + f);
    for (const f of removed) console.error('  - 扩展有、插件已删: ' + f);
    console.error('\n跑 `node scripts/sync-docs.mjs` 同步，再重新打包。');
    process.exit(1);
}

let changed = 0;
for (const f of srcFiles) {
    const want = readFileSync(join(SRC, f), 'utf8');
    const path = join(DST, f);
    if (existsSync(path) && readFileSync(path, 'utf8') === want) continue;
    writeFileSync(path, want);
    console.log('已更新 docs/' + f);
    changed++;
}
for (const f of removed) {
    rmSync(join(DST, f));
    console.log('已删除 docs/' + f + '（插件侧已移除）');
    changed++;
}
console.log(changed === 0
    ? '已是最新（' + srcFiles.length + ' 篇）'
    : '同步完成：' + changed + ' 个文件');
