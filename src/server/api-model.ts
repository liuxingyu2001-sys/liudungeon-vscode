/**
 * 数据模型：把从插件源码与文档里提取出的参考数据（data/*.json）规整成补全用的结构。
 *
 * 三份数据来源：
 *   action-methods.json   ActionApi.java  → action.* 全部方法 + 选择器 + 文本占位符
 *   dungeon-methods.json  DungeonApi.java → dungeon.* 全部只读查询方法
 *   config-files.json     各 yml 的键名、生命周期钩子、条件关键词与求值位置
 */
import actionRaw from '../../data/action-methods.json';
import dungeonRaw from '../../data/dungeon-methods.json';
import configRaw from '../../data/config-files.json';

export interface ApiParam {
  name: string;
  type: string;
  doc: string;
}

export interface ApiMethod {
  name: string;
  signature: string;
  params: ApiParam[];
  returns: string;
  doc: string;
  category: string;
  aliases: string[];
  example: string;
}

export interface ApiValue {
  value: string;
  doc: string;
}

export interface ApiFile {
  namespace: string;
  methods: ApiMethod[];
  selectors: ApiValue[];
  placeholders: ApiValue[];
}

export interface ConfigNode {
  path: string;
  key: string;
  type: string;
  doc: string;
  values?: string[];
  aliases?: string[];
  required?: boolean;
}

export interface ConfigFile {
  file: string;
  title: string;
  summary: string;
  containerAliases?: Record<string, string[]>;
  /**
   * 这个文件的「条目」可以直接写在根上（不带外层容器）。
   *
   * <p>插件解析器对 zones / stages / obstacles / interacts / tasks / chest_rewards 都是
   * 「先找容器节，找不到就把根下每个键当条目」（{@code DungeonRegistry.parse*} 里的
   * {@code if (raw.isEmpty()) raw = Keys.getSectionMap(yml);}），而 monsters.yml
   * **没有**这条回退 —— 所以这个标记按文件给，不能一刀切。
   */
  containerOptional?: boolean;
  example: string;
  nodes: ConfigNode[];
}

export interface ScriptHook {
  name: string;
  doc: string;
  hasTrigger: boolean;
  example: string;
}

export interface ConditionLocation {
  file: string;
  path: string;
  doc: string;
}

export interface ConfigData {
  files: ConfigFile[];
  scriptHooks: ScriptHook[];
  conditions: {
    locations: ConditionLocation[];
    keywords: { cn: string; js: string }[];
  };
}

export const ACTION_API = actionRaw as unknown as ApiFile;
export const DUNGEON_API = dungeonRaw as unknown as ApiFile;
export const CONFIG_DATA = configRaw as unknown as ConfigData;

/** 命名的全局对象（脚本里可直接引用）。 */
export interface GlobalObject {
  name: string;
  doc: string;
  /** 哪些场景下不存在（用于诊断提示）。 */
  missingWhen?: string;
}

export const GLOBAL_OBJECTS: GlobalObject[] = [
  {
    name: 'action',
    doc: '动作 API：消息、刷怪、传送、奖励、流程控制等全部动作',
    missingWhen: '总是注入（实例为空时大部分方法内部直接 return，不报错）',
  },
  {
    name: 'dungeon',
    doc: '状态查询 API：玩家数、怪物组、区域、阶段、复活、变量（只读）',
    missingWhen: '总是注入',
  },
  {
    name: 'player',
    doc: '触发者 Bukkit Player 对象（没有触发者时该名字不存在）',
    missingWhen: 'complete / fail / exit / all_death 钩子、怪物组 condition、条目 when、阶段脚本与条件、定时与循环任务',
  },
  {
    name: 'trigger',
    doc: '与 player 是同一个对象的兼容名',
    missingWhen: '同 player',
  },
];

/** 脚本里可直接调用的内置函数（由 BUILTIN_PRELUDE 展开）。 */
export interface BuiltinFn {
  name: string;
  signature: string;
  returns: string;
  doc: string;
  example: string;
}

export const BUILTIN_FUNCTIONS: BuiltinFn[] = [
  {
    name: 'getVar',
    signature: 'getVar(name)',
    returns: '变量值（不存在时返回数字 0）',
    doc: '读脚本变量；变量作用域是本次副本实例，出本即销毁',
    example: "var n = getVar('已开箱数')",
  },
  {
    name: 'setVar',
    signature: 'setVar(name, value)',
    returns: 'void',
    doc: '写脚本变量；value 为 null 等价于删除该变量',
    example: "setVar('已开箱数', getVar('已开箱数') + 1)",
  },
  {
    name: 'log',
    signature: 'log(message)',
    returns: 'void',
    doc: '打印控制台日志，前缀 [脚本]',
    example: "log('阶段推进到 ' + dungeon.getStageName())",
  },
  {
    name: 'parseTime',
    signature: 'parseTime(str)',
    returns: 'long（tick）',
    doc: '把 3s / 5m / 2h / 100t / 500ms 这类时间字符串换成 tick',
    example: "action.wait('3s')",
  },
  {
    name: 'playerName',
    signature: 'playerName()',
    returns: '触发者名字；无触发者返回空串',
    doc: '安全地取触发者名字，等价于 typeof player !== "undefined" ? player.getName() : ""',
    example: "action.message('@all', playerName() + ' 拿到了钥匙')",
  },
];

/** 时间字符串的合法写法（Text.parseTime*）。 */
export const TIME_FORMATS: ApiValue[] = [
  { value: '3s', doc: '3 秒（等价于 3秒）' },
  { value: '3秒', doc: '3 秒' },
  { value: '5m', doc: '5 分钟（等价于 5分 / 5min）' },
  { value: '2h', doc: '2 小时（等价于 2时）' },
  { value: '100t', doc: '100 tick（按 20/s 折算为 5 秒）' },
  { value: '500ms', doc: '500 毫秒' },
  { value: '90', doc: '纯数字按秒处理' },
];

/** 所有方法名 → 方法定义（含别名），用于诊断“方法是否存在”。 */
export const ACTION_METHODS: Map<string, ApiMethod> = buildMethodMap(ACTION_API.methods);
export const DUNGEON_METHODS: Map<string, ApiMethod> = buildMethodMap(DUNGEON_API.methods);

/**
 * 构建「名字 → 方法」表。
 *
 * 同名重载（grant_reward 有 1 参 / 2 参两个版本）必须挑参数最多的那个：
 * Map.set 是覆盖语义，如果按数据顺序无脑 set，先写入的 2 参版本会被 1 参版本覆盖，
 * 于是诊断会误报「最多接受 1 个参数」。
 */
function buildMethodMap(list: ApiMethod[]): Map<string, ApiMethod> {
  const map = new Map<string, ApiMethod>();
  const put = (name: string, m: ApiMethod) => {
    const exist = map.get(name);
    if (!exist || m.params.length > exist.params.length) map.set(name, m);
  };
  for (const m of list) {
    put(m.name, m);
    for (const alias of m.aliases ?? []) {
      put(alias, { ...m, name: alias, doc: `${m.doc}（${m.name} 的别名）` });
    }
  }
  return map;
}

/** 同名重载的全部版本（补全要每个签名给一条）。 */
export const ACTION_OVERLOADS: Map<string, ApiMethod[]> = groupOverloads(ACTION_API.methods);
export const DUNGEON_OVERLOADS: Map<string, ApiMethod[]> = groupOverloads(DUNGEON_API.methods);

function groupOverloads(list: ApiMethod[]): Map<string, ApiMethod[]> {
  const map = new Map<string, ApiMethod[]>();
  for (const m of list) {
    const rows = map.get(m.name) ?? [];
    rows.push(m);
    map.set(m.name, rows);
  }
  return map;
}

/** 选择器集合（含中文别名与未实现的 @party）。 */
export const SELECTORS: Map<string, string> = new Map(
  ACTION_API.selectors.map((s) => [s.value, s.doc]),
);

/** 文本占位符集合。 */
export const PLACEHOLDERS: Map<string, string> = new Map(
  ACTION_API.placeholders.map((p) => [p.value, p.doc]),
);

/** 条件关键词（中文 → JS）。 */
export const CONDITION_KEYWORDS = CONFIG_DATA.conditions.keywords;

/** 按文件名取配置说明。 */
export const CONFIG_FILE_BY_NAME: Map<string, ConfigFile> = new Map(
  CONFIG_DATA.files.map((f) => [f.file, f]),
);

/** 生命周期钩子名集合（含连字符写法）。 */
export const HOOK_NAMES: Map<string, ScriptHook> = buildHookMap();

function buildHookMap(): Map<string, ScriptHook> {
  const map = new Map<string, ScriptHook>();
  for (const h of CONFIG_DATA.scriptHooks) {
    map.set(h.name, h);
    if (h.name.includes('_')) {
      map.set(h.name.replace(/_/g, '-'), h);
    }
  }
  return map;
}

/**
 * 「写了不会执行」的钩子。
 *
 * 留空是有意的：`complete` / `fail` 曾经因为 `setState(...)` 排在 `scripts.xxx()` 之前，
 * 被 `ScriptEngine.eval` 的终态守卫静默丢弃（插件 1.0.5 已修复：先跑脚本、再切终态）。
 * 若以后又发现同一类「钩子永远不跑」的问题，在这里登记名字 + 原因即可，
 * 补全与悬停会自动把它标出来。
 */
export const DEAD_HOOKS: Map<string, string> = new Map();

/** 所有 action.* 前缀。 */
export const ACTION_PREFIX = 'action.';
export const DUNGEON_PREFIX = 'dungeon.';

/**
 * 脚本字段的示例按**统一排版**渲染：`|-` 块 + 一行一条 + 行尾加分号。
 *
 * 为什么要有这个函数：补全、悬停、代码片段三处都要显示"这个钩子怎么写"，
 * 以前各自拼 `键:\n  - "语句"` 的列表写法 —— 那是老写法，服主照着抄会得到
 * 一堆要自己补引号的行。排版规则见插件文档《07-脚本开发指南》7.1.1。
 */
export function scriptBlockLines(key: string, example: string): string[] {
  const stmt = example.trim().replace(/;\s*$/, '');
  return [`${key}: |-`, `  ${stmt};`];
}
