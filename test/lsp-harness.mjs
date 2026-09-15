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
