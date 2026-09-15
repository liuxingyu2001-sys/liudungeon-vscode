// .vsix 内容校验：打包出来的东西必须"只有该有的文件"。
//
//   node scripts/check-vsix.mjs [liudungeon-script.vsix]
//
// 为什么需要它：.vscodeignore 是"排除法"，漏写一条就静默多打包一个文件 ——
// 上一版就是这样把排查用的 probe2.mjs 打进了 .vsix（而且 probe-*.mjs 这个
// 写法还漏掉了 probe2.mjs，两份名单同时失效，谁都没报错）。用户装上之后
// 扩展目录里躺着一个和功能无关的脚本，只有翻 zip 才会发现。
//
// 所以这里换成"白名单法"：扩展根目录下列出的每个文件都必须在 ALLOW 里，
// 否则直接以非 0 退出，并打印多余的文件名。
//
// 不依赖任何第三方包：直接读 zip 的中央目录（.vsix 就是个普通 zip）。

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'liudungeon-script.vsix';

/** 允许出现在扩展包里的路径（前缀匹配，`dir/` 表示整棵子树）。 */
const ALLOW = [
    'data/',
    'docs/',
    'out/',
    'snippets/',
    'icon.png',
    'language-configuration.json',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'LICENSE.txt',
];

/** vsix 自身的元数据，不在 extension/ 下。 */
const ALLOW_ROOT = ['extension.vsixmanifest', '[Content_Types].xml'];

/** 明确不该出现的东西：报错时顺便说明原因，省得下次又要重新想一遍。 */
const FORBIDDEN = [
    [/^test\//, '测试与自检脚本（harness）不进用户安装包'],
    [/^src\//, 'TypeScript 源码不进包（跑的是 out/ 里的 bundle）'],
    [/^scripts\//, '开发脚本不进包'],
    [/^node_modules\//, '依赖已被 esbuild 打进 bundle'],
    [/^probe/i, '排查用探针脚本不进包'],
    [/^\.vscode\//, '编辑器配置不进包'],
    [/\.ts$/, 'TypeScript 文件不进包'],
    [/\.map$/, 'sourcemap 不进包'],
];

/** 从 zip 尾部读中央目录，拿到全部条目名。 */
function zipEntries(path) {
    const buf = readFileSync(path);
    // 中央目录结束记录（EOCD）：签名 0x06054b50，注释最长 64KB
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）: ' + path);
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) {
            throw new Error('中央目录损坏，第 ' + i + ' 条记录签名不对');
        }
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

const entries = zipEntries(file);
const problems = [];
let packed = 0;

for (const raw of entries) {
    const name = raw.replace(/\/$/, '');
    if (name === '') continue;

    // 1. 先把明确禁止的挑出来（哪怕它在白名单子树里也说清楚原因）
    for (const [re, why] of FORBIDDEN) {
        if (re.test(name)) {
            problems.push(`不该打包: ${name} —— ${why}`);
            break;
        }
    }

    // 2. 再按白名单校验路径
    if (name === 'extension.vsixmanifest' || name === '[Content_Types].xml') {
        continue;
    }
    if (!name.startsWith('extension/')) {
        problems.push(`包内出现 extension/ 之外的文件: ${name}`);
        continue;
    }
    const rel = name.slice('extension/'.length);
    packed++;
    const ok = ALLOW.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
    if (!ok) {
        problems.push(`白名单外的文件: extension/${rel}`);
    }
}

// 3. 该有的东西必须在（packaging 漏了 bundle = 扩展装了打不开）
const must = ['extension/package.json', 'extension/out/client/extension.js',
    'extension/out/server/server.js', 'extension/data/action-methods.json',
    'extension/data/dungeon-methods.json', 'extension/data/config-files.json'];
for (const m of must) {
    if (!entries.includes(m)) problems.push(`缺少必需文件: ${m}`);
}

if (problems.length) {
    console.error('✗ .vsix 内容校验失败（' + problems.length + ' 项）:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\n修法：补 .vscodeignore，或把这个文件从仓库里删掉。');
    process.exit(1);
}

console.log('✓ .vsix 内容校验通过：' + packed + ' 个文件，全部在白名单内');
