// 生成 data/plugin-config.json：插件**主配置**（plugins/liudungeon/config.yml）的键名数据。
//
//   node scripts/gen-plugin-config.mjs           # 重新生成
//   node scripts/gen-plugin-config.mjs --check   # 只校验是否与插件源码一致（不一致则非 0 退出）
//
// 为什么单独一份数据：这个扩展原先只认识**副本目录**里的 config.yml（pack.yml 的
// enable / world / requirements…），而 plugins/liudungeon/config.yml 是同名的另一份文件
// —— 它讲的是 database / cross-server / statistics 这些**插件级**开关。
// 两者键名毫无交集，混用一层的后果是：打开主配置时顶层补全给出的是副本的键，
// 并且把 server-id / cross-server / statistics 全报成「插件不读的键」（实测 22 条误报）。
//
// 数据来源（两份都读，缺一不可）：
//   ① src/main/resources/config.yml  —— 键的层级、类型与**注释就是文档**
//   ② config/PluginConfig.java        —— 插件真正读的键（c.getInt("statistics.flush-interval", 10)）
// ① 保证"文档是真的"（键确实存在、注释是作者自己写的），② 保证"一个都没漏"。
// 只读 ① 会漏掉注释掉的键（cross-server.servers 整段是注释），
// 只读 ② 会得到一堆没有说明的键名。两边取交集/并集的做法见 main()。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseDocument, isMap, isSeq, isScalar } = require('yaml');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN_DIR = process.env.LD_PLUGIN_DIR ?? '/home/liu/plugins/liudungeon';
const CONFIG_YML = join(PLUGIN_DIR, 'src/main/resources/config.yml');
const PLUGIN_CONFIG_JAVA = join(PLUGIN_DIR, 'src/main/java/com/liu/liudungeon/config/PluginConfig.java');
const OUT = join(ROOT, 'data/plugin-config.json');
const checkOnly = process.argv.includes('--check');

for (const f of [CONFIG_YML, PLUGIN_CONFIG_JAVA]) {
    if (!existsSync(f)) {
        console.error('找不到插件源码: ' + f);
        console.error('设 LD_PLUGIN_DIR 指向插件仓库。');
        process.exit(2);
    }
}

/**
 * 键 → 取值枚举。插件用 valueOf(name.toUpperCase()) 解析，写别的值会**静默回落**到第一个
 * 默认值（不是报错），所以这三个键的取值必须能补全出来 —— 手写错一个字母就白配了。
 */
const ENUMS = {
    'database.type': ['YAML', 'SQLITE', 'MYSQL'],
    'dungeon.anti-escape.mode': ['BLOCK', 'TELEPORT_BACK', 'FAIL'],
    'script.on-error': ['LOG', 'FAIL_DUNGEON', 'DISABLE'],
};

/**
 * 注释里没有、或注释不足以说明的键：补一句人话。
 *
 * 只写"注释确实缺失/确实太薄"的那几个 —— 其余一律用作者自己在 config.yml 里写的注释，
 * 那是最权威的说明，转述只会引入偏差。
 */
const DOC_OVERRIDES = {
    debug: '调试模式：在控制台打印详细流程日志（排障时开，平时关）。',
    'database.sqlite.file': 'SQLite 数据库文件名，落在 plugins/liudungeon/ 下。',
    'database.type': '数据库类型：`YAML`（单文件、零配置，适合试玩）/ `SQLITE`（本地库，推荐）/ `MYSQL`（多服共享 —— 跨服统计、跨服排行榜要靠它）。写不认识的值会**静默回落成 SQLITE**。',
    'database.mysql': 'MySQL 连接参数（`database.type` 为 MYSQL 时生效）。',
    'database.mysql.host': 'MySQL 主机名或 IP。',
    'database.mysql.port': 'MySQL 端口，默认 3306。',
    'database.mysql.table-prefix': '表名前缀，多套服共用一个库时用它隔离（只保留字母数字与下划线）。',
    'database.mysql.pool-size': '连接池大小，至少 2。',
    'database.sqlite': 'SQLite 参数（`database.type` 为 SQLITE 时生效）。',
    'database.mysql.database': 'MySQL 库名（需要提前建好，插件只建表不建库）。',
    'database.mysql.username': 'MySQL 用户名。',
    'database.mysql.password': "MySQL 密码；没有密码留空字符串 ''。",
    'database.auto-migrate': '启动时自动建表 / 补列。关掉它就要自己维护表结构。',
    'world.preload-spawn-chunks': '实例世界建好后是否立刻预加载出生点周围区块（减少进本首帧卡顿）。',
    'world.preload-radius': '预加载半径（区块数），0 = 不预加载；上限 8。',
    'world.cleanup-orphans-on-start': '服务器重启 / 异常退出后，启动时自动清理残留的实例世界目录。',
    'edit.view-distance': '编辑世界的视距（区块），0 = 跟随服务端设置；只影响编辑会话。',
    dungeon: '副本通用设置：实例兜底超时、防逃逸、掉线重连、每日次数重置时刻、是否只有队长能开本。',
    performance: '性能保护：每个实例世界的实体上限与单次刷怪的拆分阈值。',
    leaderboard: '排行榜设置：开关、每页条数、数据保留天数、参与排名的名次数。',
    messages: '插件消息设置。',
    'dungeon.instance-timeout': '实例清理的兜底超时（秒）：玩家全掉线、实例卡死等异常情况下何时强制回收。正常完成的副本立即清理，不等这个时间。',
    'dungeon.anti-escape.enabled': '是否拦截逃出副本的手段（末影珍珠、紫颂果、传送门）。',
    'dungeon.reconnect.timeout': '掉线后保留副本位置等待重连的秒数，0 = 不启用（掉线即视为离开）。',
    'dungeon.daily-reset': "每日进入次数的重置时刻（HH:mm，按服务器时区）。上限在各副本 config.yml 的 requirements.daily_limit 里配。",
    'dungeon.leader-only-enter': '是否要求只有队长能发起进入。',
    party: '队伍：人数上限、邀请有效期与冷却、离线自动解散、队名规则与邀请正文。',
    'party.max-size': '一个队伍最多几个人。',
    'party.name': '队名规则。',
    'party.name.max-length': '队名最大长度。',
    'party.name.allow-color': '队名是否允许 & 颜色代码。',
    'cross-server.enabled': '总开关。`true` 只是「尝试连接」：Redis 连不上会自动退回**仅本服**模式（与没有这个功能时行为完全一致），并在启动横幅与 `/ld status` 里标明，不会有任何副作用。`false` = 连都不连。',
    'cross-server.redis': 'Redis 连接参数。同一代理下的各服要指向**同一个** Redis，并保持 `channel` 一致，否则互相看不见。',
    'cross-server.redis.host': 'Redis 主机名或 IP。',
    'cross-server.redis.port': 'Redis 端口，默认 6379。',
    'cross-server.redis.pool-size': 'Redis 连接池大小。',
    'script': '脚本引擎（GraalJS）设置。',
    'script.enabled': '是否启用脚本引擎。关掉后 scripts.yml 与怪物组脚本一律不执行 —— 副本还能开，只是没有任何流程逻辑。',
    'leaderboard.enabled': '是否启用排行榜（`/ld leaderboard` 与 GUI 里的排行榜页）。关掉后统计照常记录，只是不看排行。',
    'statistics': '统计与数据记录设置。数据落在数据库的 combat_event / instance_session / reward_ledger / economy_daily 四张表里。',
    'statistics.enabled': '是否记录与展示统计。关掉后这几张表不再写入，`/ld stats` 与排行榜会是空的。',
    'stamina.enabled': '是否启用体力系统 —— 当前版本**未实现**，配了也不生效（副本 config.yml 的 requirements.stamina_cost 同样）。',
    'self-test.enabled': '是否在启动后自动跑一次核心链路自检（模板克隆 → 世界加载 → 脚本执行 → 刷怪 → 击杀推进 → 世界销毁），结果直接打印到控制台。生产环境保持关闭。',
    'messages.prefix': '插件消息前缀（支持 & 颜色代码），用在 broadcast 与各类提示前。',
    'party.invite-timeout': '邀请有效期（秒），过期后点击接受按钮无效。',
    'party.offline-disband-minutes': '全员离线这么多分钟后自动解散队伍（防止弃游队伍连同仓库永久驻留内存）。0 = 不启用。',
    'party.invite-buttons.accept': '邀请消息末尾「接受」按钮的文字（可点击，不用手打指令）。',
    'party.invite-buttons.reject': '邀请消息末尾「拒绝」按钮的文字。',
    'server-name': '跨服组队用的本服标识的**回退值**：只有 server-id 留空时才读它（Paper 的服务器名）。正常情况下请直接配 server-id，别写这个 —— 它每台服都不同，写成同一个值会让跨服邀请定位错服务器。',
    'cross-server.servers': '各服的**直连地址**，通常不需要写（留空即可）：跨服传送默认走代理插件消息通道，地址由代理自己管。仅当服务器之间直连、或想绕开代理时才配。',
    'cross-server.servers.<服名>': '一台目标服，键名就是它在代理里的登记名（与那台服的 server-id 一致）。',
    'cross-server.servers.<服名>.host': '那台服的主机名或 IP。',
    'cross-server.servers.<服名>.port': '那台服的**游戏端口**（不是代理端口 —— 填代理端口会变成"连回代理再路由回来"）。',
    'script.execution-timeout-ms': '单次脚本执行的最长时间（毫秒），用于折算语句上限以中断死循环。',
    'script.max-actions-per-second': '单个副本实例内每秒允许执行的动作数上限，超出则丢弃并告警。',
    'performance.entity-limit': '每个副本世界的实体总数上限，超过上限的怪物生成请求会被跳过。注意它统计的是**世界内全部实体**（含地图自带的画 / 盔甲架 / 生物），用现成地图时要按实际实体数上调。',
    'performance.spawn-split-threshold': '单次生成超过该数量时自动拆分到多个 tick（避免一 tick 刷几百只怪）。',
    'leaderboard.entries-per-page': '排行榜每页显示几条。',
    'statistics.display-duration': '副本结束后统计面板在屏幕上停留的秒数。',
    'stamina.max-stamina': '体力上限。',
    'stamina.recovery-rate': '每次恢复多少点体力。',
    'stamina.recovery-interval': '每多少秒恢复一次体力。',
    'self-test.delay-seconds': '服务器启动后延迟多少秒执行自检（等世界与插件完全就绪）。',
};

/**
 * plugins/liudungeon/config.yml 里被注释掉、但插件仍会读的键。
 *
 * 这些键的层级与类型只能手写（yaml 解析不出注释里的结构）；
 * 「有没有漏」由 PluginConfig.java 的键清单反过来兜底（见 collectJavaKeys）。
 */
const EXTRA_NODES = [
    { path: 'server-name', key: 'server-name', type: '文本' },
    { path: 'cross-server.servers', key: 'servers', type: '映射' },
    { path: 'cross-server.servers.<服名>', key: '<服名>', type: '映射' },
    { path: 'cross-server.servers.<服名>.host', key: 'host', type: '文本' },
    { path: 'cross-server.servers.<服名>.port', key: 'port', type: '数字' },
];

/**
 * yaml 注释块 → 文档。
 *
 * <p>分隔线（`# ----` / `# ====`）把注释切成若干段：段首往往是"章节标题"，最后一段才是
 * 这个键自己的说明。所以**叶子键取最后一段**；映射型键（`database:`、`cross-server:`）
 * 把各段合并 —— 它的注释里既有章节说明也有子键概览，砍掉哪一半都丢信息。
 */
function cleanComment(raw, joinAll = false) {
    if (!raw) return '';
    const isSep = (l) => /^\s*[-=]{3,}\s*$/.test(l);
    const paras = [];
    let cur = [];
    for (const line of raw.split('\n')) {
        if (isSep(line)) {
            if (cur.length) paras.push(cur);
            cur = [];
            continue;
        }
        const text = line.startsWith(' ') ? line.slice(1) : line;
        if (text.trim() === '') {
            if (cur.length) paras.push(cur);
            cur = [];
            continue;
        }
        cur.push(text.replace(/\s+$/, ''));
    }
    if (cur.length) paras.push(cur);
    const use = joinAll ? paras : paras.slice(-1);
    return use.map((p) => p.join('\n').trim()).filter(Boolean).join('\n\n').trim();
}

function scalarText(node) {
    if (isScalar(node)) return String(node.value);
    return null;
}

/** 叶子值 → 数据里用的类型名（与 config-files.json 的 type 取值同一套）。 */
function typeOfValue(node) {
    if (isMap(node)) return '映射';
    if (isSeq(node)) return '列表';
    if (isScalar(node)) {
        if (typeof node.value === 'boolean') return '布尔';
        if (typeof node.value === 'number') return '数字';
    }
    return '文本';
}

/** 遍历 yaml 映射，产出 path / key / type / doc 四件套。 */
function walk(map, prefix, pendingDoc, out) {
    let inherited = pendingDoc;
    for (const item of map.items) {
        const key = scalarText(item.key);
        if (key == null) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        const isMapValue = isMap(item.value);

        // 注释挂在 key 上的情况最常见；映射型值的第一行子键，
        // 它的注释在 yaml 里是挂在**父值**上的（见 world.concurrent-limit）。
        let doc = cleanComment(item.key.commentBefore, isMapValue) || inherited || '';
        inherited = null;
        const inline = cleanComment(item.value?.comment);
        if (inline) doc = doc ? `${doc}\n\n${inline}` : inline;

        const node = { path, key, type: typeOfValue(item.value) };
        const override = DOC_OVERRIDES[path];
        node.doc = override ?? doc;
        if (ENUMS[path]) node.values = ENUMS[path];
        node.aliases = [];
        node.required = false;
        out.push(node);

        if (isMap(item.value)) {
            walk(item.value, path, cleanComment(item.value.commentBefore), out);
        }
    }
}

/** PluginConfig.java 真正读的键（c.getXxx("a.b.c", 默认值)）。 */
function collectJavaKeys(java) {
    const keys = new Set();
    for (const m of java.matchAll(/\.get(?:String|Int|Long|Double|Boolean|StringList|List|ConfigurationSection)\("([^"]+)"/g)) {
        keys.add(m[1]);
    }
    return keys;
}

function build() {
    const text = readFileSync(CONFIG_YML, 'utf8');
    const doc = parseDocument(text);
    if (!isMap(doc.contents)) {
        console.error('config.yml 的根不是映射，生成器退出');
        process.exit(2);
    }

    const nodes = [];
    walk(doc.contents, '', '', nodes);
    for (const n of EXTRA_NODES) {
        nodes.push({ ...n, doc: DOC_OVERRIDES[n.path] ?? '', aliases: [], required: false });
    }
    // 顺序按 yaml 出现顺序（后面追加的直连地址段排最后），补全列表跟着文档走最好找

    // ---- 覆盖率核对：插件读的每一个键都要有说明 ----
    const javaKeys = collectJavaKeys(readFileSync(PLUGIN_CONFIG_JAVA, 'utf8'));
    const have = new Set(nodes.map((n) => n.path));
    const missing = [...javaKeys].filter((k) => {
        if (have.has(k)) return false;
        // 段式读法：getConfigurationSection("cross-server.servers") + section.getXxx(id + ".host")
        if ([...have].some((p) => p.startsWith(`${k}.<`))) return false;
        return true;
    });
    if (missing.length) {
        console.error('✗ PluginConfig.java 读了、数据里没有的键：');
        for (const k of missing) console.error('  - ' + k);
        console.error('\n在 scripts/gen-plugin-config.mjs 的 EXTRA_NODES / DOC_OVERRIDES 里补上。');
        process.exit(2);
    }

    const noDoc = nodes.filter((n) => !n.doc || !n.doc.trim());
    if (noDoc.length) {
        console.error('✗ 这些键没有任何说明（补全与悬停会是空的）：');
        for (const n of noDoc) console.error('  - ' + n.path);
        process.exit(2);
    }

    return {
        file: 'plugin-config.yml',
        title: '插件主配置',
        summary: 'plugins/liudungeon/config.yml —— 插件级开关：调试、本服标识、数据库、跨服组队、脚本引擎、统计与排行榜等',
        example:
            "debug: false\nserver-id: 'server-1'\ndatabase:\n  type: SQLITE\ncross-server:\n  enabled: true\n  start-delay: 3\nstatistics:\n  enabled: true\n",
        nodes,
    };
}

const data = build();
const json = JSON.stringify(data, null, 2) + '\n';

if (checkOnly) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
    if (cur === json) {
        console.log(`✓ 主配置数据与插件源码一致（${data.nodes.length} 个键）`);
        process.exit(0);
    }
    console.error('✗ data/plugin-config.json 与插件源码不一致（插件改过 config.yml 或 PluginConfig.java 了）');
    console.error('跑 `node scripts/gen-plugin-config.mjs` 重新生成。');
    process.exit(1);
}

writeFileSync(OUT, json);
console.log(`已写入 data/plugin-config.json：${data.nodes.length} 个键（其中 ${Object.keys(ENUMS).length} 个带取值枚举）`);
