/**
 * 自检脚本：把编译好的语言服务当作真正的 LSP 服务启动（stdio），
 * 用真实协议报文验证补全 / 悬停 / 跳转 / 诊断。
 *
 *   node test/lsp-harness.mjs            # 全部用例
 *   node test/lsp-harness.mjs -v         # 打印每个用例的命中详情
 *
 * 为什么不用 vscode 测试宿主：语言服务的逻辑全部在服务端，
 * 这里只需要一个会说 LSP 的客户端就能覆盖，跑得也快（< 2 秒）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERBOSE = process.argv.includes('-v');
const SERVER = 'out/server/server.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
    if (VERBOSE) console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}\n      ${detail ?? ''}`);
  }
}

// ==================================================================
//  最小的 LSP 客户端
// ==================================================================

class LspClient {
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.slice(start, start + length).toString('utf8');
      this.buffer = this.buffer.slice(start + length);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      } else if (msg.id !== undefined && msg.method) {
        // 服务端请求（如 workspace/configuration）：回一个空对象
        this.send({ jsonrpc: '2.0', id: msg.id, result: null });
      } else {
        this.notifications.push(msg);
      }
    }
  }

  send(msg) {
    const text = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve) => this.pending.set(id, resolve));
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** 取某个文档最近一次诊断。 */
  diagnosticsFor(uri) {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      const n = this.notifications[i];
      if (n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri) {
        return n.params.diagnostics;
      }
    }
    return [];
  }

  /** 等某个条件成立（轮询通知）。 */
  async waitFor(fn, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    return undefined;
  }
}

// ==================================================================
//  工作区数据：用插件仓库里的真实示例配置
// ==================================================================

const PLUGIN_DIR = process.env.LD_PLUGIN_DIR ?? '/home/liu/plugins/liudungeon';
const DUNGEON_ROOT = join(PLUGIN_DIR, 'src/main/resources/example');

/**
 * 自造一个「**有真定义**的副本目录」。
 *
 * 为什么不能省：插件自带的 example/ 里 zones.yml / stages.yml / interacts.yml
 * 全是注释示例（一个区域、一个阶段都没定义），所以「名字补全」与「跨文件引用校验」
 * 在那份工作区上永远是空的 —— 早先正是这样，索引里区域/点位/交互/阶段四类一个
 * 都没收进来（containerAliases 的键写成了容器名而不是引用类型），却没有任何用例
 * 发现。这里落到 tmp 下的 dungeons/<名>/（路径含 /dungeons/ 才会启用诊断），
 * 并把 config.yml 一并写上 —— 索引只认「目录里有 config.yml」的目录。
 */
const REF_DIR = join(mkdtempSync(join(tmpdir(), 'ld-ref-')), 'dungeons', 'refdungeon');

const REF_FILES = {
  'config.yml': "dungeon:\n  name: '&e校验用副本'\nworld:\n  template: voidgen\n  spawn: '0,65,0,0,0'\n",
  'zones.yml': "区域:\n  战斗区:\n    范围: '0,60,0 ~ 20,80,20'\n    点位:\n      中心: '10,64,10'\n      落点: '10,64,10,90,0'\n",
  'obstacles.yml': "障碍物:\n  Boss门:\n    区域: 战斗区\n    材质: IRON_BARS\n    默认状态: 开启\n",
  'monsters.yml': "怪物组:\n  wave_1:\n    刷新时机:\n      type: AUTO_START\n    区域: 战斗区\n    monsters:\n      - id: Zombie\n        point: 中心\n",
  'interacts.yml': "交互:\n  能量核心:\n    类型: RIGHT_CLICK_BLOCK\n    坐标: '0,64,0'\n",
  'stages.yml': '阶段:\n  第一阶段:\n    目标: kill_all\n',
  'rewards.yml': '奖励:\n  通关奖励:\n    经验: 10\n',
  'tasks.yml': 'tasks:\n  倒计时:\n    type: 定时\n    times:\n      300: |-\n        action.message(\'@all\', \'&e还剩 5 分钟\');\n',
  'scripts.yml': "start: |-\n  action.message('@all', '&e开始');\n",
};

/** 区域直接写在根节点的写法（插件允许，见 zones.yml 示例顶部注释）。 */
const REF_FLAT_DIR = join(mkdtempSync(join(tmpdir(), 'ld-flat-')), 'dungeons', 'flatdungeon');

const REF_FLAT_FILES = {
  'config.yml': "dungeon:\n  name: '&e根节点写法'\nworld:\n  template: voidgen\n",
  'zones.yml': "前厅:\n  名称: '&e前厅'\n  范围: '0,60,0 ~ 10,70,10'\n  点位:\n    落点: '5,64,5'\n",
  'monsters.yml': '怪物组:\n  wave_1:\n    刷新时机:\n      type: AUTO_START\n    monsters:\n      - id: Zombie\n        location: \'0,64,0\'\n',
};

/**
 * 外层键全用「另一种写法」的副本：`obstacles:` / `怪物组:` / `zones:`。
 *
 * 插件对每个容器都有多种写法，全都是同一个容器；编辑器若按字面量比路径，
 * 用别名写的文件**整棵子树**都会匹配不上 —— 实测 obstacles.yml 写成 `obstacles:` 时，
 * 障碍物里 7 个键一个都补不出来，悬停也没有。
 */
const REF_ALIAS_DIR = join(mkdtempSync(join(tmpdir(), 'ld-alias-')), 'dungeons', 'aliasdungeon');

const REF_ALIAS_FILES = {
  'config.yml': "dungeon:\n  name: '&e别名写法副本'\nworld:\n  template: voidgen\n",
  'zones.yml': "zones:\n  安全区:\n    名称: '&e安全区'\n    范围: '-2,62,8 ~ 3,64,10'\n",
  'obstacles.yml': "obstacles:\n  出生点屏障:\n    区域: 安全区\n    材质: barrier\n    开启时候: |-\n      action.sound('@all', 'BLOCK_IRON_DOOR_CLOSE')\n",
  'monsters.yml': "怪物组:\n  wave_1:\n    spawn_timing:\n      type: AUTO_START\n    monsters:\n      - id: Zombie\n        location: '0,64,0'\n",
  'rewards.yml': '奖励:\n  通关奖励:\n    经验: 10\n',
};

/**
 * 插件**主配置**的夹具：`plugins/liudungeon/config.yml`。
 *
 * 它与副本目录里的 `config.yml` 同名，但讲的是 database / cross-server / statistics
 * 这些**插件级**开关。这两份文件一度被当成同一份：打开主配置时顶层补全给出的是
 * 副本的键（enable / requirements…），而且把 server-id、cross-server、statistics
 * 全报成「插件不读的键」—— 实测 22 条假警告。所以夹具直接用**插件仓库里那份真文件**，
 * 逐字验证它一条诊断都不许有。
 */
const MAIN_CFG_DIR = join(mkdtempSync(join(tmpdir(), 'ld-maincfg-')), 'plugins', 'liudungeon');

/** 插件**源码**里的同一个文件：`src/main/resources/config.yml`（仓库里就是主配置）。 */
const MAIN_SRC_DIR = join(
  mkdtempSync(join(tmpdir(), 'ld-maincfg-src-')), 'liudungeon', 'src', 'main', 'resources',
);

// 主配置夹具直接用**插件仓库里那份真文件**：与插件源码对账是这个自检的前提，
// 读不到就明确说清楚（跟 sync-docs.mjs 一样），而不是让后面几十条断言在空内容上"通过"。
let MAIN_CFG_TEXT;
try {
  MAIN_CFG_TEXT = readFileSync(join(PLUGIN_DIR, 'src/main/resources/config.yml'), 'utf8');
} catch {
  console.error('找不到插件主配置: ' + join(PLUGIN_DIR, 'src/main/resources/config.yml'));
  console.error('设 LD_PLUGIN_DIR 指向插件仓库（含 src/main/resources/config.yml）。');
  process.exit(2);
}

/**
 * 服务器上的插件数据目录：`plugins/liudungeon/`。
 *
 * <p>刻意**不放 plugin.yml**（真实的服务端目录里没有它，plugin.yml 在 jar 里）——
 * 这一份考的是「路径形状 + 目录内容」那条判定：目录名叫 liudungeon、不在 dungeons/ 下、
 * 里面也没有任何副本内容文件。放上 plugin.yml 就会变成在考另一条判定，
 * 「内容判定失效」这个变异会静默溜过去（变异测试第一次跑就是这样全绿的）。
 */
const MAIN_CFG_FILES = {
  'config.yml': MAIN_CFG_TEXT,
  'gui.yml': "settings:\n  filler-material: GRAY_STAINED_GLASS_PANE\n",
};

/**
 * 源码资源目录那份：目录名是 `resources`，路径形状与"插件根"完全不像，
 * 唯一的线索就是**同目录有 plugin.yml**。少了这条线索，打开插件仓库时
 * src/main/resources/config.yml 会被当成某个副本的配置。
 */
const MAIN_SRC_FILES = {
  'config.yml': MAIN_CFG_TEXT,
  'plugin.yml': "name: liudungeon\nmain: com.liu.liudungeon.LiuDungeonPlugin\n",
  'gui.yml': "settings:\n  filler-material: GRAY_STAINED_GLASS_PANE\n",
};

function writeRefFixture() {
  try {
    mkdirSync(REF_DIR, { recursive: true });
    for (const [name, text] of Object.entries(REF_FILES)) {
      writeFileSync(join(REF_DIR, name), text, 'utf8');
    }
    // 第二种写法：区域/交互直接写在根节点（没有 `区域:` 外层）。
    // 插件允许这样写，索引里的「根节点兜底」分支必须真的生效 ——
    // 那条分支一度拿绝对路径去比 'zones.yml'，永远不成立。
    mkdirSync(REF_FLAT_DIR, { recursive: true });
    for (const [name, text] of Object.entries(REF_FLAT_FILES)) {
      writeFileSync(join(REF_FLAT_DIR, name), text, 'utf8');
    }
    // 第三种写法：外层键用别名/英文（`obstacles:` / `怪物组:` / `zones:`）
    mkdirSync(REF_ALIAS_DIR, { recursive: true });
    for (const [name, text] of Object.entries(REF_ALIAS_FILES)) {
      writeFileSync(join(REF_ALIAS_DIR, name), text, 'utf8');
    }
    // 第四种：插件主配置（plugins/liudungeon/，另一个同名 config.yml）
    mkdirSync(MAIN_CFG_DIR, { recursive: true });
    for (const [name, text] of Object.entries(MAIN_CFG_FILES)) {
      writeFileSync(join(MAIN_CFG_DIR, name), text, 'utf8');
    }
    // 第五种：插件源码资源目录（src/main/resources/，靠 plugin.yml 认出来）
    mkdirSync(MAIN_SRC_DIR, { recursive: true });
    for (const [name, text] of Object.entries(MAIN_SRC_FILES)) {
      writeFileSync(join(MAIN_SRC_DIR, name), text, 'utf8');
    }
  } catch {
    /* 写不出来时相关用例会失败并给出空白结果，比静默跳过更容易发现 */
  }
}

/** 造一份「副本目录」快照：example/ 下的所有文件都算 trial 副本。 */
function buildWorkspace() {
  const files = [];
  let names = [];
  try {
    names = readdirSync(DUNGEON_ROOT);
  } catch {
    return files;
  }
  for (const n of names) {
    if (!/\.(ya?ml|js|md)$/.test(n)) continue;
    const text = readFileSync(join(DUNGEON_ROOT, n), 'utf8');
    files.push({ uri: `file://${DUNGEON_ROOT}/${n}`, text });
  }
  writeRefFixture();
  for (const [name, text] of Object.entries(REF_FILES)) {
    files.push({ uri: `file://${REF_DIR}/${name}`, text });
  }
  for (const [name, text] of Object.entries(REF_FLAT_FILES)) {
    files.push({ uri: `file://${REF_FLAT_DIR}/${name}`, text });
  }
  for (const [name, text] of Object.entries(REF_ALIAS_FILES)) {
    files.push({ uri: `file://${REF_ALIAS_DIR}/${name}`, text });
  }
  for (const [name, text] of Object.entries(MAIN_CFG_FILES)) {
    files.push({ uri: `file://${MAIN_CFG_DIR}/${name}`, text });
  }
  for (const [name, text] of Object.entries(MAIN_SRC_FILES)) {
    files.push({ uri: `file://${MAIN_SRC_DIR}/${name}`, text });
  }
  return files;
}

// ==================================================================
//  main
// ==================================================================

const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const client = new LspClient(child);

await client.request('initialize', {
  processId: process.pid,
  rootUri: `file://${DUNGEON_ROOT}`,
  capabilities: {
    textDocument: {
      completion: { completionItem: { snippetSupport: true } },
      hover: {},
      definition: {},
      publishDiagnostics: {},
      documentSymbol: {},
    },
    workspace: { configuration: true, workspaceFolders: true },
  },
  workspaceFolders: [{ uri: `file://${DUNGEON_ROOT}`, name: 'example' }],
});
client.notify('initialized', {});

const ws = buildWorkspace();
client.notify('liudungeon/loadWorkspace', { files: ws });

/** 打开过的虚拟文档（用例 17 会统一关掉，避免互相污染）。 */
const openUris = [];

/**
 * 打开一个虚拟文档（内容可覆盖），返回 uri。
 *
 * `dir` 默认用插件示例目录；传 REF_DIR 就能在「有真定义」的那份副本上测名字补全
 * 与引用校验（见 REF_FILES 的说明）。
 */
function openDoc(name, text, dir = DUNGEON_ROOT) {
  const uri = `file://${dir}/${name}`;
  if (!openUris.includes(uri)) openUris.push(uri);
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: name.endsWith('.js') ? 'javascript' : 'yaml', version: 1, text },
  });
  return uri;
}

/**
 * 在文本里定位某个 token 的光标位置（返回落在词中间的那个字符位）。
 *
 * 手算列号很容易错（`    trigger_group: wave_1` 里 wave_1 从 19 开始，
 * 而不是 20）—— 算错的后果是 symbolAt 取不到符号，测试会误报"功能没实现"。
 */
function posOf(text, token, occurrence = 1) {
  const lines = text.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const idx = lines[i].indexOf(token, from);
      if (idx < 0) break;
      seen++;
      if (seen === occurrence) return { line: i, character: idx + Math.floor(token.length / 2) };
      from = idx + token.length;
    }
  }
  throw new Error(`找不到 token: ${token}`);
}

/** 关掉一个文档：关掉后索引回到磁盘版本，避免用例之间互相污染。 */
function closeDoc(uri) {
  client.notify('textDocument/didClose', { textDocument: { uri } });
}

async function completions(uri, line, character) {
  const res = await client.request('textDocument/completion', {
    textDocument: { uri },
    position: { line, character },
  });
  if (process.env.LD_TRACE_COMPLETION) {
    console.log(`[trace] completion ${uri.split('/').pop()} L${line}:${character} →`,
      JSON.stringify(res).slice(0, 300));
  }
  if (!res.result) return [];
  return Array.isArray(res.result) ? res.result : (res.result.items ?? []);
}

async function request(method, params) {
  const res = await client.request(method, params);
  return res.result;
}

async function hover(uri, line, character) {
  const res = await client.request('textDocument/hover', {
    textDocument: { uri },
    position: { line, character },
  });
  return res.result;
}

function lineOf(text, token) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(token);
    if (idx >= 0) return { line: i, character: idx + token.length };
  }
  return null;
}

function labels(items) {
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label?.label));
}

/** 失败信息里用的完整标签串（不截断，方便看清到底返回了什么）。 */
function labelDump(items) {
  return JSON.stringify(labels(items));
}

// ---------- 用例 1：YAML 顶层键补全（monsters.yml） ----------
{
  const text = 'groups:\n  wave_1:\n    sp\n';
  const uri = openDoc('monsters.yml', text);
  const items = await completions(uri, 2, 6);
  const got = labels(items);
  check('monsters.yml 组内键补全含 spawn_timing', got.includes('spawn_timing'), `实际：${got.join(',')}`);
  check('monsters.yml 组内键补全不含无关键（如 dungeon.name）', !got.includes('dungeon.name'), got.join(','));
  const spawn = items.find((i) => i.label === 'spawn_timing');
  check('spawn_timing 补全带文档', Boolean(spawn?.documentation), JSON.stringify(spawn ?? {}).slice(0, 120));
  closeDoc(uri);
}

// ---------- 用例 2：值位置给枚举 ----------
{
  const text = 'groups:\n  wave_1:\n    spawn_timing:\n      type: \n';
  const uri = openDoc('monsters.yml', text);
  const got = labels(await completions(uri, 3, 12));
  check('spawn_timing.type 值补全含 AUTO_START', got.includes('AUTO_START'), got.join(','));
  check('spawn_timing.type 值补全含 TRIGGERED', got.includes('TRIGGERED'), got.join(','));
  check('枚举补全给的是解析器真正接受的别名（含 自动 / AUTO-START）',
    got.includes('自动') && got.includes('AUTO-START'), got.join(','));
  closeDoc(uri);
}

// ---------- 用例 3：YAML 里嵌的 JS（scripts.yml 的钩子字符串） ----------
{
  const text = 'start:\n  - "action.me"\n';
  const uri = openDoc('scripts.yml', text);
  const got = labels(await completions(uri, 1, text.split('\n')[1].length));
  check('YAML 字符串里 action. 前缀给方法补全（含 message）', got.includes('message'), got.join(','));
  check('action.me 前缀只给 me 开头的方法', got.length >= 1 && got.every((l) => l.startsWith('me')), got.join(','));

  // 不输入前缀时应给出全部方法
  const all = labels(await completions(uri, 1, text.split('\n')[1].indexOf('.') + 1));
  check('YAML 字符串里 action. 后给全部方法（>=60）', all.length >= 60, `共 ${all.length}`);
}

// ---------- 用例 3b：块标量里的脚本（on_end: |- 这种最常见写法）----------
{
  const text = 'groups:\n  boss:\n    on_end: |-\n      action.complete_dungeon()\n      ac\n';
  const uri = openDoc('monsters.yml', text);
  const got = labels(await completions(uri, 4, 8));
  check('块标量正文里输入 ac 有补全', got.length > 0, `共 ${got.length}`);
  check('块标量里 ac 补到 action 对象', got.includes('action'), got.join(','));
  check('ac 前缀不返回无关项', got.every((l) => l.startsWith('ac')), got.join(','));

  const done = labels(await completions(uri, 3, '      action.'.length));
  check('块标量里 action. 后给全部方法', done.length >= 60, `共 ${done.length}`);
  check('块标量里 action. 补全含 complete_dungeon', done.includes('complete_dungeon'), done.join(','));

  // 悬停也要认得块标量里的方法名
  const h = await hover(uri, 3, '      action.complete'.length);
  const hv = h?.contents?.value ?? '';
  check('块标量里 action.complete_dungeon 悬停有方法文档', /complete_dungeon|通关/.test(hv), hv.slice(0, 120));

  closeDoc(uri);
}

// ---------- 用例 3c：块标量里 action.message 的选择器 ----------
{
  const text = 'groups:\n  boss:\n    on_end: |\n      action.message(\'@a\')\n';
  const uri = openDoc('monsters.yml', text);
  const got = labels(await completions(uri, 3, '      action.message(\'@'.length));
  check('块标量里选择器补全含 @all', got.includes('@all'), got.join(','));
  closeDoc(uri);
}

// ---------- 用例 4：选择器补全 ----------
{
  const text = 'start:\n  - "action.message(\'@a"\n';
  const uri = openDoc('scripts.yml', text);
  const got = labels(await completions(uri, 1, text.split('\n')[1].length - 1));
  check('选择器补全含 @all', got.includes('@all'), got.join(','));
  check('选择器补全不含未实现的 @party', !got.includes('@party'), got.join(','));
}

// ---------- 用例 5：怪物组名补全（来自同目录 monsters.yml 索引） ----------
{
  const text = 'start:\n  - "action.spawn_group(\'\')"\n';
  const uri = openDoc('scripts.yml', text);
  // 光标位于两个单引号之间（不是 @ 开头，因此不会走选择器分支）
  const character = text.split('\n')[1].indexOf("'") + 1;
  const got = labels(await completions(uri, 1, character));
  check('spawn_group 参数补全列出 monsters.yml 里的 wave_1', got.includes('wave_1'), got.join(','));
  check('spawn_group 参数补全列出 boss', got.includes('boss'), got.join(','));
}

// ---------- 用例 6：functions.js 里的补全 ----------
{
  const text = 'function hi() {\n    action.\n}\n';
  const uri = openDoc('functions.js', text);
  const got = labels(await completions(uri, 1, 11));
  check('functions.js 里 action. 补全含 grant_reward', got.includes('grant_reward'), got.join(','));
  check('functions.js 里 action. 补全含 dungeon 相关方法不存在', !got.includes('getTemplateId'), got.join(','));
}

// ---------- 用例 7：functions.js 里 dungeon. 补全 ----------
{
  const text = 'function hi() {\n    dungeon.get\n}\n';
  const uri = openDoc('functions.js', text);
  const got = labels(await completions(uri, 1, 15));
  check('dungeon.get 前缀补全含 getTotalAliveMonsters', got.includes('getTotalAliveMonsters'), got.join(','));
  check('dungeon.get 前缀补全都是 get 开头', got.every((l) => l.startsWith('get')), got.join(','));
}

// ---------- 用例 8：内置函数补全 ----------
{
  const text = 'function hi() {\n    getV\n}\n';
  const uri = openDoc('functions.js', text);
  const got = labels(await completions(uri, 1, 8));
  check('内置函数补全含 getVar', got.includes('getVar'), got.join(','));
}

// ---------- 用例 9：悬停文档 ----------
{
  const text = 'start:\n  - "action.complete_dungeon()"\n';
  const uri = openDoc('scripts.yml', text);
  const h = await hover(uri, 1, text.split('\n')[1].indexOf('complete_dungeon') + 4);
  const value = h?.contents?.value ?? '';
  check('action.complete_dungeon 悬停有签名', value.includes('complete_dungeon'), value.slice(0, 80));
  check('悬停里有中文说明', /副本|通关|结算/.test(value), value.slice(0, 120));
}

// ---------- 用例 9b：块标量里的诊断 ----------
{
  const text = 'groups:\n  boss:\n    on_end: |-\n      action.messagee(\'@all\', \'x\')\n      dungeon.getNope()\n';
  const uri = openDoc('monsters.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => /messagee/.test(x.message)) ? d : undefined;
  });
  check('块标量里的未知方法 action.messagee 被标记', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 200));
  check('块标量里的未知方法 dungeon.getNope 也被标记',
    Boolean(diags?.some((x) => /getNope/.test(x.message))), JSON.stringify(diags ?? []).slice(0, 300));
  closeDoc(uri);
}

// ---------- 用例 10：诊断 - 未知方法 ----------
{
  const text = 'start:\n  - "action.messagee(\'@all\', \'x\')"\n';
  const uri = openDoc('scripts.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.length ? d : undefined;
  });
  check('未知方法 action.messagee 被标记', Boolean(diags?.some((d) => /messagee/.test(d.message))), JSON.stringify(diags ?? []).slice(0, 300));
}

// ---------- 用例 11：诊断 - 未知选择器 ----------
{
  const text = 'start:\n  - "action.message(\'@party\', \'x\')"\n';
  const uri = openDoc('scripts.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => /party/.test(x.message)) ? d : undefined;
  });
  check('未实现的 @party 被标记', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 300));
}

// ---------- 用例 12：诊断 - 写错的占位符 ----------
{
  const text = 'start:\n  - "action.message(\'@all\', \'{player_name} 你好\')"\n';
  const uri = openDoc('scripts.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => /占位符/.test(x.message)) ? d : undefined;
  });
  check('{player_name} 这类占位符被提示', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 300));
}

// ---------- 用例 13：诊断 - 时间写法 ----------
{
  const text = 'start:\n  - "action.wait(\'3秒钟\')"\n';
  const uri = openDoc('scripts.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => /时间写法/.test(x.message)) ? d : undefined;
  });
  check('3秒钟 这种时间写法被提示', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 300));
}

// ---------- 用例 14：诊断 - 不存在的钩子 ----------
{
  const text = 'startt:\n  - "action.message(\'@all\', \'x\')"\n';
  const uri = openDoc('scripts.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => /钩子/.test(x.message)) ? d : undefined;
  });
  check('拼错的钩子名 startt 被提示', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 300));
}

// ---------- 用例 15：诊断 - 不存在的怪物组 ----------
{
  const text = 'groups:\n  wave_2:\n    spawn_timing:\n      type: TRIGGERED\n    trigger_group: wave_9\n    monsters:\n      - id: Zombie\n        location: \'0,64,0\'\n';
  const uri = openDoc('monsters.yml', text);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => /wave_9/.test(x.message)) ? d : undefined;
  });
  check('trigger_group 指向不存在的组被提示', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 300));
  closeDoc(uri);
}

// ---------- 用例 16：诊断 - dungeon.spawn ----------
{
  const text = 'dungeon:\n  name: x\n  spawn: 0,64,0\n';
  const uri = openDoc('config.yml', text);
  await new Promise((r) => setTimeout(r, 250)); // 让上一个用例的 validate 先跑完，避免竞态
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'spawn-key') ? d : undefined;
  });
  const msg = diags?.find((x) => x.code === 'spawn-key')?.message ?? '';
  check('dungeon 段里的 spawn 被标为不会生效', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 300));
  check('提示里点明要改成 world.spawn', /world\.spawn/.test(msg), msg);
}

// ---------- 用例 17：诊断 - 参数个数按重载集合校验（少写也报） ----------
{
  // title 现在有 1/2/3 参三个版本：两参是合法重载，不能报
  const okText = "start: |-\n  action.title('@all', '标题')\n";
  const okUri = openDoc('scripts.yml', okText);
  await new Promise((r) => setTimeout(r, 250));
  const okArity = client.diagnosticsFor(okUri).filter((x) => x.code === 'arity');
  check('title 两参（合法重载）不报 arity', okArity.length === 0, JSON.stringify(okArity).slice(0, 200));
  closeDoc(okUri);

  const badText = "start: |-\n  action.message()\n  action.spawn_group('wave_1', 2)\n";
  const badUri = openDoc('scripts.yml', badText);
  const badDiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(badUri).filter((x) => x.code === 'arity');
    return d.length >= 1 ? d : undefined;
  });
  const msgs = (badDiags ?? []).map((x) => x.message).join(' | ');
  check('message 零参被报（没有 0 参版本）', /message 没有 0 个参数的版本/.test(msgs), msgs);
  check('spawn_group 两参（带倍率重载）不误报', !/spawn_group 没有/.test(msgs), msgs);
  closeDoc(badUri);
}

// ---------- 用例 16b：区域脚本占位符不算错 ----------
{
  const text = 'start:\n  - "action.message(\'@trigger\', \'&e你进入了 {zone.name}\')"\n';
  const uri = openDoc('scripts.yml', text);
  await new Promise((r) => setTimeout(r, 250));
  const diags = client.diagnosticsFor(uri);
  check(
    '{zone.name} 这类区域脚本占位符不报错',
    !diags.some((d) => d.code === 'placeholder'),
    JSON.stringify(diags).slice(0, 250),
  );
}

// ---------- 用例 14b：complete 钩子不再被误标为「不会执行」 ----------
{
  const text = 'complete:\n  - "action.grant_reward(\'@all\', \'通关奖励\')"\n';
  const uri = openDoc('scripts.yml', text);
  await new Promise((r) => setTimeout(r, 250));
  const diags = client.diagnosticsFor(uri);
  check(
    'complete 钩子不再被标成 dead-hook（插件已修顺序）',
    !diags.some((d) => d.code === 'dead-hook'),
    JSON.stringify(diags).slice(0, 300),
  );
  check(
    'complete 钩子里的奖励名（rewards.yml 已定义）不报引用错误',
    !diags.some((d) => d.code === 'unknown-reference'),
    JSON.stringify(diags).slice(0, 300),
  );
  closeDoc(uri);
}

// ---------- 用例 16g：顶层键补全（曾经整体失效的回归） ----------
{
  const text = '\n';
  const uri = openDoc('config.yml', text);
  const topItems = await completions(uri, 0, 0);
  const top = labels(topItems);
  check('config.yml 顶层键补全非空', top.length >= 5, labelDump(topItems));
  check('顶层补全含 enable', top.includes('enable'), top.join(','));
  check('顶层补全含 hide', top.includes('hide'), top.join(','));
  check('顶层补全含 dungeon / world', top.includes('dungeon') && top.includes('world'), top.join(','));
  closeDoc(uri);

  // monsters.yml 的顶层应该是 groups（而不是"什么都能写"）
  const uri2 = openDoc('monsters.yml', '\n');
  const top2Items = await completions(uri2, 0, 0);
  const top2 = labels(top2Items);
  check('monsters.yml 顶层补全含 groups', top2.includes('groups'), labelDump(top2Items));
  check('monsters.yml 顶层不会列出组内键', !top2.includes('spawn_timing'), top2.join(','));
  closeDoc(uri2);
}

// ---------- 用例 16h：hide 的补全 ----------
{
  const text = 'hid\n';
  const uri = openDoc('config.yml', text);
  const items = await completions(uri, 0, 3);
  const hide = items.find((i) => i.label === 'hide');
  check('hide 能被补出来', Boolean(hide), labels(items).join(','));
  check('hide 文档说明它不影响进入', /仍可进入|GUI/.test(JSON.stringify(hide?.documentation ?? {})), JSON.stringify(hide?.documentation ?? {}).slice(0, 200));
  closeDoc(uri);
}

// ---------- 用例 16f：enable 总开关的补全 ----------
{
  // 注意：前缀必须是 ena —— 'enable'.startsWith('enu') 是 false，
  // 用 enu 只会得到空列表（那是正确行为，不是 bug）。
  const text = 'ena\n';
  const uri = openDoc('config.yml', text);
  const items0 = await completions(uri, 0, 3);
  const got = labels(items0);
  check('config.yml 顶层补全含 enable', got.includes('enable'), labelDump(items0));
  check('不匹配的前缀返回空（enu → 无键）', labels(await completions(uri, 0, 3)).length === 1, labelDump(items0));
  const enable = (await completions(uri, 0, 3)).find((i) => i.label === 'enable');
  check('enable 补全是布尔骨架', String(enable?.textEdit?.newText ?? '').includes('enable: '), JSON.stringify(enable?.textEdit ?? {}));
  check('enable 文档提到停用后果', /停用|屏障/.test(JSON.stringify(enable?.documentation ?? {})), JSON.stringify(enable?.documentation ?? {}).slice(0, 150));
  closeDoc(uri);
}

// ---------- 用例 16e：复活配置自相矛盾 ----------
{
  const broken = 'revive:\n  count: 0\n  auto:\n    delay: 5\n    at: spawn\n';
  const uri = openDoc('config.yml', broken);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'revive-count' && x.severity === 1) ? d : undefined;
  });
  const hit = diags?.find((x) => x.code === 'revive-count' && x.severity === 1);
  check('revive 配了自动复活但 count: 0 被标为错误', Boolean(hit), JSON.stringify(diags ?? []).slice(0, 300));
  check('提示里说清了后果（旁观者起不来）', /旁观者/.test(hit?.message ?? ''), hit?.message ?? '');
  check('提示里给了修法（正数或 -1）', /-1/.test(hit?.message ?? ''), hit?.message ?? '');
  closeDoc(uri);

  const ok = 'revive:\n  count: 3\n  auto:\n    delay: 5\n    at: spawn\n';
  const uri2 = openDoc('config.yml', ok);
  await new Promise((r) => setTimeout(r, 250));
  check(
    'count: 3 的正常配置不报 revive-count 错误',
    !client.diagnosticsFor(uri2).some((x) => x.code === 'revive-count' && x.severity === 1),
    JSON.stringify(client.diagnosticsFor(uri2)).slice(0, 300),
  );
  closeDoc(uri2);
}

// ---------- 用例 16i：enable / hide 的组合提示 ----------
{
  const uri = openDoc('config.yml', 'enable: false\nhide: true\ndungeon:\n  name: x\n');
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'dungeon-switches') ? d : undefined;
  });
  check('停用 + 隐藏的矛盾组合被提示', Boolean(diags), JSON.stringify(diags ?? []).slice(0, 250));
  check('这类提示是 Information 级别而不是错误',
    diags?.find((x) => x.code === 'dungeon-switches')?.severity === 3,
    String(diags?.find((x) => x.code === 'dungeon-switches')?.severity));
  closeDoc(uri);

  const uri2 = openDoc('config.yml', 'enable: true\nhide: true\n');
  await new Promise((r) => setTimeout(r, 250));
  check('enable: true + hide: true 是正常组合，不提示',
    !client.diagnosticsFor(uri2).some((x) => x.code === 'dungeon-switches'),
    JSON.stringify(client.diagnosticsFor(uri2)).slice(0, 250));
  closeDoc(uri2);
}

// ---------- 用例 16c：rewards.yml 的随机奖励结构诊断 ----------
{
  // 少了 options 这一层：奖励会静默不发放
  const broken = 'rewards:\n  随机奖励:\n    type: random\n    book_1000:\n      commands:\n        - give %player% book 2\n    金币:\n      money: 1000\n';
  const uri = openDoc('rewards.yml', broken);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'reward-options-missing') ? d : undefined;
  });
  const miss = diags?.find((x) => x.code === 'reward-options-missing');
  check('type: random 少写 options 被标为错误', miss?.severity === 1, JSON.stringify(diags ?? []).slice(0, 300));
  check('提示里点出真正的问题是选项数为 0', /选项数为 0|不发放/.test(miss?.message ?? ''), miss?.message ?? '');
  check('提示会把写错的键名点出来（book_1000）', /book_1000/.test(miss?.message ?? ''), miss?.message ?? '');
  closeDoc(uri);
}

// ---------- 用例 16d：权重缺失 / 全零 ----------
{
  const someZero = 'rewards:\n  随机奖励:\n    type: random\n    options:\n      a:\n        weight: 10\n        money: 100\n      b:\n        commands:\n          - give %player% paper 2\n';
  const uri = openDoc('rewards.yml', someZero);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'reward-weight') ? d : undefined;
  });
  check('选项缺 weight 被标为「永远抽不到」', /永远抽不到/.test(JSON.stringify(diags ?? [])), JSON.stringify(diags ?? []).slice(0, 300));
  closeDoc(uri);

  const allZero = 'rewards:\n  随机奖励:\n    type: random\n    options:\n      a:\n        money: 100\n      b:\n        money: 200\n';
  const uri2 = openDoc('rewards.yml', allZero);
  const diags2 = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri2);
    // 上一个用例的诊断也用同一个 code，必须等消息内容真的换成「等概率」那条
    return d.some((x) => /等概率/.test(x.message)) ? d : undefined;
  });
  check('所有选项权重为 0 时提示会退化成等概率', /等概率/.test(JSON.stringify(diags2 ?? [])), JSON.stringify(diags2 ?? []).slice(0, 300));
  closeDoc(uri2);
}

// ---------- 用例 17：真实示例配置没有误报 ----------
{
  for (const uri of openUris) closeDoc(uri);
  openUris.length = 0;
  await new Promise((r) => setTimeout(r, 150));
  for (const n of ['config.yml', 'monsters.yml', 'scripts.yml', 'rewards.yml', 'zones.yml', 'obstacles.yml', 'interacts.yml', 'tasks.yml', 'stages.yml']) {
    let text;
    try {
      text = readFileSync(join(DUNGEON_ROOT, n), 'utf8');
    } catch {
      continue;
    }
    const uri = openDoc(n, text);
    await new Promise((r) => setTimeout(r, 120));
    const diags = client.diagnosticsFor(uri);
    const warnings = diags.filter((d) => d.severity <= 2);
    check(`插件自带的 ${n} 没有严重误报`, warnings.length === 0, JSON.stringify(warnings).slice(0, 400));
  }
}

// ---------- 用例 17b：路径匹配的语义（补全能不能按层级正确过滤） ----------
// 这里不单独引入 yaml-shared 做纯函数断言（它被 esbuild 内联过，直接引用容易踩坑），
// 而是用真实补全结果间接验证：不同层级必须给出不同的键集合。
{
  // monsters.yml：顶层只该有 groups；组内才该有 spawn_timing
  const top = openDoc('monsters.yml', '\n');
  const topLabels = labels(await completions(top, 0, 0));
  check('monsters.yml 顶层只有 groups（不泄漏组内键）',
    topLabels.includes('groups') && !topLabels.includes('spawn_timing'), labelDump(topLabels));
  closeDoc(top);

  const inner = openDoc('monsters.yml', 'groups:\n  wave_1:\n    \n');
  const innerLabels = labels(await completions(inner, 2, 4));
  check('组内给出 spawn_timing', innerLabels.includes('spawn_timing'), labelDump(innerLabels));
  check('组内不给出顶层 groups', !innerLabels.includes('groups'), labelDump(innerLabels));
  closeDoc(inner);
}

// ---------- 用例 17c：引用查找 / 同词高亮 / 重命名（pkg 里的三个新能力） ----------
{
  // 造一个自洽的小副本：组名 wave_1 在 monsters.yml 里定义、被 trigger_group 引用，
  // 又在 scripts.yml 的脚本里当成参数用 —— 这三处都必须被找出来。
  const monstersText = [
    '# 关卡定义',
    'groups:',
    '  wave_1:',
    '    spawn_timing:',
    '      type: AUTO_START',
    '    on_end: |-',
    "      action.complete_dungeon()",
    '  boss:',
    '    spawn_timing:',
    '      type: TRIGGERED',
    '    trigger_group: wave_1',
    '    monsters:',
    '      - id: Zombie',
    "        location: '0,64,0'",
    '',
  ].join('\n');
  const scriptsText = [
    '# 脚本',
    'start:',
    '  - "action.message(\'@all\', \'开始\')"',
    '  - "action.spawn_group(\'wave_1\')"',
    '  - "dungeon.isGroupCleared(\'wave_1\')"',
    '  # action.spawn_group(\'wave_1\')  <- 注释里不算引用',
    '',
  ].join('\n');
  openDoc('config.yml', 'dungeon:\n  name: 测试\nenable: true\n');
  const mUri = openDoc('monsters.yml', monstersText);
  const sUri = openDoc('scripts.yml', scriptsText);
  await new Promise((r) => setTimeout(r, 300));

  // 引用查找：光标停在 trigger_group 的值上（第 10 行）
  const atGroupRef = posOf(monstersText, 'wave_1'); // = trigger_group 的值
  const refs = await request('textDocument/references', {
    textDocument: { uri: mUri },
    position: atGroupRef,
    context: { includeDeclaration: true },
  });
  check('查找引用返回结果', Array.isArray(refs) && refs.length >= 3, JSON.stringify(refs ?? []).slice(0, 200));
  const refFiles = new Set((refs ?? []).map((r) => r.uri.split('/').pop()));
  check('引用跨越 monsters.yml 与 scripts.yml', refFiles.has('monsters.yml') && refFiles.has('scripts.yml'), [...refFiles].join(','));
  check('注释里的同名写法不算引用', (refs ?? []).filter((r) => r.uri.endsWith('scripts.yml')).length === 2, JSON.stringify((refs ?? []).filter((r) => r.uri.endsWith('scripts.yml'))));

  // 不带 includeDeclaration 时应排除定义处
  const refsNoDecl = await request('textDocument/references', {
    textDocument: { uri: mUri },
    position: atGroupRef,
    context: { includeDeclaration: false },
  });
  check('includeDeclaration:false 时定义处被排除', (refsNoDecl ?? []).length === (refs ?? []).length - 1, `${(refsNoDecl ?? []).length} vs ${(refs ?? []).length}`);

  // 同词高亮：只在本文件
  const highlights = await request('textDocument/documentHighlight', {
    textDocument: { uri: mUri },
    position: atGroupRef,
  });
  check('同词高亮只给本文件的命中', (highlights ?? []).length === 2, JSON.stringify(highlights ?? []));
  check('高亮区分定义处与引用处',
    (highlights ?? []).some((h) => h.kind === 3) && (highlights ?? []).some((h) => h.kind === 2),
    JSON.stringify(highlights ?? []));

  // 跳转定义
  const defs = await request('textDocument/definition', {
    textDocument: { uri: sUri },
    position: posOf(scriptsText, 'wave_1'),
  });
  check('从脚本里的参数能跳到组定义', (defs ?? []).length === 1 && (defs ?? [])[0].range.start.line === 2,
    JSON.stringify(defs ?? []));

  // 重命名
  const prepared = await request('textDocument/prepareRename', {
    textDocument: { uri: mUri },
    position: atGroupRef,
  });
  check('prepareRename 给出可改范围', Boolean(prepared?.range), JSON.stringify(prepared ?? {}));

  const edit = await request('textDocument/rename', {
    textDocument: { uri: mUri },
    position: atGroupRef,
    newName: 'wave_2',
  });
  const changedFiles = Object.keys(edit?.changes ?? {});
  check('重命名同时改 monsters.yml 与 scripts.yml', changedFiles.length === 2, changedFiles.map((u) => u.split('/').pop()).join(','));
  const mEdits = edit?.changes?.[mUri] ?? [];
  const sEdits = edit?.changes?.[sUri] ?? [];
  check('monsters.yml 改定义键 + trigger_group 值', mEdits.length === 2, JSON.stringify(mEdits));
  check('scripts.yml 改两处参数', sEdits.length === 2, JSON.stringify(sEdits));
  check('定义键的编辑带上了引号规则（无引号则不加）',
    mEdits.some((e) => e.newText === 'wave_2') && mEdits.every((e) => !e.newText.includes("'")),
    JSON.stringify(mEdits));

  // 非法名字应被拒
  const bad = await client.request('textDocument/rename', {
    textDocument: { uri: mUri },
    position: atGroupRef,
    newName: 'bad.name',
  });
  check('含点号的新名字被拒绝', Boolean(bad.error), JSON.stringify(bad).slice(0, 200));

  closeDoc(mUri);
  closeDoc(sUri);
  closeDoc('file://' + DUNGEON_ROOT + '/config.yml');
}

// ---------- 用例 17d：快速修复（code action） ----------
{
  // 场景 1：revive 配了方式却 count: 0 → 提供两个改法
  const reviveText = 'revive:\n  count: 0\n  auto:\n    delay: 5\n';
  const uri = openDoc('config.yml', reviveText);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'revive-count' && x.severity === 1) ? d : undefined;
  });
  const actions = await request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 12 } },
    context: { diagnostics: (diags ?? []).filter((d) => d.code === 'revive-count') },
  });
  const titles = (actions ?? []).map((a) => a.title);
  check('count: 0 给出「改成 -1」的修复', titles.some((t) => t.includes('-1')), titles.join(' | '));
  check('count: 0 给出「改成 3」的修复', titles.some((t) => t.includes('3')), titles.join(' | '));
  const edit = (actions ?? []).find((a) => a.title.includes('-1'))?.edit?.changes?.[uri]?.[0];
  check('修复的编辑范围与内容正确', edit?.newText === '  count: -1', JSON.stringify(edit ?? {}));
  closeDoc(uri);

  // 场景 2：随机奖励缺 options → 插入骨架
  const rewardText = 'rewards:\n  随机奖励:\n    type: random\n    book_1000:\n      commands:\n        - give %player% book 2\n';
  const rUri = openDoc('rewards.yml', rewardText);
  const rDiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(rUri);
    return d.some((x) => x.code === 'reward-options-missing') ? d : undefined;
  });
  const rActions = await request('textDocument/codeAction', {
    textDocument: { uri: rUri },
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 14 } },
    context: { diagnostics: (rDiags ?? []).filter((d) => d.code === 'reward-options-missing') },
  });
  const insert = (rActions ?? [])[0]?.edit?.changes?.[rUri]?.[0];
  check('缺 options 时提供插入骨架的修复', (rActions ?? []).length === 1, JSON.stringify(rActions ?? []).slice(0, 200));
  check('插入内容含 options 与 weight', /options:/.test(insert?.newText ?? '') && /weight:/.test(insert?.newText ?? ''), JSON.stringify(insert ?? {}));
  check('插入位置在 type 行之后', insert?.range?.start?.line === 3, JSON.stringify(insert?.range ?? {}));
  closeDoc(rUri);

  // 场景 3：拼错的钩子名 → 给出正确名的替换
  const hookText = 'startt:\n  - "action.message(\'@all\', \'x\')"\n';
  const hUri = openDoc('scripts.yml', hookText);
  const hDiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(hUri);
    return d.some((x) => x.code === 'unknown-hook') ? d : undefined;
  });
  const hActions = await request('textDocument/codeAction', {
    textDocument: { uri: hUri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
    context: { diagnostics: (hDiags ?? []).filter((d) => d.code === 'unknown-hook') },
  });
  check('startt 被建议改成 start', (hActions ?? [])[0]?.title?.includes('start'), JSON.stringify(hActions ?? []).slice(0, 150));
  const hookEdit = (hActions ?? [])[0]?.edit?.changes?.[hUri]?.[0];
  check('钩子修复是替换而非插入', hookEdit?.newText === 'start', JSON.stringify(hookEdit ?? {}));
  closeDoc(hUri);

  // 场景 4：没有诊断时不应乱给修复
  const cleanUri = openDoc('config.yml', 'enable: true\nhide: false\n');
  await new Promise((r) => setTimeout(r, 250));
  const none = await request('textDocument/codeAction', {
    textDocument: { uri: cleanUri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    context: { diagnostics: [] },
  });
  check('没有诊断时不给修复', (none ?? []).length === 0, JSON.stringify(none ?? []).slice(0, 150));
  closeDoc(cleanUri);
}

// ---------- 用例 17e：引号漏写（选择器 / 颜色代码 / 中文文本）----------
{
  // 真实现场：插件日志只给得出 "Expected an operand but found error"
  const bad =
    'groups:\n' +
    '  wave_1:\n' +
    '    on_start: |-\n' +
    '      action.title(@all, &e文本, &e文本)\n' +
    "      action.message('@all', '&e你好')\n" +
    '      action.teleport_zone(@all, 前厅)\n';
  const uri = openDoc('monsters.yml', bad);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(uri);
    return d.some((x) => x.code === 'script-quote') ? d : undefined;
  });
  const quotes = (diags ?? []).filter((d) => d.code === 'script-quote');
  check('选择器/颜色代码/中文裸词共报 5 处（写对的那行不报）', quotes.length === 5,
    JSON.stringify(quotes.map((q) => `${q.range.start.line}:${q.range.start.character}`)));

  const sel = quotes.find((q) => q.range.start.line === 3);
  check('未加引号的选择器是 Error（插件会直接抛语法错误）', sel?.severity === 1,
    JSON.stringify(quotes.map((q) => `${q.range.start.line}:${q.severity}`)));
  check('诊断范围正好盖住参数 @all',
    sel?.range.start.character === 19 && sel?.range.end.character === 23,
    JSON.stringify(sel?.range ?? {}));
  check('提示里给出正确写法', /'@all'/.test(sel?.message ?? ''), sel?.message ?? '');

  const cjk = quotes.find((q) => q.range.start.line === 5 && q.severity === 2);
  check('中文裸词是 Warning（可能只是变量名）', Boolean(cjk),
    JSON.stringify(quotes.map((q) => `${q.range.start.line}:${q.severity}`)));

  // 快速修复：一键给参数套上引号
  const acts = await request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 3, character: 19 }, end: { line: 3, character: 23 } },
    context: { diagnostics: [sel] },
  });
  const fix = (acts ?? [])[0]?.edit?.changes?.[uri]?.[0];
  check('提供「给参数加上引号」的修复', /引号/.test((acts ?? [])[0]?.title ?? ''),
    JSON.stringify((acts ?? []).map((a) => a.title)));
  check("修复内容是把 @all 变成 '@all'", fix?.newText === "'@all'", JSON.stringify(fix ?? {}));
  closeDoc(uri);

  // 正确写法零误报（含行尾注释里的 @）
  const okUri = openDoc('scripts.yml',
    'start:\n  - "action.title(\'@all\', \'&e准备开始\')" # 给 @all 发\n');
  await new Promise((r) => setTimeout(r, 250));
  check('全引号 + 注释里的 @ 都不报',
    !(client.diagnosticsFor(okUri) ?? []).some((d) => d.code === 'script-quote'),
    JSON.stringify(client.diagnosticsFor(okUri) ?? []).slice(0, 200));
  closeDoc(okUri);
}

// ---------- 用例 17f：补全插进编辑器的那段代码必须是能直接跑的 ----------
// 真实现场：补全 `action.title(` 得到的是 action.title(@all, &e文本, &e文本)，
// 全是裸词 —— 脚本是 JS，裸的 @all / &e文本 直接语法错误，
// 而服务端只回一句 "Expected an operand but found error"，看不出是补全的锅。
{
  const uri = openDoc('monsters.yml',
    'groups:\n  wave_1:\n    on_start: |-\n      action.\n');
  const items = await completions(uri, 3, 13);
  const textOf = (i) => i.textEdit?.newText ?? i.insertText ?? '';
  const title = items.find((i) => i.label === 'title') ?? items.find((i) => i.label.endsWith('title'));
  check('action. 之后能补出 title', Boolean(title), labelDump(labels(items)));
  check("title 的补全带引号（'@all' / '&e文本'）",
    textOf(title).includes("'@all'") && textOf(title).includes("'&e"),
    textOf(title));
  check('补全里没有裸词参数',
    !/[(,]\s*(@|&)/.test(textOf(title)), textOf(title));

  const give = items.find((i) => i.label === 'give_item');
  check('数字参数不加引号（give_item 的第 3 个参数）',
    Boolean(give) && /,\s*\$\{\d+:\d+\}\s*\)$/.test(textOf(give)), textOf(give));
  closeDoc(uri);

  // dungeon.* 的 player 参数是脚本变量，不能加引号
  const duri = openDoc('monsters.yml',
    'groups:\n  wave_1:\n    on_start: |-\n      dungeon.\n');
  const ditems = await completions(duri, 3, 14);
  const hp = ditems.find((i) => i.label === 'hasPlayer');
  check('dungeon.hasPlayer(player) 的 player 不加引号',
    Boolean(hp) && textOf(hp).includes('${1:player}'), textOf(hp));
  closeDoc(duri);
}

// ---------- 用例 20：脚本字段的默认排版是 |- 块（1.1.1 起的统一约定） ----------
{
  // 钩子的补全 / 悬停示例都必须是块写法
  const uri = openDoc('scripts.yml', 'com\n');
  const items = await completions(uri, 0, 3);
  const hook = items.find((i) => i.label === 'complete');
  const newText = String(hook?.textEdit?.newText ?? '');
  check('钩子补全插入的是 |- 块', newText.startsWith('complete: |-'), newText);
  check('钩子补全块里带引号参数与分号',
    newText.includes("action.message('@all'") && /;\}/.test(newText), newText);
  check('钩子补全不再插入列表写法', !newText.includes('- "'), newText);

  const doc = String(hook?.documentation?.value ?? '');
  check('钩子文档里不含列表写法', !doc.includes('- "'), doc.slice(0, 200));
  check('钩子文档不再写着「会被终态守卫丢弃」', !/丢弃|不会执行/.test(doc), doc.slice(0, 200));

  const huri = openDoc('scripts.yml', 'complete: |-\n  action.grant_reward(\'@all\', \'通关奖励\');\n');
  const h = await hover(huri, 0, 4);
  const hv = h?.contents?.value ?? '';
  check('钩子悬停能给出说明', hv.includes('complete'), hv.slice(0, 120));
  closeDoc(huri);
  closeDoc(uri);

  // monsters.yml 的脚本节点（on_end 等）走 valueTemplate
  const muri = openDoc('monsters.yml', 'groups:\n  wave_1:\n    on_\n');
  const node = (await completions(muri, 2, '    on_'.length)).find((i) => i.label === 'on_end');
  const nodeText = String(node?.textEdit?.newText ?? '');
  check('on_end 的骨架是 |- 块', /on_end: \|-\n\s+\$\{\d+:action\./.test(nodeText), nodeText);
  check('on_end 骨架里是带引号且带分号的语句',
    nodeText.includes("action.message('@all'") && /;\}/.test(nodeText), nodeText);
  closeDoc(muri);

  // 生成的 VS Code 片段（snippets/*.code-snippets）与补全同源
  const yamlSnips = JSON.parse(readFileSync('snippets/liudungeon-yaml.code-snippets', 'utf8'));
  const hookSnip = yamlSnips['ld-hook-complete'];
  check('ld-hook-complete 生成的是 |- 块',
    Array.isArray(hookSnip?.body) && hookSnip.body[0] === 'complete: |-', JSON.stringify(hookSnip?.body ?? []));
  const hookLine = String(hookSnip?.body?.[1] ?? '');
  check('ld-hook-complete 的语句带分号且无外层引号',
    hookLine.includes("action.grant_reward('@all'") && hookLine.trimEnd().endsWith(';') && !hookLine.includes('"'),
    hookLine);
  const msgSnip = yamlSnips['ld-message'];
  check('ld-message 片段是块里的一行（不是列表项）',
    Array.isArray(msgSnip?.body) && !msgSnip.body[0].startsWith('- ') && msgSnip.body[0].includes("action.message('@all'"),
    JSON.stringify(msgSnip?.body ?? []));
}

// ---------- 用例 21：|- 块里的两种排版坑要报出来 ----------
{
  // 整行被引号包住 = 字符串字面量，什么都不做（从列表写法改成块写法时最容易剩下的一层引号）
  const quoted = openDoc('scripts.yml', 'complete: |-\n  "action.title(\'@all\', \'&a通关\');"\n');
  const qd = await client.waitFor(() => {
    const d = client.diagnosticsFor(quoted);
    return d.some((x) => x.code === 'block-quoted-line') ? d : undefined;
  });
  check('|- 块里整行被引号包住会被标出来', Boolean(qd), JSON.stringify(qd ?? []).slice(0, 300));
  closeDoc(quoted);

  // 行尾 # 注释 = JS 语法错误（# 是私有字段语法），整段脚本被引擎静默跳过
  const hash = openDoc('scripts.yml', 'complete: |-\n  action.title(\'@all\', \'&a通关\')            # ← 标题\n');
  const hd = await client.waitFor(() => {
    const d = client.diagnosticsFor(hash);
    return d.some((x) => x.code === 'block-hash-comment') ? d : undefined;
  });
  check('|- 块里的 # 注释会被标为语法错误', Boolean(hd), JSON.stringify(hd ?? []).slice(0, 300));
  closeDoc(hash);

  // 反例：列表写法里的 # 是合法的 YAML 注释，不能误报
  const list = openDoc('scripts.yml', 'complete:\n  - "action.title(\'@all\', \'&a通关\')"   # ← YAML 注释，合法\n');
  await new Promise((r) => setTimeout(r, 250));
  check('列表写法里的 # 注释不误报',
    !client.diagnosticsFor(list).some((d) => d.code === 'block-hash-comment'),
    JSON.stringify(client.diagnosticsFor(list)).slice(0, 250));
  closeDoc(list);

  // 反例：字符串里的 # 颜色值不算注释
  const color = openDoc('monsters.yml',
    'groups:\n  wave_1:\n    on_start: |-\n      action.message(\'@all\', \'&7颜色 #FF0000 不是注释\')\n');
  await new Promise((r) => setTimeout(r, 250));
  check('字符串里的 # 不误报',
    !client.diagnosticsFor(color).some((d) => d.code === 'block-hash-comment'),
    JSON.stringify(client.diagnosticsFor(color)).slice(0, 250));
  closeDoc(color);
}

// ---------- 用例 22：action.hologram（新动作：2/3/4/5 参重载 + 参数个数不能误报） ----------
// 三个重载（2/3/4 参）正好撞上"参数个数按重载集合校验"这条诊断：只要数据里漏一个重载，
// 合法的四参调用就会被标成错误 —— 而玩家看到红波浪线只会以为是自己写错了。
{
  const okText = "start: |-\n  action.hologram('&e提示', 'Boss房.中心', 2.0, '30s')\n";
  const okUri = openDoc('scripts.yml', okText);
  await new Promise((r) => setTimeout(r, 250));
  const bad = client.diagnosticsFor(okUri).filter((x) => x.code === 'arity' || x.code === 'unknown-method');
  check('hologram 四参调用不报错（重载都要在数据里）', bad.length === 0, JSON.stringify(bad).slice(0, 250));
  closeDoc(okUri);

  const noUri = openDoc('scripts.yml', "start: |-\n  action.clear_holograms()\n");
  await new Promise((r) => setTimeout(r, 250));
  const d2 = client.diagnosticsFor(noUri).filter((x) => x.code === 'unknown-method');
  check('clear_holograms 零参调用被认作已实现的方法', d2.length === 0, JSON.stringify(d2).slice(0, 250));
  closeDoc(noUri);

  // 五参是 Y 偏移（不再是"多写了一个"）：合法，不能报
  const fiveText = "start: |-\n  action.hologram('t', '0,64,0', 1.0, '10s', 2.5)\n";
  const fiveUri = openDoc('scripts.yml', fiveText);
  await new Promise((r) => setTimeout(r, 250));
  const fiveBad = client.diagnosticsFor(fiveUri).filter((x) => x.code === 'arity');
  check('hologram 五参（Y 偏移重载）不报 arity', fiveBad.length === 0, JSON.stringify(fiveBad).slice(0, 250));
  closeDoc(fiveUri);

  const sixUri = openDoc('scripts.yml', "start: |-\n  action.hologram('t', '0,64,0', 1.0, '10s', 2.5, '多写了一个')\n");
  const six = await client.waitFor(() => {
    const d = client.diagnosticsFor(sixUri).filter((x) => x.code === 'arity');
    return d.length >= 1 ? d : undefined;
  });
  check('hologram 六参（没有这个重载）会被报出来',
    /hologram 没有 6 个参数的版本/.test((six ?? []).map((x) => x.message).join(' | ')),
    (six ?? []).map((x) => x.message).join(' | '));
  closeDoc(sixUri);
}

// ---------- 用例 23：revive.on_ally_revive（新钩子键） ----------
{
  const uri = openDoc('config.yml', 'revive:\n  count: 3\n  on_ally_revive: |-\n    action.message(\'@all\', \'救起来了\')\n');
  await new Promise((r) => setTimeout(r, 250));
  const diags = client.diagnosticsFor(uri).filter((x) => x.code === 'unknown-key');
  check('revive.on_ally_revive 不被当成未知键', diags.length === 0, JSON.stringify(diags).slice(0, 250));

  // 同一段里把钩子名写错时仍然要报（说明这条断言不是因为"整段都不校验"才过的）
  const badUri = openDoc('config.yml', 'revive:\n  on_ally_revive_typo: |-\n    action.message(\'@all\', \'x\')\n');
  const bad = await client.waitFor(() => {
    const d = client.diagnosticsFor(badUri).filter((x) => x.code === 'unknown-key');
    return d.length >= 1 ? d : undefined;
  });
  check('拼错的 revive 子键照样报未知键', Boolean(bad), JSON.stringify(bad ?? []).slice(0, 250));
  closeDoc(badUri);
  closeDoc(uri);
}

// ---------- 用例 18：数据完整性（补全数据与插件源码对齐） ----------
{
  const action = JSON.parse(readFileSync('data/action-methods.json', 'utf8'));
  const dungeon = JSON.parse(readFileSync('data/dungeon-methods.json', 'utf8'));
  const config = JSON.parse(readFileSync('data/config-files.json', 'utf8'));
  check('action API 方法数 >= 60', action.methods.length >= 60, `实际 ${action.methods.length}`);
  check('dungeon API 方法数 >= 45', dungeon.methods.length >= 45, `实际 ${dungeon.methods.length}`);
  check('配置文件覆盖 11 个文件', config.files.length === 11, `实际 ${config.files.length}`);
  check('配置节点数 >= 180', config.files.reduce((n, f) => n + f.nodes.length, 0) >= 180, '');
  check('生命周期钩子 7 个', config.scriptHooks.length === 7, `实际 ${config.scriptHooks.length}`);
  check('中文条件关键词 >= 30', config.conditions.keywords.length >= 30, `实际 ${config.conditions.keywords.length}`);
  // 词表必须与插件 ScriptEngine.CN_KEYWORDS 对齐：漏一个词，编辑器就会把合法条件报成错的
  const javaEngine = readFileSync(
    join(PLUGIN_DIR, 'src/main/java/com/liu/liudungeon/script/ScriptEngine.java'),
    'utf8',
  );
  const table = javaEngine.slice(javaEngine.indexOf('CN_KEYWORDS = java.util.List.of('));
  const javaCn = new Set([...table.matchAll(/new String\[]\{"([^"]+)",/g)].map((m) => m[1]));
  const dataCn = new Set(config.conditions.keywords.map((k) => k.cn));
  const missingCn = [...javaCn].filter((w) => !dataCn.has(w));
  check('ScriptEngine 的中文条件词一个都没漏', missingCn.length === 0, `缺少：${missingCn.join(', ')}`);

  // 与 Java 源码逐方法核对：源码里有 public 方法 → 数据里必须有
  const java = readFileSync(join(PLUGIN_DIR, 'src/main/java/com/liu/liudungeon/script/action/ActionApi.java'), 'utf8');
  const javaNames = new Set([...java.matchAll(/public\s+(?:static\s+)?[\w<>\[\], .]+\s+(\w+)\s*\(/g)].map((m) => m[1]));
  const dataNames = new Set(action.methods.map((m) => m.name));
  const missing = [...javaNames].filter((n) => !dataNames.has(n) && !['ScriptStopSignal'].includes(n));
  check('ActionApi.java 的所有 public 方法都在补全数据里', missing.length === 0, `缺少：${missing.join(', ')}`);

  const javaD = readFileSync(join(PLUGIN_DIR, 'src/main/java/com/liu/liudungeon/script/action/DungeonApi.java'), 'utf8');
  const javaDNames = new Set([...javaD.matchAll(/public\s+(?:static\s+)?[\w<>\[\], .]+\s+(\w+)\s*\(/g)].map((m) => m[1]));
  const dataDNames = new Set(dungeon.methods.map((m) => m.name));
  const missingD = [...javaDNames].filter((n) => !dataDNames.has(n) && n !== 'toString');
  check('DungeonApi.java 的所有 public 方法都在补全数据里', missingD.length === 0, `缺少：${missingD.join(', ')}`);

  // ---- 插件主配置（plugins/liudungeon/config.yml）：与 PluginConfig.java 逐键核对 ----
  // 这份是**另一份同名文件**，数据单独放 data/plugin-config.json，用合成名 'plugin-config.yml'
  // 做键（真名 config.yml 已被副本那份占用，见 schemaKeyFor）。
  const pluginCfg = JSON.parse(readFileSync('data/plugin-config.json', 'utf8'));
  check('主配置数据用合成名做键', pluginCfg.file === 'plugin-config.yml', pluginCfg.file);
  const cfgPaths = pluginCfg.nodes.map((n) => n.path);
  check('主配置数据没有重复的键路径', new Set(cfgPaths).size === cfgPaths.length, '');
  check('主配置的每个键都有说明', pluginCfg.nodes.every((n) => (n.doc ?? '').trim().length > 0),
    pluginCfg.nodes.filter((n) => !(n.doc ?? '').trim()).map((n) => n.path).join(', '));

  const javaCfg = readFileSync(
    join(PLUGIN_DIR, 'src/main/java/com/liu/liudungeon/config/PluginConfig.java'),
    'utf8',
  );
  const javaCfgKeys = new Set(
    [...javaCfg.matchAll(/\.get(?:String|Int|Long|Double|Boolean|StringList|List|ConfigurationSection)\("([^"]+)"/g)]
      .map((m) => m[1]),
  );
  const pathSet = new Set(cfgPaths);
  // 段式读法（getConfigurationSection("cross-server.servers") + section.getString(id + ".host")）
  // 在数据里写作 cross-server.servers.<服名>.host，所以允许"多一层通配段"的匹配。
  const missingCfg = [...javaCfgKeys].filter(
    (k) => !pathSet.has(k) && !cfgPaths.some((p) => p.startsWith(`${k}.<`)),
  );
  check('PluginConfig.java 读的每个键都在主配置数据里', missingCfg.length === 0, `缺少：${missingCfg.join(', ')}`);

  // 枚举取值必须与 Java 的 enum 对齐：插件是 valueOf(toUpperCase())，写错静默回落，
  // 所以补全列表错了等于教人写错。
  for (const [path, enumName] of [
    ['database.type', 'DatabaseType'],
    ['dungeon.anti-escape.mode', 'AntiEscapeMode'],
    ['script.on-error', 'ScriptErrorAction'],
  ]) {
    const body = new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?);`).exec(javaCfg)?.[1] ?? '';
    const javaValues = body.split(',').map((v) => v.trim()).filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));
    const dataValues = pluginCfg.nodes.find((n) => n.path === path)?.values ?? [];
    check(`${path} 的取值与 ${enumName} 对齐`,
      javaValues.length > 0 && javaValues.length === dataValues.length
        && javaValues.every((v) => dataValues.includes(v)),
      `Java=[${javaValues.join(',')}] 数据=[${dataValues.join(',')}]`);
  }
}

// ---------- 用例 19：类型声明文件可生成且语法正确 ----------
{
  const mod = await import(pathToFileURL(join(process.cwd(), 'out/server/server.js')).href).catch(() => null);
  void mod;
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, ['scripts/gen-dts-check.mjs'], { stdio: 'pipe' });
    check('liudungeon.d.ts 生成通过 tsc 语法检查', true, '');
  } catch (e) {
    check('liudungeon.d.ts 生成通过 tsc 语法检查', false, String(e.stdout ?? e.message).slice(0, 400));
  }
}

// ---------- 用例 20：名字补全（每种引用类型都要能列出本副本的定义） ----------
// 这一组是回归的重点：索引层一度把「区域 / 点位 / 交互 / 阶段」四类全收丢了
// （containerAliases 的键写成了容器名而不是引用类型），表现在括号里给出的是
// 一长串方法名，而不是副本里的名字 —— 而当时没有任何用例覆盖到。
{
  const cases = [
    ['enable_zone', 'zones', '战斗区', "start:\n  - \"action.enable_zone('')\"\n"],
    ['teleport_point', 'points', '战斗区.中心', "start:\n  - \"action.teleport_point('')\"\n"],
    ['trigger_interact', 'interacts', '能量核心', "start:\n  - \"action.trigger_interact('')\"\n"],
    ['goto_stage', 'stages', '第一阶段', "start:\n  - \"action.goto_stage('')\"\n"],
    ['grant_reward', 'rewards', '通关奖励', "start:\n  - \"action.grant_reward('@all','')\"\n"],
    ['spawn_group', 'groups', 'wave_1', "start:\n  - \"action.spawn_group('')\"\n"],
    ['create_obstacle', 'obstacles', 'Boss门', "start:\n  - \"action.create_obstacle('')\"\n"],
    ['remove_obstacle', 'obstacles', 'Boss门', "start:\n  - \"action.remove_obstacle('')\"\n"],
    ['toggle_obstacle', 'obstacles', 'Boss门', "start:\n  - \"action.toggle_obstacle('')\"\n"],
  ];
  for (const [method, kind, expect, text] of cases) {
    const uri = openDoc('scripts.yml', text, REF_DIR);
    await new Promise((r) => setTimeout(r, 150));
    const got = labels(await completions(uri, 1, text.split('\n')[1].indexOf(`'`) + 1));
    check(`${method} 的参数补全列出${kind}的「${expect}」`, got.includes(expect), got.join(','));
    check(`${method} 的参数补全不再退回方法名清单`, !got.includes('complete_dungeon'), got.slice(0, 8).join(','));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }

  // dungeon.* 侧的障碍物查询
  for (const method of ['isObstacleClosed', 'hasObstacle']) {
    const text = `start:\n  - "dungeon.${method}('')"\n`;
    const uri = openDoc('scripts.yml', text, REF_DIR);
    await new Promise((r) => setTimeout(r, 150));
    const got = labels(await completions(uri, 1, text.split('\n')[1].indexOf(`'`) + 1));
    check(`dungeon.${method} 的名字补全列出「Boss门」`, got.includes('Boss门'), got.join(','));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ---------- 用例 21：YAML 值位置的名字补全（中英文键都要有） ----------
{
  const cases = [
    ['monsters.yml', 'groups:\n  wave_1:\n    zone: \n', 'zone: ', '战斗区'],
    ['monsters.yml', '怪物组:\n  wave_1:\n    区域: \n', '区域: ', '战斗区'],
    ['monsters.yml', '怪物组:\n  wave_1:\n    monsters:\n      x:\n        点位: \n', '点位: ', '战斗区.中心'],
    ['monsters.yml', '怪物组:\n  wave_1:\n    触发组: \n', '触发组: ', 'wave_1'],
    ['obstacles.yml', '障碍物:\n  Boss门:\n    区域: \n', '区域: ', '战斗区'],
  ];
  for (const [file, text, token, expect] of cases) {
    const uri = openDoc(file, text, REF_DIR);
    await new Promise((r) => setTimeout(r, 150));
    const line = text.split('\n').findIndex((l) => l.includes(token));
    const got = labels(await completions(uri, line, text.split('\n')[line].length));
    check(`${file} 的「${token.trim()}」值补全列出「${expect}」`, got.includes(expect), got.join(','));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ---------- 用例 22：跨文件引用校验（写错的名字要报出来） ----------
{
  const bad = [
    ['scripts.yml', "start:\n  - \"action.enable_zone('查无此区')\"\n", /区域「查无此区」/, '区域'],
    ['scripts.yml', "start:\n  - \"action.goto_stage('查无此阶段')\"\n", /阶段「查无此阶段」/, '阶段'],
    ['scripts.yml', "start:\n  - \"action.trigger_interact('查无此点')\"\n", /交互点「查无此点」/, '交互点'],
    ['scripts.yml', "start:\n  - \"action.create_obstacle('查无此门')\"\n", /障碍物「查无此门」/, '障碍物'],
    ['scripts.yml', "start:\n  - \"dungeon.isObstacleClosed('查无此门')\"\n", /障碍物「查无此门」/, '障碍物'],
    ['monsters.yml', '怪物组:\n  wave_1:\n    区域: 查无此区\n', /区域「查无此区」/, 'YAML 的 区域:'],
    ['monsters.yml', 'groups:\n  wave_1:\n    zone: 查无此区\n', /区域「查无此区」/, 'YAML 的 zone:'],
  ];
  for (const [file, text, re, what] of bad) {
    const uri = openDoc(file, text, REF_DIR);
    const diags = await client.waitFor(() => {
      const d = client.diagnosticsFor(uri);
      return d.some((x) => x.code === 'unknown-reference') ? d : undefined;
    });
    const hit = (diags ?? []).some((x) => re.test(x.message));
    check(`${what} 写错时报 unknown-reference`, hit, JSON.stringify(diags ?? []).slice(0, 300));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }

  // 反向：名字写对时一条引用错误都不能有（误报比漏报更烦人）
  const good = [
    ['scripts.yml', "start:\n  - \"action.enable_zone('战斗区')\"\n"],
    ['scripts.yml', "start:\n  - \"action.create_obstacle('Boss门')\"\n"],
    ['scripts.yml', "start:\n  - \"action.teleport_point('@all','战斗区.中心')\"\n"],
    ['monsters.yml', '怪物组:\n  wave_1:\n    区域: 战斗区\n',],
    ['obstacles.yml', '障碍物:\n  Boss门:\n    区域: 战斗区\n'],
  ];
  for (const [file, text] of good) {
    const uri = openDoc(file, text, REF_DIR);
    await new Promise((r) => setTimeout(r, 350));
    const refs = client.diagnosticsFor(uri).filter((d) => d.code === 'unknown-reference');
    check(`${file} 里写对的名字没有引用误报`, refs.length === 0, JSON.stringify(refs).slice(0, 300));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }

  // 属性键不能被当成名字引用（区域名称/默认开启/范围 的值不是名字）
  const props = openDoc('zones.yml', "区域:\n  战斗区:\n    区域名称: '&e前厅战斗区'\n    范围: '0,60,0 ~ 20,80,20'\n    默认开启: true\n", REF_DIR);
  await new Promise((r) => setTimeout(r, 350));
  const propRefs = client.diagnosticsFor(props).filter((d) => d.code === 'unknown-reference');
  check('zones.yml 的 区域名称/范围/默认开启 不产生引用误报', propRefs.length === 0, JSON.stringify(propRefs).slice(0, 300));
  closeDoc(props);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 23：钩子名 —— 中文键也必须报（写了不会执行） ----------
{
  const cases = [
    ['start:', true, '英文合法钩子'],
    ['nosuchhook:', false, '英文非法钩子'],
    ['开始:', false, '中文非法钩子'],
    ['通关:', false, '中文非法钩子'],
  ];
  for (const [key, ok, what] of cases) {
    const text = `${key}\n  - "action.message('@all','x')"\n`;
    const uri = openDoc('scripts.yml', text);
    await new Promise((r) => setTimeout(r, 350));
    const got = client.diagnosticsFor(uri).filter((d) => d.code === 'unknown-hook');
    check(`${what}「${key}」${ok ? '不报' : '报 unknown-hook'}`, ok ? got.length === 0 : got.length > 0, JSON.stringify(got).slice(0, 250));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ---------- 用例 24：引用数据自身的契约（挡住这次那类笔误） ----------
// containerAliases 的键必须是引用类型（RefKind），不是容器名 —— 写反了不会报错，
// 只会让那一类名字静默地全部收不到。这里直接对数据文件断言，别等表现异常才发现。
{
  const cfg = JSON.parse(readFileSync('data/config-files.json', 'utf8'));
  const KINDS = ['groups', 'zones', 'obstacles', 'interacts', 'stages', 'tasks', 'rewards'];
  const DEFINING = {
    groups: 'monsters.yml',
    zones: 'zones.yml',
    obstacles: 'obstacles.yml',
    interacts: 'interacts.yml',
    stages: 'stages.yml',
    tasks: 'tasks.yml',
    rewards: 'rewards.yml',
  };
  for (const kind of KINDS) {
    const f = cfg.files.find((x) => x.file === DEFINING[kind]);
    const aliases = f?.containerAliases?.[kind];
    check(`data/config-files.json 里 ${DEFINING[kind]} 的 containerAliases 以「${kind}」为键`,
      Array.isArray(aliases) && aliases.length > 0, JSON.stringify(f?.containerAliases ?? null));
  }
}

// ---------- 用例 25：区域写在根节点时也要能补全与校验 ----------
// 插件允许 zones.yml 不写 `区域:` 外层（示例文件顶部就是这么说的）。
{
  const text = "start:\n  - \"action.enable_zone('')\"\n";
  const uri = openDoc('scripts.yml', text, REF_FLAT_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const got = labels(await completions(uri, 1, text.split('\n')[1].indexOf(`'`) + 1));
  check('根节点写法：enable_zone 补全列出「前厅」', got.includes('前厅'), got.join(','));
  closeDoc(uri);
  await new Promise((r) => setTimeout(r, 100));

  // 点位：走 YAML 值位置（collectPoints 的根节点兜底分支）
  const ptText = '怪物组:\n  wave_1:\n    点位: \n';
  const pt = openDoc('monsters.yml', ptText, REF_FLAT_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const gotPt = labels(await completions(pt, 2, '    点位: '.length));
  check('根节点写法：点位补全列出「前厅.落点」', gotPt.includes('前厅.落点'), gotPt.join(','));
  closeDoc(pt);
  await new Promise((r) => setTimeout(r, 100));

  const bad = openDoc('scripts.yml', "start:\n  - \"action.enable_zone('查无此区')\"\n", REF_FLAT_DIR);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(bad);
    return d.some((x) => x.code === 'unknown-reference') ? d : undefined;
  });
  check('根节点写法：写错的区域名也报出来', Boolean(diags?.some((x) => /区域「查无此区」/.test(x.message))), JSON.stringify(diags ?? []).slice(0, 250));
  closeDoc(bad);
  await new Promise((r) => setTimeout(r, 100));
}

// ---------- 用例 26：跳转 / 查引用 / 重命名 也要认识新加的名字类别 ----------
// 这一段是补全之外的「另一半」：symbolAt 里硬编码过一份 kind 清单，新增 obstacles 时
// 漏掉，表现很割裂 —— 同一行里障碍物名能补全出来，点它却跳不过去、F2 也改不了。
{
  const cases = [
    ['action.create_obstacle(\'Boss门\')', 'Boss门', 'obstacles.yml', '障碍物'],
    ['action.enable_zone(\'战斗区\')', '战斗区', 'zones.yml', '区域'],
    ['action.trigger_interact(\'能量核心\')', '能量核心', 'interacts.yml', '交互点'],
    ['action.goto_stage(\'第一阶段\')', '第一阶段', 'stages.yml', '阶段'],
  ];
  for (const [call, name, defFile, what] of cases) {
    const text = `start:\n  - "${call}"\n`;
    const uri = openDoc('scripts.yml', text, REF_DIR);
    await new Promise((r) => setTimeout(r, 200));
    const at = posOf(text, name);

    const defs = await request('textDocument/definition', { textDocument: { uri }, position: at });
    check(`${what}「${name}」能跳到 ${defFile}`,
      (defs ?? []).length === 1 && (defs ?? [])[0].uri.endsWith(defFile),
      JSON.stringify(defs ?? []).slice(0, 200));

    const refs = await request('textDocument/references', {
      textDocument: { uri }, position: at, context: { includeDeclaration: true },
    });
    const files = new Set((refs ?? []).map((r) => r.uri.split('/').pop()));
    check(`${what}「${name}」的引用同时含定义文件与 scripts.yml`,
      files.has(defFile) && files.has('scripts.yml'), [...files].join(','));

    const prepared = await request('textDocument/prepareRename', { textDocument: { uri }, position: at });
    check(`${what}「${name}」可重命名`, Boolean(prepared?.range), JSON.stringify(prepared ?? {}));

    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ---------- 用例 27：外层键写别名/英文写法时，整棵子树照样能补全与悬停 ----------
// 插件对每个容器都有多种写法（障碍物/obstacles、怪物组/groups、区域/zones…），
// 编辑器若按字面量比路径，用别名写的文件会**整棵子树**匹配不上：子键补全空白、
// 悬停没有、值枚举也不出来。实测就是这么坏的（obstacles.yml 写成 `obstacles:` 时
// 障碍物里 7 个键一个都补不出来）。
{
  const zonesKids = openDoc('zones.yml', 'zones:\n  安全区:\n    \n', REF_ALIAS_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const zk = labels(await completions(zonesKids, 2, 4));
  check('zones: 写法下子键补全给出「范围」', zk.includes('范围'), zk.join(','));
  closeDoc(zonesKids);
  await new Promise((r) => setTimeout(r, 80));

  const obsKids = openDoc('obstacles.yml', 'obstacles:\n  门:\n    \n', REF_ALIAS_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const ok = labels(await completions(obsKids, 2, 4));
  check('obstacles: 写法下子键补全给出「开启时」', ok.includes('开启时'), ok.join(','));
  check('obstacles: 写法下子键补全给出「材质」', ok.includes('材质'), ok.join(','));
  closeDoc(obsKids);
  await new Promise((r) => setTimeout(r, 80));

  const monKids = openDoc('monsters.yml', '怪物组:\n  wave_1:\n    \n', REF_ALIAS_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const mk = labels(await completions(monKids, 2, 4));
  check('怪物组: 写法（中文别名）下子键补全给出「spawn_timing」', mk.includes('spawn_timing'), mk.join(','));
  closeDoc(monKids);
  await new Promise((r) => setTimeout(r, 80));

  // 悬停：容器键与子键都要有说明（原先根键查不到、子键显示的是上一级的说明）
  const hov = openDoc('obstacles.yml', REF_ALIAS_FILES['obstacles.yml'], REF_ALIAS_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const hRoot = await hover(hov, 0, 3);
  const hRootText = String(hRoot?.contents?.value ?? '');
  check('悬停 obstacles: 给出障碍物容器说明', /障碍物/.test(hRootText), hRootText.slice(0, 120));
  const hSub = await hover(hov, 3, 4);
  const hSubText = String(hSub?.contents?.value ?? '');
  check('悬停 材质: 给出材质说明', /材质/.test(hSubText), hSubText.slice(0, 120));
  closeDoc(hov);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 28：列表项里的键（插件示例与真实副本都这么写） ----------
// `monsters:` 下面 `- id: Zombie` 这种「`- ` 与键同缩进」的写法是主路径。原先
// 列表项内联的键会被当成同一项后续行的父级，`location:` 那几行的父路径变成
// `怪物组.wave_1.id` —— 补全给出的是怪物组一级的键，诊断还会把它们判成「插件不读的键」。
{
  // 两种列表写法都要测：插件自己的示例与线上真实副本用的是后者（`- ` 与键同缩进），
  // 前者（缩进一级）当时却是自检里唯一覆盖到的，于是「宿主键被误弹」那类改动测不出来。
  const styles = [
    ['缩进一级', '怪物组:\n  wave_1:\n    monsters:\n      - id: Zombie\n        \n', 4, 8],
    ['与键同缩进', '怪物组:\n  wave_1:\n    monsters:\n    - id: Zombie\n      \n', 4, 6],
  ];
  for (const [what, text, line, col] of styles) {
    const uri = openDoc('monsters.yml', text, REF_DIR);
    await new Promise((r) => setTimeout(r, 200));
    const got = labels(await completions(uri, line, col));
    check(`列表项（${what}）第二行补全给出「location」`, got.includes('location'), got.join(','));
    check(`列表项（${what}）第二行补全给出「point」`, got.includes('point'), got.join(','));
    check(`列表项（${what}）不再给出怪物组一级的键`, !got.includes('刷新时机') && !got.includes('on_start'), got.join(','));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ---------- 用例 29：插件根本不读的键要报出来（写错只会被静默忽略） ----------
// 插件的解析器一律「按名字取键，取不到用默认值」，键名写错既不报错也不生效。
// 实测：障碍物里写 `开启时候:`（只认 开启时/on_delete/删除时），那行声音一次都不放。
{
  const bad = openDoc('obstacles.yml', '障碍物:\n  门:\n    区域: 战斗区\n    开启时候: |-\n      action.sound(\'@all\', \'BLOCK_IRON_DOOR_CLOSE\')\n', REF_DIR);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(bad);
    return d.some((x) => x.code === 'unknown-key') ? d : undefined;
  });
  const hit = (diags ?? []).find((x) => x.code === 'unknown-key');
  check('「开启时候」被报成 unknown-key', Boolean(hit), JSON.stringify(diags ?? []).slice(0, 300));
  check('unknown-key 会给出最接近的键「开启时」', /开启时/.test(hit?.message ?? ''), hit?.message ?? '');
  closeDoc(bad);
  await new Promise((r) => setTimeout(r, 80));

  // 正对照：正确的键不能报
  const good = openDoc('obstacles.yml', '障碍物:\n  门:\n    区域: 战斗区\n    开启时: |-\n      action.sound(\'@all\', \'BLOCK_IRON_DOOR_CLOSE\')\n', REF_DIR);
  await new Promise((r) => setTimeout(r, 350));
  const goodKeys = client.diagnosticsFor(good).filter((d) => d.code === 'unknown-key');
  check('写对的「开启时」不报 unknown-key', goodKeys.length === 0, JSON.stringify(goodKeys).slice(0, 250));
  closeDoc(good);
  await new Promise((r) => setTimeout(r, 80));

  // 误报压力测试：动态命名的层级（名字随便写的地方）一个都不能报
  const guards = [
    ['monsters.yml', '怪物组:\n  我随便起的组名:\n    刷新时机:\n      type: AUTO_START\n', '怪物组名'],
    ['config.yml', 'dungeon:\n  name: x\nworld:\n  template: voidgen\n  world_rules:\n    任意游戏规则: false\n', 'world_rules 的规则名'],
    ['rewards.yml', '奖励:\n  我随便起的奖励:\n    经验: 10\n', '奖励名'],
    ['tasks.yml', 'tasks:\n  我随便起的任务:\n    type: 定时\n    times:\n      300: |-\n        action.message(\'@all\', \'x\');\n', '任务名与时间点'],
  ];
  for (const [file, text, what] of guards) {
    const uri = openDoc(file, text, REF_DIR);
    await new Promise((r) => setTimeout(r, 350));
    const got = client.diagnosticsFor(uri).filter((d) => d.code === 'unknown-key');
    check(`动态命名的层级（${what}）不报 unknown-key`, got.length === 0, JSON.stringify(got).slice(0, 300));
    closeDoc(uri);
    await new Promise((r) => setTimeout(r, 80));
  }
}

// ---------- 用例 30：chest_rewards.yml（宝箱奖励 UI） ----------
// 这个文件扩展一直没收录，等于「文件被同步进语言服务、却一个字都补不出来」。
{
  const text = 'chests:\n  通关宝箱:\n    \n';
  const uri = openDoc('chest_rewards.yml', text, REF_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const got = labels(await completions(uri, 2, 4));
  check('宝箱层补全给出「options」', got.includes('options'), got.join(','));
  check('宝箱层补全给出「rows」', got.includes('rows'), got.join(','));
  closeDoc(uri);
  await new Promise((r) => setTimeout(r, 80));

  const item = openDoc('chest_rewards.yml', 'chests:\n  通关宝箱:\n    options:\n      - slot: 0\n        \n', REF_DIR);
  await new Promise((r) => setTimeout(r, 200));
  const itemKeys = labels(await completions(item, 4, 8));
  check('选项里补全给出「icon」与「reward」', itemKeys.includes('icon') && itemKeys.includes('reward'), itemKeys.join(','));
  closeDoc(item);
  await new Promise((r) => setTimeout(r, 80));

  // 选项的 reward 是 rewards.yml 的名字（值位置补全 + 引用校验）
  const val = openDoc('chest_rewards.yml', 'chests:\n  通关宝箱:\n    options:\n      - reward: \n', REF_DIR);
  await new Promise((r) => setTimeout(r, 250));
  const gotVal = labels(await completions(val, 3, '      - reward: '.length));
  check('reward 的值补全列出 rewards.yml 里的「通关奖励」', gotVal.includes('通关奖励'), gotVal.join(','));
  closeDoc(val);
  await new Promise((r) => setTimeout(r, 80));

  const bad = openDoc('chest_rewards.yml', 'chests:\n  通关宝箱:\n    options:\n      - reward: 查无此奖\n', REF_DIR);
  const diags = await client.waitFor(() => {
    const d = client.diagnosticsFor(bad);
    return d.some((x) => x.code === 'unknown-reference') ? d : undefined;
  });
  check('宝箱奖励写错时报 unknown-reference', Boolean(diags?.some((x) => /奖励「查无此奖」/.test(x.message))), JSON.stringify(diags ?? []).slice(0, 300));
  closeDoc(bad);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 31：跟随插件新增的键（world.center / world.allow_build / 复活道具文案） ----------
// 数据的价值不只是"多一条补全"。插件加了键而扩展没跟时，真正的危害是**把合法的键
// 报成「插件不读的键」** —— 而按插件文档照抄的服主会以为是自己写错了，
// 顺手把那行删掉。world.allow_build 尤其典型：它默认 false = 禁止玩家拆地形，
// 被误报后删掉的是一道防护。world.center 同理（1.4.0 新增，不认它就会劝人删掉圆心）。
{
  // 1) 补全与文档：world 段下要能列出 center，且说清"圆心 + 不写等于出生点"
  const text = 'world:\n  cen\n';
  const uri = openDoc('config.yml', text);
  const items = await completions(uri, 1, '  cen'.length);
  const center = items.find((i) => i.label === 'center');
  check('world 段下能补出 center', Boolean(center), labelDump(items));
  const centerDoc = JSON.stringify(center?.documentation ?? {});
  check('center 的文档讲清它是世界边界的圆心', /圆心/.test(centerDoc), centerDoc.slice(0, 200));
  check('center 的文档说明不写 = 出生点', /出生点/.test(centerDoc), centerDoc.slice(0, 200));
  closeDoc(uri);
  await new Promise((r) => setTimeout(r, 80));

  // 2) 悬停键名（与补全同一份数据，单独盯一次：键名悬停曾经整体失效过）
  const hov = openDoc('config.yml', 'world:\n  center: \'-202,182\'\n');
  const h = await hover(hov, 1, 4);
  check('悬停 center 给出文档', /圆心|出生点/.test(JSON.stringify(h ?? {})), JSON.stringify(h ?? {}).slice(0, 200));
  closeDoc(hov);
  await new Promise((r) => setTimeout(r, 80));

  // 3) 正对照：插件 1.4.0 认的写法一个都不许报 unknown-key
  const goodText =
    "world:\n  template: voidgen\n  spawn: '-202,25,182,0,0'\n  border: 200\n"
    + "  center: '-202,182'\n  allow_build: false\n  world_rules:\n    center: '-202,182'\n";
  const good = openDoc('config.yml', goodText);
  await new Promise((r) => setTimeout(r, 300));
  const goodKeys = client.diagnosticsFor(good).filter((d) => d.code === 'unknown-key');
  check('center / allow_build / world_rules.center 都不报 unknown-key', goodKeys.length === 0, JSON.stringify(goodKeys).slice(0, 300));
  closeDoc(good);
  await new Promise((r) => setTimeout(r, 80));

  // 4) 中文别名同样不许报（插件的中文键名是正经支持的写法）
  const cnText = "world:\n  模板: voidgen\n  世界中心: '-202,182'\n  允许破坏: true\n";
  const cn = openDoc('config.yml', cnText);
  await new Promise((r) => setTimeout(r, 300));
  const cnKeys = client.diagnosticsFor(cn).filter((d) => d.code === 'unknown-key');
  check('中文别名（世界中心 / 允许破坏）不报 unknown-key', cnKeys.length === 0, JSON.stringify(cnKeys).slice(0, 300));
  closeDoc(cn);
  await new Promise((r) => setTimeout(r, 80));

  // 5) 反向对照：真写错还是要报 —— 否则上面两条可能只是"这一层不查"
  const typo = openDoc('config.yml', "world:\n  centr: '1,2'\n");
  const typoDiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(typo);
    return d.some((x) => x.code === 'unknown-key') ? d : undefined;
  });
  const typoHit = (typoDiags ?? []).find((x) => x.code === 'unknown-key');
  check('把 center 写成 centr 报 unknown-key', Boolean(typoHit), JSON.stringify(typoDiags ?? []).slice(0, 300));
  check('unknown-key 提示里给出最接近的键 center', /\bcenter\b/.test(typoHit?.message ?? ''), typoHit?.message ?? '');
  closeDoc(typo);
  await new Promise((r) => setTimeout(r, 80));

  // 6) 复活道具的两个新键（display-name / consume-message）
  const itemText =
    "revive:\n  count: 3\n  item:\n    id: TOTEM_OF_UNDYING\n"
    + "    显示名: '&d复活图腾'\n    消耗提示: '用掉了 {item}'\n";
  const item = openDoc('config.yml', itemText);
  await new Promise((r) => setTimeout(r, 300));
  const itemKeys = client.diagnosticsFor(item).filter((d) => d.code === 'unknown-key');
  check('revive.item 的 显示名 / 消耗提示 不报 unknown-key', itemKeys.length === 0, JSON.stringify(itemKeys).slice(0, 300));
  closeDoc(item);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 32：跟随插件新增的顶层键 priority（列表排序优先级） ----------
// 与用例 31 同一个道理，但这一条更值得单独盯：priority 是**顶层**键，
// 而顶层是所有 YAML 文件里最容易被"整体失效"的一层（用例 16g 就是顶层键补全
// 曾经全挂的回归）。插件 1.4.4 新增它之后，不认它的后果是报告诉服主
// "插件不读这个键" —— 而照文档配了 priority 的服主会把它删掉，
// 于是"我把主推副本排到第一个"这件事静默失效，且没有任何别的迹象。
// 另外它的别名是纯中文（优先级 / 排序），中文键名的通路也要走一遍。
{
  // 1) 补全：顶层输入 pri 要能补出 priority
  const uri = openDoc('config.yml', 'pri\n');
  const items = await completions(uri, 0, 3);
  const prio = items.find((i) => i.label === 'priority');
  check('config.yml 顶层能补出 priority', Boolean(prio), labelDump(items));
  const doc = JSON.stringify(prio?.documentation ?? {});
  // 文档必须说清方向与默认值 —— 这两点是这个键唯一的"用法"，
  // 只说"排序优先级"等于没说（"越小越靠前"猜错的人一定会有）
  check('priority 的文档说清数字越小越靠前', /越小越靠前/.test(doc), doc.slice(0, 200));
  check('priority 的文档给出默认值 10', /默认\s*10|=\s*10/.test(doc), doc.slice(0, 200));
  closeDoc(uri);
  await new Promise((r) => setTimeout(r, 80));

  // 2) 悬停键名
  const hov = openDoc('config.yml', 'priority: 1\n');
  const h = await hover(hov, 0, 3);
  check('悬停 priority 给出文档', /靠前|优先级/.test(JSON.stringify(h ?? {})), JSON.stringify(h ?? {}).slice(0, 200));
  closeDoc(hov);
  await new Promise((r) => setTimeout(r, 80));

  // 3) 正对照：英/中两种写法 + 与 enable/hide 同层，都不许报 unknown-key
  const goodText = "enable: true\nhide: false\npriority: 1\n";
  const good = openDoc('config.yml', goodText);
  await new Promise((r) => setTimeout(r, 300));
  const goodKeys = client.diagnosticsFor(good).filter((d) => d.code === 'unknown-key');
  check('priority / 优先级 / 排序 都不报 unknown-key', goodKeys.length === 0, JSON.stringify(goodKeys).slice(0, 300));
  closeDoc(good);
  await new Promise((r) => setTimeout(r, 80));

  const cnText = "启用: true\n隐藏: false\n优先级: 1\n排序: 2\n";
  const cn = openDoc('config.yml', cnText);
  await new Promise((r) => setTimeout(r, 300));
  const cnKeys = client.diagnosticsFor(cn).filter((d) => d.code === 'unknown-key');
  check('中文别名（优先级 / 排序）不报 unknown-key', cnKeys.length === 0, JSON.stringify(cnKeys).slice(0, 300));
  closeDoc(cn);
  await new Promise((r) => setTimeout(r, 80));

  // 4) 反向对照：拼错还是要报，且要给出最接近的键
  const typo = openDoc('config.yml', 'priorty: 1\n');
  const typoDiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(typo);
    return d.some((x) => x.code === 'unknown-key') ? d : undefined;
  });
  const typoHit = (typoDiags ?? []).find((x) => x.code === 'unknown-key');
  check('把 priority 写成 priorty 报 unknown-key', Boolean(typoHit), JSON.stringify(typoDiags ?? []).slice(0, 300));
  check('unknown-key 提示里给出最接近的键 priority', /\bpriority\b/.test(typoHit?.message ?? ''), typoHit?.message ?? '');
  closeDoc(typo);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 33：条目直接写在根上时，别把它报成「插件不读的键」 ----------
// 真实反馈：游戏内编辑器保存出来的 zones.yml 是**根级**写法（`spawn:` 直接在最外层），
// 而扩展把它报成「插件不读「spawn」这个键（zones.yml 这一层只有 区域）」。
// 插件解析器其实是「先找容器节，找不到就把根下每个键当条目」（DungeonRegistry.parseZones），
// 所以根级写法合法、编辑器写它也是对的 —— 错的是扩展的数据模型（只认容器写法）。
// 这一组钉三件事：不误报、子键能补全悬停、容器拼错时**仍然**要报。
{
  const FLAT_DIR = join(mkdtempSync(join(tmpdir(), 'ld-rootzone-')), 'dungeons', 'rootzone');
  mkdirSync(FLAT_DIR, { recursive: true });
  writeFileSync(join(FLAT_DIR, 'config.yml'),
    "dungeon:\n  name: '&e根级区域用'\nworld:\n  template: voidgen\n", 'utf8');
  // 与反馈里那份一模一样：区域名就叫 spawn
  const zoneText = "spawn:\n  名称: '&espawn'\n  范围: 2,49,-14 ~ 7,54,-7\n  默认开启: true\n";
  writeFileSync(join(FLAT_DIR, 'zones.yml'), zoneText, 'utf8');

  const uri = openDoc('zones.yml', zoneText, FLAT_DIR);
  await new Promise((r) => setTimeout(r, 300));
  const bad = client.diagnosticsFor(uri).filter((d) => d.code === 'unknown-key');
  check('根级区域（spawn / 名称 / 范围 / 默认开启）不报 unknown-key',
    bad.length === 0, JSON.stringify(bad).slice(0, 400));
  closeDoc(uri);
  await new Promise((r) => setTimeout(r, 80));

  // 根级区域里的子键要能补全（容器可省略 → 数据里少一段「区域」仍要匹配）
  const curi = openDoc('zones.yml', "spawn:\n  \n", FLAT_DIR);
  await new Promise((r) => setTimeout(r, 300));
  const kids = labels(await completions(curi, 1, 2));
  check('根级区域下补全列出「名称」', kids.includes('名称'), kids.join(','));
  check('根级区域下补全列出「范围」', kids.includes('范围'), kids.join(','));
  check('根级区域下补全列出「点位」', kids.includes('点位'), kids.join(','));
  closeDoc(curi);
  await new Promise((r) => setTimeout(r, 80));

  // 悬停也要认（数据里路径是 区域.<区域ID>.范围，实际写的是 spawn.范围）
  const huri = openDoc('zones.yml', zoneText, FLAT_DIR);
  const h = await hover(huri, 2, 3);
  check('悬停根级区域里的「范围」给出文档', /范围|长方体/.test(JSON.stringify(h ?? {})),
    JSON.stringify(h ?? {}).slice(0, 200));
  closeDoc(huri);
  await new Promise((r) => setTimeout(r, 80));

  // 反向对照：容器名写成 zone（漏了 s）仍然要报 —— 那是真错：
  // 插件会把 zone 当成一个区域名，而区域该有的 范围 并不在它下面
  const typoText = "zone:\n  前厅:\n    范围: '0,60,0 ~ 1,61,1'\n";
  writeFileSync(join(FLAT_DIR, 'zones.yml'), typoText, 'utf8');
  const turi = openDoc('zones.yml', typoText, FLAT_DIR);
  const tdiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(turi);
    return d.some((x) => x.code === 'unknown-key') ? d : undefined;
  });
  const thit = (tdiags ?? []).find((x) => x.code === 'unknown-key');
  check('容器名写成 zone 时，下一层的 前厅 仍报 unknown-key', Boolean(thit),
    JSON.stringify(tdiags ?? []).slice(0, 300));
  check('这条提示会列出这一层真正能写的键', /名称|范围/.test(thit?.message ?? ''), thit?.message ?? '');
  closeDoc(turi);
  await new Promise((r) => setTimeout(r, 80));

  // 另一头：**有容器时，写在根上的条目一律不生效**（解析器取到容器就再不看根）。
  // 这条同样是静默失败，写的人只会觉得"我这个区域怎么没反应"。
  const mixText = "区域:\n  前厅:\n    范围: '0,60,0 ~ 1,61,1'\n战斗区:\n  范围: '0,60,0 ~ 9,69,9'\n";
  const muri = openDoc('zones.yml', mixText, FLAT_DIR);
  const mdiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(muri).filter((x) => x.code === 'container-mixed');
    return d.length ? d : undefined;
  });
  const mhit = (mdiags ?? [])[0];
  check('根上那个区域被报成「有容器时不生效」', Boolean(mhit), JSON.stringify(client.diagnosticsFor(muri)).slice(0, 400));
  check('提示点名了根上那个键与容器名', /战斗区/.test(mhit?.message ?? '') && /区域/.test(mhit?.message ?? ''), mhit?.message ?? '');
  closeDoc(muri);
  await new Promise((r) => setTimeout(r, 80));

  // 正对照：只写根级（没有容器）时不报这条
  const onlyRoot = openDoc('zones.yml', "前厅:\n  范围: '0,60,0 ~ 1,61,1'\n", FLAT_DIR);
  await new Promise((r) => setTimeout(r, 300));
  const onlyRootMixed = client.diagnosticsFor(onlyRoot).filter((x) => x.code === 'container-mixed');
  check('没有容器时不报 container-mixed', onlyRootMixed.length === 0, JSON.stringify(onlyRootMixed).slice(0, 300));
  closeDoc(onlyRoot);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 32：world.allow_flight（副本内禁止飞行） ----------
// 同样是"插件加了键、扩展没跟就会把合法键报成不读的键"那一类：
// 这个键默认 false = 禁止飞行，被误报后服主把它删掉，副本里就能飞着绕过所有机关 ——
// 而表现只是"有人通关特别快"。反向键「禁止飞行」则要**反过来**报出来：
// 插件刻意不认它（同一个开关两种极性迟早猜错），写的人需要被提醒。
{
  // 1) 补全与文档：world 段下要能列出 allow_flight，且说清默认是禁止
  const text = 'world:\n  allow_f\n';
  const uri = openDoc('config.yml', text);
  const items = await completions(uri, 1, '  allow_f'.length);
  const flight = items.find((i) => i.label === 'allow_flight');
  check('world 段下能补出 allow_flight', Boolean(flight), labelDump(items));
  const flightDoc = JSON.stringify(flight?.documentation ?? {});
  check('allow_flight 的文档讲清默认是禁止', /禁止/.test(flightDoc), flightDoc.slice(0, 200));
  check('allow_flight 的文档提到双击/创造模式里的一种', /双击|创造/.test(flightDoc), flightDoc.slice(0, 200));
  closeDoc(uri);
  await new Promise((r) => setTimeout(r, 80));

  // 2) 悬停键名
  const hov = openDoc('config.yml', 'world:\n  allow_flight: false\n');
  const h = await hover(hov, 1, 4);
  check('悬停 allow_flight 给出文档', /飞行/.test(JSON.stringify(h ?? {})), JSON.stringify(h ?? {}).slice(0, 200));
  closeDoc(hov);
  await new Promise((r) => setTimeout(r, 80));

  // 3) 正对照：英文键与中文别名都不许报 unknown-key
  const good = openDoc('config.yml', "world:\n  template: voidgen\n  allow_flight: false\n");
  await new Promise((r) => setTimeout(r, 300));
  const goodKeys = client.diagnosticsFor(good).filter((d) => d.code === 'unknown-key');
  check('allow_flight 不报 unknown-key', goodKeys.length === 0, JSON.stringify(goodKeys).slice(0, 300));
  closeDoc(good);
  await new Promise((r) => setTimeout(r, 80));

  const cn = openDoc('config.yml', 'world:\n  允许飞行: true\n');
  await new Promise((r) => setTimeout(r, 300));
  const cnKeys = client.diagnosticsFor(cn).filter((d) => d.code === 'unknown-key');
  check('中文别名「允许飞行」不报 unknown-key', cnKeys.length === 0, JSON.stringify(cnKeys).slice(0, 300));
  closeDoc(cn);
  await new Promise((r) => setTimeout(r, 80));

  // 4) 负对照：反向键要被报出来（插件真的不读它）
  const bad = openDoc('config.yml', 'world:\n  禁止飞行: false\n');
  await new Promise((r) => setTimeout(r, 300));
  const badKeys = client.diagnosticsFor(bad).filter((d) => d.code === 'unknown-key');
  check('反向键「禁止飞行」被报成 unknown-key', badKeys.length > 0, JSON.stringify(client.diagnosticsFor(bad)).slice(0, 300));
  closeDoc(bad);
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 用例 33：hologram 的占位符（{player.x} 这一组） ----------
// 插件 1.5.3 起 hologram 的文本与位置参数都做占位符替换（"在玩家死亡地点挂字"就靠它）。
// 两件事都要盯住：① 合法占位符不能被报成"不会被替换"；② 写错的名字要给出建议。
// ① 查的是 data/action-methods.json 那份名单，② 查的是 code-actions.ts 里那份 ——
// 两份名单是分开维护的，只改一份就会出现"不报错但也修不了"的半吊子状态。
{
  // 1) 合法：hologram 行上的 {player.name} / {player.x} / {player.pos} 都不报
  const ok = openDoc('scripts.yml',
    'player_death: |-\n'
    + "  action.hologram('&c{player.name} 倒在这里', '{player.x},{player.y},{player.z}', 1.2, '60s', 1.0);\n"
    + "  action.hologram('&7精确坐标', '{player.pos}', 1.0, '30s', 1.0);\n");
  await new Promise((r) => setTimeout(r, 350));
  const okDiags = client.diagnosticsFor(ok).filter((d) => d.code === 'placeholder');
  check('hologram 行上的 {player.x}/{player.pos} 不报占位符问题', okDiags.length === 0, JSON.stringify(okDiags).slice(0, 300));
  closeDoc(ok);
  await new Promise((r) => setTimeout(r, 80));

  // 2) 写错：hologram 行的 {player.posx} 要报，并且建议里给 {player.pos}
  const bad = openDoc('scripts.yml',
    'player_death: |-\n'
    + "  action.hologram('&c{player.posx} 倒在这里', '{player.x},{player.y},{player.z}', 1.2, '60s');\n");
  const badDiags = await client.waitFor(() => {
    const d = client.diagnosticsFor(bad).filter((x) => x.code === 'placeholder');
    return d.length > 0 ? d : undefined;
  });
  check('hologram 行上的错占位符被报出来', Boolean(badDiags), JSON.stringify(client.diagnosticsFor(bad)).slice(0, 300));
  check('提示里点名了 {player.pos}', /\{player\.pos\}/.test(badDiags?.[0]?.message ?? ''), badDiags?.[0]?.message ?? '');
  // 快速修复的那份名单（code-actions.ts）与诊断那份是分开维护的，所以这里直接跑一次
  // codeAction：只改一份的话「不报错但也修不了」，光看诊断看不出来
  const fixes = await request('textDocument/codeAction', {
    textDocument: { uri: bad },
    range: badDiags?.[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: badDiags ?? [] },
  });
  // 按标题找（codeAction 返回里不一定带我们自己的 code 字段）
  const fix = (fixes ?? []).find((a) => (a.title ?? '').includes('{player.pos}'));
  check('给出「改成 {player.pos}」的快速修复', /\{player\.pos\}/.test(fix?.title ?? ''), JSON.stringify((fixes ?? []).map((a) => a.title)));
  check('修复内容就是 {player.pos}', fix?.edit?.changes?.[bad]?.[0]?.newText === '{player.pos}', JSON.stringify(fix ?? {}));
  closeDoc(bad);
  await new Promise((r) => setTimeout(r, 80));

  // 3) 悬停/补全数据里也要有这一组（否则用户根本不知道有它）
  const cfg = JSON.parse(readFileSync('data/action-methods.json', 'utf8'));
  const values = (cfg.placeholders ?? []).map((p) => p.value);
  for (const v of ['{player.x}', '{player.y}', '{player.z}', '{player.pos}']) {
    check(`data/action-methods.json 收录了 ${v}`, values.includes(v), values.join(','));
  }
}

// ---------- 用例 26：怪物组条件里的中文词 ----------
// 插件 1.6.0 起：condition 是「启动条件」，为假会挂起重试、条件成立即补刷；
// 而翻译表以外的中文词（怪物小于等于 5 里的「小于等于」在 JS 里是合法标识符）
// 会让条件**恒为 false 且不报错** —— 这正是编辑器该提前说出来的那类静默失败。
{
  // 1) 合法中文条件：一个诊断都不许有
  const ok = openDoc('monsters.yml',
    "groups:\n  wave_2:\n    spawn_timing:\n      type: MANUAL\n    condition:\n      - 存活怪物 <= 5\n      - 击杀数 >= 30 并且 运行时间 < 600\n");
  await new Promise((r) => setTimeout(r, 200));
  const okCn = client.diagnosticsFor(ok).filter((d) => String(d.code).startsWith('condition-'));
  check('合法中文条件不报诊断', okCn.length === 0, JSON.stringify(okCn).slice(0, 300));
  closeDoc(ok);

  // 2) 表以外的中文词 → 报出来，且把那个词本身圈住
  const bad = openDoc('monsters.yml',
    "groups:\n  wave_2:\n    condition:\n      - 怪物小于等于 5\n");
  const got = await client.waitFor(() => {
    const d = client.diagnosticsFor(bad).filter((x) => x.code === 'condition-unknown-chinese');
    return d.length ? d : undefined;
  });
  const msg = (got ?? []).map((x) => x.message).join(' | ');
  check('不认识的中文词被报出来', Boolean(got), msg.slice(0, 200));
  check('诊断里点名了那个词', /小于等于/.test(msg) || /怪物小于等于/.test(msg), msg.slice(0, 200));
  check('诊断解释了后果（恒为 false / 怪物不出来）', /恒为 false|永远不出来/.test(msg), msg.slice(0, 200));
  check('诊断区间正好盖住那个词',
    (got ?? []).some((x) => x.range.end.character - x.range.start.character >= 2),
    JSON.stringify((got ?? []).map((x) => x.range)));
  closeDoc(bad);

  // 3) 全角运算符 → 更硬的一档（整条语法错误）
  const wide = openDoc('monsters.yml',
    "groups:\n  wave_2:\n    condition:\n      - 存活怪物 ≤ 5\n");
  const wd = await client.waitFor(() => {
    const d = client.diagnosticsFor(wide).filter((x) => x.code === 'condition-fullwidth');
    return d.length ? d : undefined;
  });
  check('全角 ≤ 被报出来（只认 ASCII <=）', Boolean(wd),
    JSON.stringify(client.diagnosticsFor(wide)).slice(0, 200));
  check('全角诊断给出正确写法 <=', /<=/.test((wd ?? []).map((x) => x.message).join(' ')),
    (wd ?? []).map((x) => x.message).join(' ').slice(0, 200));
  closeDoc(wide);

  // 4) 字符串字面量里的中文不算错（组名本来就是中文）
  const quoted = openDoc('monsters.yml',
    "groups:\n  wave_2:\n    condition:\n      - dungeon.getAliveMonsterCount('第一波') <= 0\n");
  await new Promise((r) => setTimeout(r, 250));
  const qCn = client.diagnosticsFor(quoted).filter((d) => String(d.code).startsWith('condition-'));
  check('条件里引号内的中文组名不算未识别词', qCn.length === 0, JSON.stringify(qCn).slice(0, 300));
  closeDoc(quoted);

  // 5) 悬停中文关键词给出替换目标
  const hov = openDoc('monsters.yml',
    "groups:\n  wave_2:\n    condition:\n      - 存活怪物 <= 5\n");
  const h = await hover(hov, 3, '      - 存活怪物'.length - 1);
  const value = h?.contents?.value ?? '';
  check('悬停中文关键词写出替换成的 JS', /getTotalAliveMonsters/.test(value), value.slice(0, 160));
  check('悬停里说明「为假会挂起重试」', /挂起|重试/.test(value), value.slice(0, 200));
  closeDoc(hov);

  // 6) 内置示例配置与真实副本配置不许被误报（真配置里 100 个波次全写这一条）
  const exampleUri = `file://${DUNGEON_ROOT}/monsters.yml`;
  client.notify('textDocument/didOpen', {
    textDocument: { uri: exampleUri, languageId: 'yaml', version: 1, text: readFileSync(join(DUNGEON_ROOT, 'monsters.yml'), 'utf8') },
  });
  openUris.push(exampleUri);
  await new Promise((r) => setTimeout(r, 250));
  const exCn = client.diagnosticsFor(exampleUri).filter((d) => String(d.code).startsWith('condition-'));
  check('插件自带示例的 condition 不误报', exCn.length === 0, JSON.stringify(exCn).slice(0, 300));
  closeDoc(exampleUri);
}

// ---------- 用例 34：插件主配置（另一个同名 config.yml） ----------
// `plugins/liudungeon/config.yml` 与副本目录里的 config.yml 同名，但键名毫无交集：
// 前者是 debug / server-id / database / cross-server / statistics，后者是 enable / world /
// requirements。编辑器按 basename 认文件，所以这里必须靠**路径与目录内容**区分，
// 判错的代价前面写过：主配置会被套上副本的键名表，并报出 22 条「插件不读的键」假警告。
{
  const mainUri = `file://${MAIN_CFG_DIR}/config.yml`;

  // 1) 真文件一条诊断都不许有（这一条就是当初那 22 条假警告的反向断言）
  client.notify('textDocument/didOpen', {
    textDocument: { uri: mainUri, languageId: 'yaml', version: 1, text: MAIN_CFG_FILES['config.yml'] },
  });
  openUris.push(mainUri);
  await new Promise((r) => setTimeout(r, 400));
  const mainDiags = client.diagnosticsFor(mainUri);
  check('插件主配置的键一条都不报（含 server-id / cross-server / statistics）',
    mainDiags.length === 0, JSON.stringify(mainDiags).slice(0, 400));
  check('主配置里没有「插件不读的键」误报',
    !mainDiags.some((d) => d.code === 'unknown-key'),
    JSON.stringify(mainDiags.filter((d) => d.code === 'unknown-key')).slice(0, 300));

  // 2) 顶层键补全给的是**主配置**的键，不是副本的键
  const top = labels(await completions(mainUri, 0, 0));
  for (const k of ['server-id', 'database', 'cross-server', 'statistics', 'leaderboard', 'party']) {
    check(`主配置顶层补全含「${k}」`, top.includes(k), top.join(','));
  }
  for (const k of ['enable', 'hide', 'priority', 'requirements', 'blacklist', 'revive', 'sweep', 'instance']) {
    check(`主配置顶层补全不含副本的「${k}」`, !top.includes(k), top.join(','));
  }

  // 3) 子层补全：cross-server.redis 与直连地址段
  const redisUri = openDoc('config.yml', 'cross-server:\n  redis:\n    \n', MAIN_CFG_DIR);
  await new Promise((r) => setTimeout(r, 250));
  const redisKeys = labels(await completions(redisUri, 2, 4));
  for (const k of ['host', 'port', 'password', 'database', 'pool-size', 'timeout-ms', 'channel']) {
    check(`cross-server.redis 补全含「${k}」`, redisKeys.includes(k), redisKeys.join(','));
  }
  closeDoc(redisUri);
  await new Promise((r) => setTimeout(r, 80));

  // 直连地址段（config.yml 里整段是注释，插件仍然读它）
  const srvUri = openDoc('config.yml', 'cross-server:\n  servers:\n    zy:\n      \n', MAIN_CFG_DIR);
  await new Promise((r) => setTimeout(r, 250));
  const srvKeys = labels(await completions(srvUri, 3, 6));
  check('cross-server.servers.<服名> 补全含 host', srvKeys.includes('host'), srvKeys.join(','));
  check('cross-server.servers.<服名> 补全含 port', srvKeys.includes('port'), srvKeys.join(','));
  closeDoc(srvUri);
  await new Promise((r) => setTimeout(r, 80));

  // 4) 枚举取值（插件用 valueOf 解析，写错是静默回落）
  const typeUri = openDoc('config.yml', 'database:\n  type: \n', MAIN_CFG_DIR);
  await new Promise((r) => setTimeout(r, 250));
  const typeVals = labels(await completions(typeUri, 1, 8));
  for (const v of ['SQLITE', 'MYSQL', 'YAML']) {
    check(`database.type 取值补全含「${v}」`, typeVals.includes(v), typeVals.join(','));
  }
  closeDoc(typeUri);
  await new Promise((r) => setTimeout(r, 80));

  // 5) 键名写错要报，并给出正确写法（这是主配置最值钱的一条：写错静默取默认值）
  const typoUri = openDoc('config.yml', 'statistic:\n  enabled: true\n', MAIN_CFG_DIR);
  const typo = await client.waitFor(() => {
    const d = client.diagnosticsFor(typoUri).filter((x) => x.code === 'unknown-key');
    return d.length ? d : undefined;
  });
  check('主配置里写错 statistic 会报 unknown-key', Boolean(typo), JSON.stringify(client.diagnosticsFor(typoUri)).slice(0, 300));
  check('报错里建议改成 statistics', /statistics/.test(typo?.[0]?.message ?? ''), typo?.[0]?.message ?? '');
  check('报错里点名的是「插件主配置」而不是文件名', /插件主配置/.test(typo?.[0]?.message ?? ''), typo?.[0]?.message ?? '');
  closeDoc(typoUri);
  await new Promise((r) => setTimeout(r, 80));

  // 6) 悬停：标题写「插件主配置」，正文是作者写在 config.yml 里的说明
  const hovUri = openDoc('config.yml', "server-id: 'lob'\n", MAIN_CFG_DIR);
  await new Promise((r) => setTimeout(r, 250));
  const hv = await hover(hovUri, 0, 4);
  const hvText = hv?.contents?.value ?? '';
  check('server-id 悬停标题是「插件主配置」', /插件主配置/.test(hvText), hvText.slice(0, 120));
  check('server-id 悬停说明它与代理登记名的关系', /代理/.test(hvText), hvText.slice(0, 200));
  closeDoc(hovUri);
  await new Promise((r) => setTimeout(r, 80));

  // 7) 反向：副本目录里的 config.yml 仍然按副本配置处理（别改坏主路径）
  const dgUri = openDoc('config.yml', 'nosuchkey: true\n', REF_DIR);
  await new Promise((r) => setTimeout(r, 300));
  const dgKeys = labels(await completions(dgUri, 0, 0));
  check('副本 config.yml 顶层补全仍是副本的键（含 enable）', dgKeys.includes('enable'), dgKeys.join(','));
  check('副本 config.yml 顶层补全不含主配置的键（cross-server）', !dgKeys.includes('cross-server'), dgKeys.join(','));
  const dgDiag = await client.waitFor(() => {
    const d = client.diagnosticsFor(dgUri).filter((x) => x.code === 'unknown-key');
    return d.length ? d : undefined;
  });
  check('副本 config.yml 写无关键仍按副本键名报出来（说明没被当成主配置）',
    Boolean(dgDiag), JSON.stringify(client.diagnosticsFor(dgUri)).slice(0, 300));
  closeDoc(dgUri);
  await new Promise((r) => setTimeout(r, 80));

  // 8) 源码资源目录那份（目录名叫 resources，只有 plugin.yml 能说明它不是副本目录）
  const srcUri = `file://${MAIN_SRC_DIR}/config.yml`;
  client.notify('textDocument/didOpen', {
    textDocument: { uri: srcUri, languageId: 'yaml', version: 1, text: MAIN_CFG_FILES['config.yml'] },
  });
  openUris.push(srcUri);
  await new Promise((r) => setTimeout(r, 400));
  const srcDiags = client.diagnosticsFor(srcUri);
  check('插件源码里的 src/main/resources/config.yml 也按主配置处理（靠同目录的 plugin.yml）',
    srcDiags.length === 0, JSON.stringify(srcDiags).slice(0, 400));
  const srcTop = labels(await completions(srcUri, 0, 0));
  check('源码资源目录的主配置顶层补全含 server-id', srcTop.includes('server-id'), srcTop.join(','));
  check('源码资源目录的主配置顶层补全不含副本的 enable', !srcTop.includes('enable'), srcTop.join(','));
  closeDoc(srcUri);

  closeDoc(mainUri);
}

// ---------- 收尾 ----------
client.notify('exit', {});
child.kill();
await new Promise((r) => setTimeout(r, 100));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.detail ?? ''}`);
  process.exit(1);
}
