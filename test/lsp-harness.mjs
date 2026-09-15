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
import { readFileSync, readdirSync } from 'node:fs';
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

/** 打开一个虚拟文档（内容可覆盖），返回 uri。 */
const openUris = [];

function openDoc(name, text) {
  const uri = `file://${DUNGEON_ROOT}/${name}`;
  if (!openUris.includes(uri)) openUris.push(uri);
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: name.endsWith('.js') ? 'javascript' : 'yaml', version: 1, text },
  });
  return uri;
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
  if (!res.result) return [];
  return Array.isArray(res.result) ? res.result : (res.result.items ?? []);
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
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
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

// ---------- 用例 17：真实示例配置没有误报 ----------
{
  for (const uri of openUris) closeDoc(uri);
  openUris.length = 0;
  await new Promise((r) => setTimeout(r, 150));
  for (const n of ['config.yml', 'monsters.yml', 'scripts.yml', 'rewards.yml', 'zones.yml', 'interacts.yml', 'tasks.yml', 'stages.yml']) {
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

// ---------- 用例 18：数据完整性（补全数据与插件源码对齐） ----------
{
  const action = JSON.parse(readFileSync('data/action-methods.json', 'utf8'));
  const dungeon = JSON.parse(readFileSync('data/dungeon-methods.json', 'utf8'));
  const config = JSON.parse(readFileSync('data/config-files.json', 'utf8'));
  check('action API 方法数 >= 60', action.methods.length >= 60, `实际 ${action.methods.length}`);
  check('dungeon API 方法数 >= 45', dungeon.methods.length >= 45, `实际 ${dungeon.methods.length}`);
  check('配置文件覆盖 9 个文件', config.files.length === 9, `实际 ${config.files.length}`);
  check('配置节点数 >= 150', config.files.reduce((n, f) => n + f.nodes.length, 0) >= 150, '');
  check('生命周期钩子 7 个', config.scriptHooks.length === 7, `实际 ${config.scriptHooks.length}`);
  check('中文条件关键词 >= 14', config.conditions.keywords.length >= 14, `实际 ${config.conditions.keywords.length}`);

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
