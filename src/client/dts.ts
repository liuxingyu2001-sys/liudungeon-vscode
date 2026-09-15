/**
 * 生成 liudungeon.d.ts：把 API 数据变成 TypeScript 声明文件。
 *
 * 价值：VS Code 自带的 JS 语言服务会读取工作区里的 d.ts，
 * 于是 functions.js 里 `action.` 后面也会出现 70 个方法的原生提示，
 * 并且能对拼错的方法名给出红波浪线 —— 这条链路不依赖我们的语言服务。
 */
import {
  ACTION_API,
  BUILTIN_FUNCTIONS,
  DUNGEON_API,
  GLOBAL_OBJECTS,
  type ApiFile,
  type ApiMethod,
} from '../server/api-model';

const HEADER = `// 由 LiuDungeon 脚本支持扩展自动生成，请勿手改（重新打开 VS Code 会覆盖）。
// 目的：让 VS Code 自带的 JS 智能提示认识 action.* / dungeon.* / 内置函数。

`;

export function buildDts(): string {
  const parts: string[] = [HEADER];

  parts.push(renderNamespace('ActionApi', ACTION_API, '动作 API（action.*）'));
  parts.push(renderNamespace('DungeonApi', DUNGEON_API, '状态查询 API（dungeon.*）'));

  const globals: string[] = [];
  for (const g of GLOBAL_OBJECTS) {
    const type = g.name === 'action' ? 'ActionApi' : g.name === 'dungeon' ? 'DungeonApi' : 'PlayerLike';
    globals.push(`/**\n * ${g.doc}\n *\n * 可用性：${g.missingWhen ?? '总是注入'}\n */\ndeclare const ${g.name}: ${type};`);
  }

  const builtins = BUILTIN_FUNCTIONS.map(
    (fn) =>
      `/**\n * ${fn.doc}\n *\n * 返回：${fn.returns}\n *\n * \`\`\`js\n * ${fn.example}\n * \`\`\`\n */\ndeclare function ${fn.name}(${builtinParams(fn.name)}): ${builtinReturn(fn.name)};`,
  );

  parts.push(globals.join('\n\n'));
  parts.push(builtins.join('\n\n'));

  parts.push(PLAYER_LIKE);

  return parts.join('\n\n') + '\n';
}

function renderNamespace(name: string, api: ApiFile, doc: string): string {
  const grouped = new Map<string, ApiMethod[]>();
  for (const m of api.methods) {
    const list = grouped.get(m.name) ?? [];
    list.push(m);
    grouped.set(m.name, list);
  }

  const body: string[] = [];
  for (const [methodName, rows] of grouped) {
    const aliases = [...new Set(rows.flatMap((r) => r.aliases ?? []))].filter((a) => a !== methodName);
    const docs = rows
      .map((r) => {
        const params = r.params
          .map((p) => `@param ${p.name} ${p.doc}${p.type ? `（${p.type}）` : ''}`)
          .join('\n * ');
        return [
          `/**`,
          ` * ${r.doc}`,
          ` *`,
          ` * 分类：${r.category} ｜ 返回：${r.returns}`,
          params ? ` * ${params}` : '',
          ` *`,
          ` * \`\`\`js`,
          ` * ${r.example}`,
          ` * \`\`\``,
          aliases.length ? ` *` : '',
          aliases.length ? ` * 别名：${aliases.join(' / ')}` : '',
          ` */`,
        ]
          .filter((l) => l !== '')
          .join('\n');
      })
      .join('\n');
    for (const r of rows) {
      body.push(`${docs}\n    ${tsSignature(methodName, r)};`);
    }
  }

  return `/**\n * ${doc}\n */\ninterface ${name} {\n${body.join('\n\n')}\n}`;
}

function tsSignature(methodName: string, r: ApiMethod): string {
  const params = r.params.map((p) => `${safeParam(p.name)}: ${tsType(p.type, p.name)}`).join(', ');
  return `${safeName(methodName)}(${params}): ${tsReturn(r.returns)}`;
}

function safeName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function safeParam(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `p_${name.replace(/\W/g, '_')}`;
}

function tsType(type: string, paramName: string): string {
  switch (type) {
    case '选择器':
      return 'PlayerSelector';
    case '数字':
      return 'number';
    case '布尔':
      return 'boolean';
    default:
      break;
  }
  if (/amount|count|value|health|speed|amplifier|level/.test(paramName)) return 'number';
  return 'string';
}

function tsReturn(returns: string): string {
  if (/void/.test(returns)) return 'void';
  if (/\bint\b|long|秒数|数量|次数|人数|数$/.test(returns)) return 'number';
  if (/^boolean|是否/.test(returns)) return 'boolean';
  if (/ArrayList|List|列表/.test(returns)) return 'JavaList<string>';
  if (/Object|变量值/.test(returns)) return 'any';
  return 'string';
}

function builtinParams(name: string): string {
  switch (name) {
    case 'getVar':
      return 'name: string';
    case 'setVar':
      return 'name: string, value: any';
    case 'log':
      return 'message: string';
    case 'parseTime':
      return 'time: string';
    default:
      return '';
  }
}

function builtinReturn(name: string): string {
  switch (name) {
    case 'getVar':
      return 'any';
    case 'parseTime':
      return 'number';
    case 'playerName':
      return 'string';
    default:
      return 'void';
  }
}

const PLAYER_LIKE = `/** 玩家选择器：@all / @a / @trigger / @p / @others / @nearest / @random / @r 或玩家名 */
type PlayerSelector = string;

/** Java 列表快照：只能用 size() / get(i)，没有 forEach / length / join */
interface JavaList<T> {
  size(): number;
  get(index: number): T;
  isEmpty(): boolean;
  contains(value: T): boolean;
}

/** 触发者对象（Bukkit Player 的最小子集；player / trigger 在无触发者时不存在） */
interface PlayerLike {
  getName(): string;
  getHealth(): number;
  getLevel(): number;
  isDead(): boolean;
  isOnline(): boolean;
  getUniqueId(): string;
  getLocation(): unknown;
  sendMessage(message: string): void;
}`;
