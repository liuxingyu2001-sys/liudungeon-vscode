/**
 * 诊断：把「改完没反应、日志也不报错」这类坑尽量提前指出来。
 *
 * 覆盖范围（全部基于插件源码的真实行为，不是风格建议）：
 *   1. action.xxx / dungeon.xxx 方法不存在（调用会抛 TypeError 被引擎吞掉）
 *   2. 参数个数不对
 *   3. 玩家选择器写了没实现的 @party / @party_others
 *   4. 文本占位符写错（{player_name} 这类不会替换，原样显示）
 *   5. function 作用域里引用 undefined 的怪物组 / 区域 / 奖励 / 点位 / 交互点 / 阶段
 *   6. scripts.yml 里未知的钩子名（写了不会执行）
 *   7. complete / fail 钩子在当前版本不会执行
 *   8. 在有触发者的钩子里引用 __ 不存在的 __ player →
 *   9. 用了 dungeon.spawn（运行时读的是 world.spawn，写了等于没写）
 *  10. 同一文件里重复定义名字（YAML 后者覆盖前者）
 *  11. 引用了不存在的时间写法（3秒钟 这类会静默解析成 0）
 */
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { parseDocument, Scalar, YAMLMap } from 'yaml';
import {
  ACTION_METHODS,
  ACTION_OVERLOADS,
  CONFIG_DATA,
  DEAD_HOOKS,
  DUNGEON_METHODS,
  DUNGEON_OVERLOADS,
  HOOK_NAMES,
  PLACEHOLDERS,
  SELECTORS,
  type ApiMethod,
} from './api-model';
import { IndexStore, RefKind, REF_LABEL } from './index-store';
import { baseName, offsetToLine } from './yaml-shared';

export interface DiagnosticsOptions {
  unknownMethod: boolean;
  references: boolean;
  knownHooks: boolean;
}

export interface DiagnosticsInput {
  filePath: string;
  text: string;
  index: IndexStore;
  options: DiagnosticsOptions;
}

const SEVERITY_WARN = DiagnosticSeverity.Warning;
const SEVERITY_INFO = DiagnosticSeverity.Information;
const SEVERITY_ERROR = DiagnosticSeverity.Error;

/** 合法的选择器首字母；用于快速筛出「参数是选择器」的调用。 */
const SELECTOR_LIKE = /^['"]@/;

export function computeDiagnostics(input: DiagnosticsInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const name = baseName(input.filePath);
  const lines = input.text.split(/\r?\n/);
  const dir = input.index.dirForFile(input.filePath);
  const self = input.index.forFile(input.filePath);
  const isScriptsFile = name === 'scripts.yml';

  // ---------- 1~4、8、11：脚本片段级检查 ----------
  const scriptRanges = collectScriptRanges(name, lines);
  for (const r of scriptRanges) {
    out.push(...checkScriptRegion(input, r, dir, lines));
  }

  // ---------- 5：跨文件引用 ----------
  if (input.options.references && dir) {
    out.push(...checkReferences(input, dir, lines, self));
  }

  // ---------- 6、7：钩子名 ----------
  if (input.options.knownHooks && isScriptsFile) {
    out.push(...checkHooks(lines));
  }

  // ---------- 9：dungeon 段里的 spawn（写错位置，运行时读的是 world.spawn）----------
  out.push(...checkSpawnKey(name, input.text));

  // ---------- 10：rewards.yml 的随机奖励结构 ----------
  if (name === 'rewards.yml') {
    out.push(...checkRewards(input.text));
  }

  // ---------- 11：重复定义 ----------
  if (input.options.references && self) {
    out.push(...checkDuplicateNames(self, lines));
  }

  return out;
}

// ==================================================================
//  哪些区域是脚本
// ==================================================================

interface Region {
  /** 0 基起止行（含）。 */
  start: number;
  end: number;
  /** 该区域是否属于 scripts.yml 的某个钩子（用于 player 可用性判断）。 */
  hook?: string;
}

/** 脚本键名：值里放的是 JS。 */
const SCRIPT_KEY_RE =
  /^\s*-?\s*"?\s*(script|脚本|on_start|on_end|on_revive|on_exhausted|trigger_script|进入脚本|离开脚本|开始脚本|通关脚本|超时脚本|start\.script)\s*"?\s*:/;

const CONDITION_KEY_RE = /^\s*-?\s*"?\s*(condition|条件|when|通关条件|complete_when)\s*"?\s*:/;

/** 收集「值会被当 JS 执行」的行区间。 */
function collectScriptRanges(fileName: string, lines: string[]): Region[] {
  const out: Region[] = [];

  if (fileName === 'scripts.yml') {
    // 整个文件都是钩子：以顶层键为界
    let current: Region | null = null;
    let currentHook: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#/.test(line) || line.trim() === '') continue;
      const top = /^([A-Za-z_-][\w-]*)\s*:/.exec(line);
      if (top) {
        if (current) out.push(current);
        currentHook = top[1];
        current = { start: i, end: lines.length - 1, hook: currentHook };
        continue;
      }
      void CONDITION_KEY_RE;
    }
    if (current) out.push(current);
    // 把每个钩子的结束行收紧
    for (let i = 0; i < out.length; i++) {
      out[i].end = i + 1 < out.length ? out[i + 1].start - 1 : lines.length - 1;
    }
    return out;
  }

  // 其它文件：找到 脚本/条件 键，往下的缩进块就是 JS
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SCRIPT_KEY_RE.test(line) && !CONDITION_KEY_RE.test(line)) continue;
    const indent = indentOf(line);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || /^\s*#/.test(l)) {
        end = j;
        continue;
      }
      if (indentOf(l) <= indent) break;
      end = j;
    }
    out.push({ start: i, end });
    i = end;
  }
  return out;
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m ? m[1].replace(/\t/g, '  ').length : 0;
}

// ==================================================================
//  脚本内容检查
// ==================================================================

function checkScriptRegion(
  input: DiagnosticsInput,
  region: Region,
  dir: string | undefined,
  lines: string[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const opts = input.options;

  for (let i = region.start; i <= region.end && i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;

    if (opts.unknownMethod) {
      out.push(...checkMethodCalls(line, i, dir, input.index));
    }

    // 未知文本占位符
    out.push(...checkPlaceholders(line, i));

    // 时间写法（3秒钟 / 5分钟 这类会静默变成 0）
    out.push(...checkTimeStrings(line, i));

    // player 不可用
    if (region.hook && !hookHasTrigger(region.hook)) {
      const m = /\b(player|trigger)\b/.exec(line);
      if (m && !/typeof\s+(player|trigger)\s*!==/.test(line) && !/typeof\s+(player|trigger)\s*===/.test(line)) {
        out.push({
          range: Range.create(i, m.index, i, m.index + m[1].length),
          severity: SEVERITY_WARN,
          source: 'liudungeon',
          message:
            `${region.hook} 钩子里没有触发者，直接引用 ${m[1]} 会抛 ReferenceError（脚本被静默跳过）。` +
            `\n改成 if (typeof ${m[1]} !== 'undefined') { ... } 或直接用 action.message('@all', ...)。`,
        });
      }
    }
  }
  return out;
}

function hookHasTrigger(hook: string): boolean {
  const norm = hook.replace(/-/g, '_');
  const info = HOOK_NAMES.get(norm) ?? HOOK_NAMES.get(hook);
  return info ? info.hasTrigger : false;
}

function checkMethodCalls(
  line: string,
  lineNo: number,
  dir: string | undefined,
  index: IndexStore,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /\b(action|dungeon)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const object = m[1];
    const methodName = m[2];
    const table = object === 'action' ? ACTION_METHODS : DUNGEON_METHODS;
    const method = table.get(methodName);
    const nameStart = m.index + m[0].indexOf(methodName);

    if (!method) {
      out.push({
        range: Range.create(lineNo, nameStart, lineNo, nameStart + methodName.length),
        severity: SEVERITY_WARN,
        source: 'liudungeon',
        message: `${object}.${methodName}() 不存在（脚本引擎按 TypeError 静默吞掉，这一行不会生效）。`,
        code: 'unknown-method',
      });
      continue;
    }

    // 参数个数：只报「给多了」，给少了可能是有意使用重载/可选参数
    const call = extractCall(line, m.index + m[0].length - 1);
    if (call) {
      const arity = countArgs(call.args);
      const max = maxArity(methodName, object);
      if (arity > max) {
        out.push({
          range: Range.create(lineNo, nameStart, lineNo, nameStart + methodName.length),
          severity: SEVERITY_WARN,
          source: 'liudungeon',
          message: `${object}.${methodName} 最多接受 ${max} 个参数，这里给了 ${arity} 个。签名：${method.signature}`,
          code: 'arity',
        });
      }

      // 选择器检查：第一个参数是 '@xxx' 形式
      const first = call.args[0]?.trim() ?? '';
      if (first && SELECTOR_LIKE.test(first)) {
        const value = first.slice(1, -1);
        const at = line.indexOf(first, nameStart);
        if (value.startsWith('@') && dir !== undefined && !SELECTORS.has(value)) {
          out.push({
            range: Range.create(lineNo, Math.max(0, at), lineNo, Math.max(0, at) + first.length),
            severity: SEVERITY_WARN,
            source: 'liudungeon',
            message:
              `选择器 ${value} 没有实现：resolveSelector 里没有这个分支，会按玩家名解析并回落到触发者。` +
              `可用：@all / @trigger / @others / @nearest / @random（以及中文别名）。`,
            code: 'selector',
          });
        }
      }

      // 名字类参数检查（组名 / 区域名 / 奖励名 / 点位）
      if (dir) {
        out.push(...checkNamedArgs(method, methodName, call, lineNo, index, dir));
      }
    }
  }
  return out;
}

/** 同名重载里的最大参数个数（数据里重载会被拆成多行，这里取并集）。 */
function maxArity(methodName: string, object: string): number {
  const table = object === 'action' ? ACTION_OVERLOADS : DUNGEON_OVERLOADS;
  const rows = table.get(methodName) ?? [];
  return rows.reduce((max, m) => Math.max(max, m.params.length), 0);
}

const NAMED_ARG_KINDS: Record<string, RefKind> = {
  spawn_group: 'groups',
  monster_group: 'groups',
  random_spawn_group: 'groups',
  random_monster_group: 'groups',
  stop_repeat: 'groups',
  cancel_group: 'groups',
  clear_group: 'groups',
  skip_group: 'groups',
  wait_clear: 'groups',
  getAliveMonsterCount: 'groups',
  isGroupCleared: 'groups',
  isGroupActive: 'groups',
  getGroupSpawned: 'groups',
  getGroupKilled: 'groups',
  isBossKilled: 'groups',
  enable_zone: 'zones',
  disable_zone: 'zones',
  teleport_zone: 'zones',
  getZonePlayerCount: 'zones',
  isZoneEnabled: 'zones',
  trigger_interact: 'interacts',
  grant_reward: 'rewards',
  reward: 'rewards',
  goto_stage: 'stages',
  teleport_point: 'points',
};

function checkNamedArgs(
  method: ApiMethod,
  methodName: string,
  call: { args: string[]; argStarts: number[] },
  lineNo: number,
  index: IndexStore,
  dir: string,
): Diagnostic[] {
  const kind = NAMED_ARG_KINDS[methodName];
  if (!kind) return [];
  const idx = method.params.findIndex((p) => !/selector/i.test(p.name));
  const pos = idx >= 0 ? idx : 0;
  const raw = call.args[pos]?.trim();
  if (!raw || !/^['"]/.test(raw)) return [];
  const value = raw.slice(1, -1);
  if (!value || value.includes('{') || value.startsWith('@')) return [];
  if (index.has(kind, dir, value)) return [];
  const start = call.argStarts[pos] ?? 0;
  return [
    {
      range: Range.create(lineNo, start, lineNo, start + raw.length),
      severity: SEVERITY_WARN,
      source: 'liudungeon',
      message: `${REF_LABEL[kind]}「${value}」在本副本里没有定义（检查拼写；定义位置见 ${definingFile(kind)}）。`,
      code: 'unknown-reference',
    },
  ];
}

function definingFile(kind: RefKind): string {
  switch (kind) {
    case 'groups':
      return 'monsters.yml';
    case 'rewards':
      return 'rewards.yml';
    case 'interacts':
      return 'interacts.yml';
    case 'stages':
      return 'stages.yml';
    case 'points':
      return 'zones.yml 的 点位';
    default:
      return 'zones.yml';
  }
}

/** 从 `(` 位置开始做简单的括号配对，切出参数。 */
function extractCall(line: string, openParen: number): { args: string[]; argStarts: number[] } | null {
  let depth = 0;
  let inS = false;
  let inD = false;
  const args: string[] = [];
  const argStarts: number[] = [];
  let current = '';
  let currentStart = openParen + 1;
  for (let i = openParen; i < line.length; i++) {
    const ch = line[i];
    if (inS) {
      current += ch;
      if (ch === "'" && line[i - 1] !== '\\') inS = false;
      continue;
    }
    if (inD) {
      current += ch;
      if (ch === '"' && line[i - 1] !== '\\') inD = false;
      continue;
    }
    if (ch === "'") {
      inS = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inD = true;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      if (depth > 1) current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) {
        if (current.trim() !== '' || args.length > 0) {
          args.push(current.trim());
          argStarts.push(currentStart);
        }
        return { args, argStarts };
      }
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      argStarts.push(currentStart);
      current = '';
      currentStart = i + 1;
      continue;
    }
    current += ch;
  }
  return null;
}

function countArgs(args: string[]): number {
  return args.filter((a) => a !== '').length;
}

/**
 * 区域脚本额外注入的占位符（ZoneManager.runZoneScript 在执行前对每一行做替换）。
 * 不在全局占位符名单里，但必须认，否则 zones.yml 的进入/离开脚本会被误报。
 */
const ZONE_PLACEHOLDERS = new Set([
  '{zone}',
  '{区域}',
  '{zone.name}',
  '{区域名称}',
  '{from_zone}',
  '{来源区域}',
]);

/** 文本占位符检查：只在出现 action.message/title/actionbar/broadcast 的行上做。 */
function checkPlaceholders(line: string, lineNo: number): Diagnostic[] {
  if (!/\baction\s*\.\s*(message|title|actionbar|broadcast)\s*\(/.test(line)) return [];
  const out: Diagnostic[] = [];
  const re = /\{([A-Za-z_][\w.]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const key = m[1];
    if (key.startsWith('random') || key.startsWith('var')) continue;
    if (SELECTORS.has(m[0])) continue;
    if (ZONE_PLACEHOLDERS.has(m[0])) continue;
    if (!PLACEHOLDERS.has(m[0])) {
      out.push({
        range: Range.create(lineNo, m.index, lineNo, m.index + m[0].length),
        severity: SEVERITY_INFO,
        source: 'liudungeon',
        message: `占位符 ${m[0]} 不会被替换，会原样显示给玩家。可用：{player.name} {player.level} {player.health} {dungeon.time} {dungeon.players} {dungeon.name} {total_kills} {var:名字} {random:1-100}`,
        code: 'placeholder',
      });
    }
  }
  return out;
}

/** 时间字符串：单位必须紧跟数字，且只用 s/秒 m/分/min h/时 t/tick ms/毫秒/纯数字。 */
const BAD_TIME = /(['"])(\d+)\s*(秒钟|分钟|小时|seconds?|minutes?|hours?|ticks?)\1/g;

function checkTimeStrings(line: string, lineNo: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = new RegExp(BAD_TIME.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const at = m.index + 1;
    out.push({
      range: Range.create(lineNo, at, lineNo, at + (m[2] + m[3]).length),
      severity: SEVERITY_WARN,
      source: 'liudungeon',
      message: `时间写法 "${m[2]}${m[3]}" 解析失败会静默变成 0。只能写 ${m[2]}s / ${m[2]}秒${m[3] === '分钟' ? `（或 ${m[2]}m / ${m[2]}分）` : ''}。`,
      code: 'time-format',
    });
  }
  return out;
}

// ==================================================================
//  跨文件引用
// ==================================================================

function checkReferences(
  input: DiagnosticsInput,
  dir: string,
  lines: string[],
  self: ReturnType<IndexStore['forFile']>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const name = baseName(input.filePath);

  // trigger_group / group：检查组名存在
  if (name === 'monsters.yml' && self) {
    const groups = new Set(self.defs.groups.map((g) => g.name));
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(trigger_group|group|触发组)\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(lines[i]);
      if (!m) continue;
      const target = m[2];
      if (!groups.has(target)) {
        const at = lines[i].indexOf(target);
        out.push({
          range: Range.create(i, at, i, at + target.length),
          severity: SEVERITY_WARN,
          source: 'liudungeon',
          message: `trigger_group 指向的怪物组「${target}」不存在${groups.size ? `。已有：${[...groups].join(' / ')}` : ''}`,
          code: 'unknown-reference',
        });
      }
    }
  }

  // zones.yml 的 范围 / 点位 只在语法明显错时提示
  if (name === 'zones.yml') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(范围|region|bounds)\s*:\s*['"]?([^'"#]+)['"]?/.exec(lines[i]);
      if (!m) continue;
      const value = m[2].trim();
      if (!/^\s*-?\d+(\s*,\s*-?\d+){2}\s*~\s*-?\d+(\s*,\s*-?\d+){2}\s*$/.test(value)) {
        const at = lines[i].indexOf(m[2]);
        out.push({
          range: Range.create(i, at, i, at + m[2].length),
          severity: SEVERITY_INFO,
          source: 'liudungeon',
          message: '范围推荐写成 "x1,y1,z1 ~ x2,y2,z2"（两个对角坐标，用 ~ 隔开）。',
          code: 'zone-range',
        });
      }
    }
  }

  // 奖励名（rewards.yml 的顶层键）与 action.grant_reward 的交叉检查已在脚本区做
  void dir;
  return out;
}

// ==================================================================
//  钩子名与 dungeon.spawn
// ==================================================================

function checkHooks(lines: string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (!m) continue;
    const hook = m[1];
    if (!HOOK_NAMES.has(hook)) {
      out.push({
        range: Range.create(i, 0, i, hook.length),
        severity: SEVERITY_WARN,
        source: 'liudungeon',
        message:
          `scripts.yml 里没有「${hook}」这个钩子，写了不会执行。` +
          `可用：${CONFIG_DATA.scriptHooks.map((h) => h.name).join(' / ')}`,
        code: 'unknown-hook',
      });
      continue;
    }
    const dead = DEAD_HOOKS.get(hook.replace(/-/g, '_'));
    if (dead) {
      out.push({
        range: Range.create(i, 0, i, hook.length),
        severity: SEVERITY_INFO,
        source: 'liudungeon',
        message: dead,
        code: 'dead-hook',
      });
    }
  }
  return out;
}

function checkSpawnKey(fileName: string, text: string): Diagnostic[] {
  if (fileName !== 'config.yml') return [];
  let doc;
  try {
    doc = parseDocument(text, { keepSourceTokens: false });
  } catch {
    return [];
  }
  const root = doc.contents;
  if (!(root instanceof YAMLMap)) return [];
  const dungeon = entryValue(root, ['dungeon', '地牢']);
  if (!(dungeon instanceof YAMLMap)) return [];
  const spawnKey = dungeon.items.find(
    (it) => scalarText(it.key) === 'spawn',
  );
  if (!spawnKey) return [];
  const offset = lineOffset(spawnKey.key);
  const line = offsetToLine(text, offset);
  const column = offset - lineStartOffset(text, offset);
  return [
    {
      range: Range.create(line, column, line, column + 'spawn'.length),
      severity: SEVERITY_ERROR,
      source: 'liudungeon',
      message:
        'spawn 写在 dungeon 段里不会生效（运行时读的是 world.spawn）。' +
        '把这一行移到 world 段下，或直接用 /ld edit 菜单里的「设置出生点」。',
      code: 'spawn-key',
    },
  ];
}

/** 取映射里某个键的值节点（支持多个候选键名）。 */
function entryValue(map: YAMLMap, keys: string[]): unknown {
  for (const item of map.items) {
    const k = scalarText(item.key);
    if (k != null && keys.includes(k)) return item.value;
  }
  return undefined;
}

function scalarText(node: unknown): string | null {
  if (node instanceof Scalar) return String(node.value);
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return null;
}

function lineOffset(node: unknown): number {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? range[0] : 0;
}

function lineStartOffset(text: string, offset: number): number {
  const nl = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return nl + 1;
}

// ==================================================================
//  rewards.yml：随机奖励的「少写一层就静默失效」检查
// ==================================================================

/** 插件真正会读取的奖励键（Keys.* 的别名合集）。 */
const REWARD_KNOWN_KEYS = new Set([
  'type', '类型', 'fixed',
  'items', '物品', 'item', 'id',
  'money', '金钱', '金币',
  'exp', '经验',
  'commands', '命令',
  'options', '选项',
  '保底', 'pity',
]);

/**
 * 随机奖励最常见的坑：把选项直接写在奖励名下面，少了 options 这一层。
 * RewardConfig.parseReward 只从 options / 选项 里取选项，
 * 于是 roll() 拿到空 options 直接返回 null —— 奖励名对、脚本也在跑，玩家什么都拿不到，
 * 而且日志里没有任何报错。
 */
function checkRewards(text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let doc;
  try {
    doc = parseDocument(text, { keepSourceTokens: false });
  } catch {
    return out;
  }
  const root = doc.contents;
  if (!(root instanceof YAMLMap)) return [];
  const rewards = entryValue(root, ['rewards', '奖励']);
  if (!(rewards instanceof YAMLMap)) return [];

  for (const item of rewards.items) {
    const rewardName = scalarText(item.key);
    if (rewardName == null || !(item.value instanceof YAMLMap)) continue;
    const sec = item.value;
    const typeKey = findKey(sec, ['type', '类型']);
    const typeValue = typeKey ? scalarText((typeKey.value as Scalar | null) ?? null) : null;
    const isRandom =
      typeValue != null && (/^random$/i.test(typeValue) || typeValue === '随机');

    // 1) 非随机奖励却写了选项：说明是想写随机但漏了 type
    const optionsKey = findKey(sec, ['options', '选项']);
    if (!isRandom) {
      if (optionsKey) {
        out.push(diagAt(text, optionsKey.key, SEVERITY_WARN, 'options 只在 type: random 的奖励里生效，这里写了但奖励类型是固定奖励，整个 options 会被忽略。'));
      }
      continue;
    }

    // 2) type: random 但没有 options
    if (!optionsKey) {
      const strayKey = sec.items
        .map((it) => scalarText(it.key))
        .find((k) => k != null && !REWARD_KNOWN_KEYS.has(k));
      out.push(
        diagAt(
          text,
          typeKey?.value ?? sec.items[0]?.key ?? item.key,
          SEVERITY_ERROR,
          'type: random 的奖励没有 options（或 选项）段：解析器只从 options 里取选项，' +
            '现在选项数为 0，抽奖会直接返回空 —— 奖励不发放且不报错。' +
            (strayKey ? ` 看起来「${strayKey}」是想当选项写的，把它移到 options: 下面。` : ''),
          'reward-options-missing',
        ),
      );
      continue;
    }

    // 3) options 里没有任何正权重
    const optionsValue = optionsKey.value;
    if (optionsValue instanceof YAMLMap) {
      const entries: Array<{ name: string; node: YAMLMap; keyNode: unknown }> = [];
      for (const opt of optionsValue.items) {
        const optName = scalarText(opt.key);
        if (optName == null || !(opt.value instanceof YAMLMap)) continue;
        entries.push({ name: optName, node: opt.value, keyNode: opt.key });
      }
      if (entries.length === 0) {
        out.push(diagAt(text, optionsKey.key, SEVERITY_WARN, 'options 是空的，抽奖没有可选分支。'));
      } else {
        const weights = entries.map((e) => {
          const w = findKey(e.node, ['weight', '权重']);
          const raw = w ? scalarText((w.value as Scalar | null) ?? null) : null;
          const n = raw == null ? null : Number(raw);
          return { ...e, weight: n };
        });
        const positive = weights.filter((w) => w.weight != null && w.weight > 0);
        if (positive.length === 0) {
          out.push(
            diagAt(
              text,
              optionsKey.key,
              SEVERITY_WARN,
              'options 里没有任何 weight > 0 的选项：权重默认是 0（写错键名或漏写都会变成 0）。' +
                '这种配置会退化成「所有选项等概率」—— 通常不是你想要的。',
              'reward-weight',
            ),
          );
        } else if (positive.length < weights.length) {
          for (const w of weights) {
            if (w.weight != null && w.weight > 0) continue;
            out.push(
              diagAt(
                text,
                w.keyNode,
                SEVERITY_WARN,
                `选项「${w.name}」的权重是 ${w.weight ?? 0}，永远抽不到。权重默认 0，` +
                  '要让它可抽必须写一个正数 weight。',
                'reward-weight',
              ),
            );
          }
        }
      }
    }
  }
  return out;
}

function findKey(map: YAMLMap, keys: string[]): { key: unknown; value: unknown } | null {
  for (const item of map.items) {
    const k = scalarText(item.key);
    if (k != null && keys.includes(k)) return { key: item.key, value: item.value };
  }
  return null;
}

function diagAt(
  text: string,
  node: unknown,
  severity: DiagnosticSeverity,
  message: string,
  code?: string,
): Diagnostic {
  const offset = lineOffset(node);
  const line = offsetToLine(text, offset);
  const start = lineStartOffset(text, offset);
  const label = node instanceof Scalar && typeof node.value === 'string' ? node.value : '';
  const length = label ? label.length + 1 : 1;
  return {
    range: Range.create(line, offset - start, line, offset - start + length),
    severity,
    source: 'liudungeon',
    message,
    code,
  };
}

// ==================================================================
//  重复定义
// ==================================================================

function checkDuplicateNames(
  self: NonNullable<ReturnType<IndexStore['forFile']>>,
  lines: string[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byFile = new Map<string, number[]>();
  for (const kind of Object.keys(self.defs) as RefKind[]) {
    for (const d of self.defs[kind]) {
      const key = `${d.file}::${kind}::${d.name}`;
      const list = byFile.get(key) ?? [];
      list.push(d.line);
      byFile.set(key, list);
    }
  }
  for (const [key, list] of byFile) {
    if (list.length < 2) continue;
    const [, kind, name] = key.split('::');
    for (const line of list) {
      if (line >= lines.length) continue;
      out.push({
        range: Range.create(line, 0, line, lines[line].length),
        severity: SEVERITY_WARN,
        source: 'liudungeon',
        message: `${REF_LABEL[kind as RefKind]}「${name}」在这个文件里定义了多次，YAML 会以后一个为准。`,
        code: 'duplicate-name',
      });
    }
  }
  return out;
}
