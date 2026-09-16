/**
 * 补全提供者：
 *   - YAML 键名补全（按 nodes 的路径模板 + 缩进）
 *   - YAML 值补全（枚举值、选择器、时间字符串、条件关键词、名字引用）
 *   - YAML 里嵌的 JS 片段补全（action.* / dungeon.* / 内置函数 / 选择器）
 *   - functions.js 等纯 JS 文件补全
 */
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  Range,
  TextEdit,
} from 'vscode-languageserver';
import {
  ACTION_METHODS,
  BUILTIN_FUNCTIONS,
  CONDITION_KEYWORDS,
  CONFIG_DATA,
  DEAD_HOOKS,
  DUNGEON_METHODS,
  GLOBAL_OBJECTS,
  SELECTORS,
  TIME_FORMATS,
  scriptBlockLines,
  type ApiMethod,
  type ConfigNode,
} from './api-model';
import { IndexStore, RefKind, REF_LABEL } from './index-store';
import { analyze, childNodes, nodeAt, type YamlContext } from './yaml-context';
import { baseName, keySpellings, splitPath } from './yaml-shared';
import { functionSnippets, javascriptSnippets } from './snippets';

export interface CompletionInput {
  /** 文件绝对路径（用于取文件名与所属副本）。 */
  filePath: string;
  text: string;
  line: number;
  character: number;
  index: IndexStore;
}

/** 期望写“脚本”的键名（YAML 里这些键的值会被当 JS 执行）。 */
const SCRIPT_KEYS = new Set([
  'script',
  '脚本',
  'on_start',
  'on_end',
  'on_revive',
  'on_exhausted',
  'trigger_script',
  '进入脚本',
  '离开脚本',
  '开始脚本',
  '通关脚本',
  '超时脚本',
]);

const CONDITION_HINT_KEYS = new Set(['condition', '条件', 'when']);

/** 值为“名字引用”的键 → 对应容器类型；键名与脚本 API 参数名都收在这里。 */
const NAME_REF_KEYS: Record<string, RefKind> = {
  // 脚本 API 参数名
  spawn_group: 'groups',
  monster_group: 'groups',
  random_spawn_group: 'groups',
  random_monster_group: 'groups',
  stop_repeat: 'groups',
  cancel_group: 'groups',
  clear_group: 'groups',
  skip_group: 'groups',
  wait_clear: 'groups',
  enable_zone: 'zones',
  disable_zone: 'zones',
  teleport_zone: 'zones',
  trigger_interact: 'interacts',
  grant_reward: 'rewards',
  goto_stage: 'stages',
  teleport_point: 'points',
  getAliveMonsterCount: 'groups',
  isGroupCleared: 'groups',
  isGroupActive: 'groups',
  getGroupSpawned: 'groups',
  getGroupKilled: 'groups',
  getRepeatCount: 'groups',
  isBossKilled: 'groups',
  getZone: 'zones',
  getZoneName: 'zones',
  isInZone: 'zones',
  getZonePlayerCount: 'zones',
  isZoneEnabled: 'zones',
  // YAML 键名
  group: 'groups',
  trigger_group: 'groups',
  zone: 'zones',
  interact: 'interacts',
  interact_id: 'interacts',
  reward: 'rewards',
  reward_name: 'rewards',
  stage: 'stages',
  task: 'tasks',
  tasks: 'tasks',
  point: 'points',
};

export function provideCompletions(input: CompletionInput): CompletionItem[] {
  const name = baseName(input.filePath);
  if (name.endsWith('.js') || name.endsWith('.lds')) {
    return javascriptCompletions(input, input.text, input.line, input.character);
  }
  return yamlCompletions(input);
}

// ==================================================================
//  YAML
// ==================================================================

function yamlCompletions(input: CompletionInput): CompletionItem[] {
  const name = baseName(input.filePath);
  const ctx = analyze(input.text, input.line, input.character);
  const range = wordRange(input.line, ctx.wordStart, ctx.lineText.length);

  // 1) 块标量正文（on_end: |-）或引号字符串里 → 其实在写 JS
  if (ctx.blockScalar) {
    const js = javascriptCompletions(input, input.text, input.line, input.character);
    if (js.length) return js;
  } else if (ctx.quote) {
    const js = javascriptCompletions(input, ctx.stringBody, 0, ctx.stringBody.length);
    if (js.length) return js;
  }

  // 2) 值位置（`key: ` 之后）
  if (ctx.inValue) {
    return valueCompletions(input, name, ctx, range);
  }

  // 3) 键名位置
  return keyCompletions(input, name, ctx, range);
}

function valueCompletions(
  input: CompletionInput,
  fileName: string,
  ctx: YamlContext,
  range: Range,
): CompletionItem[] {
  const node = nodeAt(fileName, ctx);
  const dir = input.index.dirForFile(input.filePath);
  const out: CompletionItem[] = [];

  // 枚举值
  if (node?.values?.length) {
    for (const v of node.values) {
      out.push({
        label: v,
        kind: CompletionItemKind.EnumMember,
        detail: `${node.key} 的取值`,
        documentation: { kind: MarkupKind.Markdown, value: node.doc },
        textEdit: TextEdit.replace(range, v),
      });
    }
  }

  // 名字引用（怪物组 / 区域 / 奖励 …）→ 列出同副本里已定义的名字
  const kind = NAME_REF_KEYS[ctx.currentKey];
  if (kind) out.push(...nameItems(input.index, dir, kind, range));

  // 时间字符串
  if (/^(delay|interval|cooldown|limit|cast_time|超时|延迟|间隔|冷却|时间)$/.test(ctx.currentKey)) {
    for (const t of TIME_FORMATS) {
      out.push({
        label: t.value,
        kind: CompletionItemKind.Value,
        detail: '时间写法',
        documentation: { kind: MarkupKind.Markdown, value: t.doc },
        textEdit: TextEdit.replace(range, t.value),
      });
    }
  }

  // 脚本 / 条件：给可直接粘贴的整行 JS 片段
  const nodeType = node?.type ?? '';
  const isScript = nodeType === '脚本' || SCRIPT_KEYS.has(ctx.currentKey);
  const isCondition = nodeType === '条件' || CONDITION_HINT_KEYS.has(ctx.currentKey);

  if (isScript || isCondition) {
    for (const s of javascriptSnippets(isCondition)) {
      out.push({
        label: s.label,
        kind: CompletionItemKind.Snippet,
        detail: isCondition ? '条件表达式片段' : '脚本片段',
        documentation: { kind: MarkupKind.Markdown, value: s.doc },
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: TextEdit.replace(range, s.body),
      });
    }
  }

  if (isCondition) {
    for (const k of CONDITION_KEYWORDS) {
      if (ctx.word && !k.cn.startsWith(ctx.word)) continue;
      out.push({
        label: k.cn,
        kind: CompletionItemKind.Keyword,
        detail: `中文条件关键词 → ${k.js}`,
        documentation: {
          kind: MarkupKind.Markdown,
          value: `中文条件里可以直接写 \`${k.cn}\`，引擎求值前会替换成 \`${k.js}\`。`,
        },
        textEdit: TextEdit.replace(range, k.cn),
      });
    }
  }

  return out;
}

function keyCompletions(
  input: CompletionInput,
  fileName: string,
  ctx: YamlContext,
  range: Range,
): CompletionItem[] {
  const out: CompletionItem[] = [];
  const dir = input.index.dirForFile(input.filePath);
  const prefix = ctx.word;

  for (const node of childNodes(fileName, ctx)) {
    if (prefix && !node.key.startsWith(prefix)) continue;
    out.push(keyItem(fileName, node, range));
  }

  // 容器节点下：提示“这里要写名字”
  const ancestors = ctx.ancestors.join('.');
  const segments = splitPath(ancestors);
  const lastSeg = segments[segments.length - 1];

  if (lastSeg === 'groups' || lastSeg === '怪物组' || lastSeg === 'waves' || lastSeg === '波次') {
    out.push({
      label: '新怪物组',
      kind: CompletionItemKind.Module,
      detail: '组名（波次名）',
      documentation: {
        kind: MarkupKind.Markdown,
        value:
          '组名会被 `on_end` / `trigger_group` / `action.spawn_group()` / 任务事件引用。\n\n' +
          '```yaml\ngroups:\n  wave_1:\n    spawn_timing:\n      type: AUTO_START\n    monsters:\n      - id: Zombie\n        location: \'0,64,-10\'\n        amount: 3\n```',
      },
      textEdit: TextEdit.replace(range, '${1:wave_1}'),
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }

  if (lastSeg === '点位' || lastSeg === 'points') {
    for (const z of input.index.names('zones', dir)) {
      if (prefix && !z.name.startsWith(prefix)) continue;
      out.push({
        label: z.name,
        kind: CompletionItemKind.Class,
        detail: '区域（点位写在区域下面）',
        textEdit: TextEdit.replace(range, z.name),
      });
    }
  }

  // scripts.yml：顶层是固定钩子名
  if (fileName === 'scripts.yml' && ctx.indent === 0) {
    for (const hook of CONFIG_DATA.scriptHooks) {
      if (prefix && !hook.name.startsWith(prefix)) continue;
      out.push(hookItem(hook.name, hook.doc, hook.hasTrigger, hook.example, range));
    }
  }

  return out;
}

function hookItem(
  name: string,
  doc: string,
  hasTrigger: boolean,
  example: string,
  range: Range,
): CompletionItem {
  const dead = DEAD_HOOKS.get(name);
  const md = [
    doc,
    '',
    `触发者：${hasTrigger ? '有（player / trigger 可用）' : '无（player 不存在，别直接引用）'}`,
    '',
    '```yaml',
    ...scriptBlockLines(name, example),
    '```',
  ];
  if (dead) md.push(`\n> ⚠ ${dead}`);
  return {
    label: name,
    kind: CompletionItemKind.Field,
    detail: dead ? '⚠ 当前版本不会执行' : hasTrigger ? '有 player' : '无 player',
    documentation: { kind: MarkupKind.Markdown, value: md.join('\n') },
    textEdit: TextEdit.replace(range, `${name}: |-\n  \${1:action.message('@all', '&e文本');}`),
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: dead ? `z${name}` : `a${name}`,
  };
}

function keyItem(fileName: string, node: ConfigNode, range: Range): CompletionItem {
  const spellings = keySpellings(node);
  const doc: string[] = [node.doc];
  if (node.type) doc.push('', `类型：\`${node.type}\``);
  if (node.values?.length) doc.push(`取值：${node.values.map((v) => `\`${v}\``).join(' / ')}`);
  if (spellings.length > 1) doc.push('', `同义写法：${spellings.slice(1).join(' / ')}`);
  if (node.required) doc.push('', '**必填**');
  const dead = DEAD_HOOKS.get(node.key);

  return {
    label: node.key,
    kind: CompletionItemKind.Property,
    detail: `${fileName} · ${node.type}`,
    labelDetails: { description: node.doc.slice(0, 24) },
    documentation: {
      kind: MarkupKind.Markdown,
      value: doc.join('\n') + (dead ? `\n\n> ⚠ ${dead}` : ''),
    },
    textEdit: TextEdit.replace(range, valueTemplate(node)),
    insertTextFormat: InsertTextFormat.Snippet,
  };
}

/** 按节点类型给出值的骨架。 */
function valueTemplate(node: ConfigNode): string {
  if (node.values?.length) return `${node.key}: \${1|${node.values.join(',')}|}`;
  switch (node.type) {
    case '映射':
      return `${node.key}:\n  \${1}`;
    case '列表':
      return `${node.key}:\n  - \${1}`;
    case '布尔':
      return `${node.key}: \${1|true,false|}`;
    case '数字':
      return `${node.key}: \${1:1}`;
    case '时间':
      return `${node.key}: \${1:3s}`;
    case '坐标':
      return `${node.key}: '\${1:0,64,0}'`;
    case '脚本':
      return `${node.key}: |-\n  \${1:action.message('@all', '&e你好');}`;
    case '条件':
      return `${node.key}:\n  - \${1:dungeon.getTotalAliveMonsters() <= 0}`;
    default:
      return `${node.key}: \${1}`;
  }
}

function nameItems(
  index: IndexStore,
  dir: string | undefined,
  kind: RefKind,
  range: Range,
): CompletionItem[] {
  const defs = index.names(kind, dir);
  return defs.map((d) => ({
    label: d.name,
    kind: CompletionItemKind.Reference,
    detail: `${REF_LABEL[kind]}（定义在 ${d.file}）`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: `${d.doc ? d.doc + '\n\n' : ''}定义位置：${d.file}:${d.line + 1}`,
    },
    textEdit: TextEdit.replace(range, d.name),
  }));
}

// ==================================================================
//  JavaScript（functions.js 与 YAML 内嵌片段共用）
// ==================================================================

export interface JsContext {
  /** 正在输入的词。 */
  word: string;
  /** 访问的对象名（`action.` 的 `action`）；无则为 ''。 */
  object: string;
  /** 正在补参数的那个方法名（`action.spawn_group('` → spawn_group）。 */
  callMethod: string;
  /** 是否处在字符串参数里。 */
  inString: boolean;
}

/**
 * 解析光标前的 JS 片段，判断在补全什么。
 *
 *   `action.`            → 方法名列表
 *   `action.mes`         → 过滤方法名
 *   `getV`               → 内置函数
 *   `action.message('@`  → 选择器
 *   `action.spawn_group('` → 怪物组名
 */
export function parseJsContext(before: string): JsContext {
  const member = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(before);
  if (member) {
    return { word: member[2] ?? '', object: member[1], callMethod: '', inString: false };
  }
  const inStringMatch = /(?:^|[^\\])['"]([^'"]*)$/.exec(before);
  if (inStringMatch) {
    const head = before.slice(0, before.length - inStringMatch[1].length - 1);
    const call = /([A-Za-z_$][\w$]*)\s*\([^()]*$/.exec(head);
    const memberCall = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\([^()]*$/.exec(head);
    return {
      word: inStringMatch[1],
      object: memberCall ? memberCall[1] : '',
      callMethod: memberCall ? memberCall[2] : call ? call[1] : '',
      inString: true,
    };
  }
  const word = /([A-Za-z_$][\w$]*)$/.exec(before);
  return { word: word?.[1] ?? '', object: '', callMethod: '', inString: false };
}

/**
 * JS 补全。
 *
 * @param text  用来定位上下文的文本：整份文档（块标量）或单行内容（引号字符串）
 * @param line  text 里的行号
 * @param character  该行的字符偏移
 */
function javascriptCompletions(
  input: CompletionInput,
  text: string,
  line: number,
  character: number,
): CompletionItem[] {
  const lines = text.split(/\r?\n/);
  const lineText = (lines[line] ?? '').slice(0, character);
  const ctx = parseJsContext(lineText);

  const range: Range = {
    start: { line, character: Math.max(0, character - ctx.word.length) },
    end: { line, character },
  };

  const out: CompletionItem[] = [];

  // 选择器（action.message('@…') 这类）—— 只有真的打了 @ 才给选择器，
  // 否则 `action.spawn_group('')` 这种位置会被选择器列表淹没，看不到组名。
  if (ctx.inString && ctx.word.startsWith('@')) {
    for (const [value, doc] of SELECTORS) {
      if (ctx.word && !value.startsWith(ctx.word)) continue;
      out.push({
        label: value,
        kind: CompletionItemKind.EnumMember,
        detail: '玩家选择器',
        documentation: { kind: MarkupKind.Markdown, value: doc },
        textEdit: TextEdit.replace(range, value),
      });
    }
    if (out.length) return out;
  }

  // 名字类参数（组名 / 区域名 / 奖励名 …）
  const refKind = NAME_REF_KEYS[ctx.callMethod];
  if (ctx.inString && refKind) {
    const items = nameItems(input.index, input.index.dirForFile(input.filePath), refKind, range)
      .filter((i) => !ctx.word || String(i.label).startsWith(ctx.word));
    if (items.length) return items;
  }

  if (ctx.object === 'action' || ctx.object === 'dungeon') {
    const table = ctx.object === 'action' ? ACTION_METHODS : DUNGEON_METHODS;
    for (const [name, method] of table) {
      if (ctx.word && !name.startsWith(ctx.word)) continue;
      out.push(methodItem(ctx.object, name, method, range, ctx.word.length > 0));
    }
    return out;
  }

  if (ctx.object === 'player' || ctx.object === 'trigger') {
    return playerMemberItems(range, ctx.word);
  }

  if (ctx.object) return out;

  // 无对象前缀：内置函数 + 全局对象 + 常用片段
  for (const fn of BUILTIN_FUNCTIONS) {
    if (ctx.word && !fn.name.startsWith(ctx.word)) continue;
    out.push({
      label: fn.name,
      kind: CompletionItemKind.Function,
      detail: fn.signature,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `${fn.doc}\n\n返回：${fn.returns}\n\n\`\`\`js\n${fn.example}\n\`\`\``,
      },
      textEdit: TextEdit.replace(range, fn.name),
    });
  }
  for (const g of GLOBAL_OBJECTS) {
    if (ctx.word && !g.name.startsWith(ctx.word)) continue;
    out.push({
      label: g.name,
      kind: CompletionItemKind.Variable,
      detail: g.name === 'player' || g.name === 'trigger' ? '触发者对象' : '注入对象',
      documentation: {
        kind: MarkupKind.Markdown,
        value: `${g.doc}${g.missingWhen ? `\n\n可用性：${g.missingWhen}` : ''}`,
      },
      textEdit: TextEdit.replace(range, g.name),
    });
  }
  for (const s of functionSnippets()) {
    if (ctx.word && !s.label.startsWith(ctx.word)) continue;
    out.push({
      label: s.label,
      kind: CompletionItemKind.Snippet,
      detail: '脚本片段',
      documentation: { kind: MarkupKind.Markdown, value: s.doc },
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit: TextEdit.replace(range, s.body),
    });
  }
  return out;
}

function methodItem(
  object: string,
  name: string,
  method: ApiMethod,
  range: Range,
  typed: boolean,
): CompletionItem {
  const params = method.params
    .map((p, i) => `\${${i + 1}:${sampleArg(p.name, p.type)}}`)
    .join(', ');
  const insert = typed ? name : `${name}(${params})`;
  const doc = [
    method.doc,
    '',
    `分类：${method.category} ｜ 返回：\`${method.returns}\``,
    '',
    '```js',
    method.example,
    '```',
  ];
  if (method.aliases?.length) doc.push(`\n别名：${method.aliases.join(' / ')}`);
  return {
    label: name,
    kind: CompletionItemKind.Method,
    detail: method.signature,
    labelDetails: { description: method.category },
    documentation: { kind: MarkupKind.Markdown, value: doc.join('\n') },
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: TextEdit.replace(range, insert),
    sortText: `${method.category}-${name}`,
    data: { object, name },
  };
}

/**
 * 参数示例值 —— **字符串类型的示例要带引号**。
 *
 * <p>这里踩过一次：补全插进去的是 `action.title(@all, &e文本, &e文本)`（全是裸词），
 * 而插件脚本是 JS，裸的 `@all` / `&e文本` 直接就是语法错误
 * （服务端只会抛一句 `Expected an operand but found error`，看不出是补全的锅）。
 * 数据里每个方法的 `example` 都是带引号的写法（`action.title('@all', '&6&lBOSS 降临', '&7小心脚下')`），
 * 补全应当与示例一致：**只有数字与布尔不加引号**，`player` 是脚本里的玩家变量同样不加。
 */
function sampleArg(paramName: string, type: string): string {
  const sample = sampleFor(paramName, type);
  if (type === '数字' || type === '布尔') return sample;
  if (sample === 'player') return sample;
  return `'${sample}'`;
}

/** 给参数生成一个能直接跑的示例值（不含引号，加引号见 {@link sampleArg}）。 */
function sampleFor(paramName: string, type: string): string {
  switch (type) {
    case '选择器':
      return '@all';
    case '秒数或时间字符串':
    case '时间':
      return '3s';
    case '区域ID':
      return '前厅';
    case '怪物组ID':
      return 'wave_1';
    case '点位引用':
      return '前厅.落点';
    case '材质':
    case '材质或物品':
      return 'DIAMOND';
    case '音效名':
      return 'ENTITY_PLAYER_LEVELUP';
    case '粒子名':
      return 'FLAME';
    case 'GameMode':
      return 'SURVIVAL';
    case '布尔':
      return 'true';
    default:
      break;
  }
  switch (paramName) {
    case 'selector':
      return '@all';
    case 'text':
    case 'title':
    case 'subtitle':
    case 'message':
      return '&e文本';
    case 'amount':
    case 'count':
    case 'value':
    case 'health':
    case 'speed':
    case 'amplifier':
      return '1';
    case 'name':
      return '变量名';
    case 'group':
      return 'wave_1';
    case 'zoneId':
    case 'zone':
      return '前厅';
    case 'rewardName':
      return '通关奖励';
    case 'stageId':
      return '阶段1';
    case 'locationRef':
    case 'location':
      return '0,64,0';
    case 'material':
      return 'DIAMOND';
    case 'soundName':
      return 'ENTITY_PLAYER_LEVELUP';
    case 'particleName':
      return 'FLAME';
    case 'effectName':
      return 'SPEED';
    case 'rule':
      return 'doDaylightCycle';
    case 'command':
      return 'say 你好';
    case 'weather':
      return 'clear';
    case 'mode':
      return 'SURVIVAL';
    case 'timeRef':
      return 'night';
    case 'interactId':
      return '开门';
    case 'duration':
      return '10s';
    case 'reason':
      return '全员阵亡';
    case 'mobId':
      return 'Zombie';
    case 'player':
      return 'player';
    default:
      return paramName;
  }
}

function playerMemberItems(range: Range, word: string): CompletionItem[] {
  const members: Array<[string, string]> = [
    ['getName()', '玩家名'],
    ['getHealth()', '当前血量'],
    ['getLevel()', '经验等级'],
    ['getLocation()', '所在位置（Bukkit Location）'],
    ['getWorld()', '所在世界'],
    ['isDead()', '是否已死亡'],
    ['getGameMode()', '游戏模式'],
    ['getInventory()', '背包'],
    ['sendMessage(...)', '发消息（脚本里请优先用 action.message）'],
    ['getUniqueId()', 'UUID'],
    ['isOnline()', '是否在线'],
  ];
  return members
    .filter(([n]) => !word || n.startsWith(word))
    .map(([n, doc]) => ({
      label: n,
      kind: CompletionItemKind.Method,
      detail: 'Bukkit Player 成员',
      documentation: { kind: MarkupKind.Markdown, value: doc },
      textEdit: TextEdit.replace(range, n.replace(/\(.*\)$/, '()')),
    }));
}

/**
 * 补全要替换的范围：从「正在输入的词」开头到行尾。
 *
 * <p>必须用 `ctx.wordStart` 而不是 0，也不能只覆盖词本身：
 * 这些补全项自带 `textEdit`，而 VS Code 的语言客户端会**丢弃**那些
 * `newText` 与该范围内原文对不上的编辑 —— 范围算错的表现就是
 * 「服务端明明返回了几百条补全，编辑器里却一条都不弹」。
 * （`wordStart` 已经包含了引号前缀，例如 `"enu` 的起点是引号，这样 `'"enable'` 能对上。）
 */
function wordRange(line: number, start: number, lineEnd: number): Range {
  return { start: { line, character: Math.max(0, start) }, end: { line, character: lineEnd } };
}

