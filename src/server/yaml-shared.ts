/**
 * 小工具集合：路径模板匹配、文件名判定、缩进解析。
 *
 * 这里刻意不放任何状态，便于被 context / completion / diagnostics 三个模块共用。
 */
import { CONFIG_FILE_BY_NAME, CONFIG_DATA, PLUGIN_CONFIG_DATA, type ConfigNode } from './api-model';

export { CONFIG_FILE_BY_NAME, CONFIG_DATA };
export type { ConfigNode };

const PLACEHOLDER = /^<.+>$/;

/**
 * 插件主配置在键名数据里的**合成名**。
 *
 * <p>`plugins/liudungeon/config.yml` 与副本目录里的 `config.yml` 同名，但键名毫无交集
 * （前者是 database / cross-server / statistics，后者是 enable / world / requirements）。
 * 数据里必须用两个不同的键，而 basename 只有一个 —— 于是给主配置起了这个合成名，
 * 由 {@link schemaKeyFor} 按路径判定。它永远不会与真实文件名撞上。
 */
export const PLUGIN_CONFIG_SCHEMA = PLUGIN_CONFIG_DATA.file;

/** 给人看的名字（补全详情的 `${文件} · 类型`、悬停标题）。 */
export function schemaLabel(schemaKey: string): string {
  return schemaKey === PLUGIN_CONFIG_SCHEMA ? '插件主配置' : schemaKey;
}

/**
 * 目录判定器：由 {@link import('./index-store').IndexStore} 实现。
 *
 * <p>这里只声明需要的那两个方法（而不是 import IndexStore）—— index-store 反过来依赖
 * 本模块，直接互相 import 会成环。
 */
export interface DirClassifier {
  /** 工作区快照里见过这个目录吗。 */
  knowsDir(dir: string): boolean;
  /** 这个目录被索引认成副本目录了吗（含有 config.yml，且不是插件根）。 */
  isDungeonDir(dir: string): boolean;
}

/**
 * 这份文件该用哪一份键名数据。
 *
 * <p>除 `config.yml` 之外全部就是 basename（monsters.yml → monsters.yml）。
 * 只有 `config.yml` 需要判断：
 * <ul>
 *   <li>目录在索引里 → 以索引为准：**被认成副本目录的**才是副本配置，其余（插件根
 *       `plugins/liudungeon/`、插件源码里的 `src/main/resources/`）都是主配置。</li>
 *   <li>目录不在索引里（单开的文件、还没同步进工作区）→ 退回按路径形状判断：
 *       目录名 `liudungeon` 且不在 `dungeons/` 之下，就是插件根。</li>
 * </ul>
 *
 * <p>判错的代价不对称，所以两边都判：把主配置当成副本配置 → 顶层补全给的是副本的键，
 * 还会把 server-id / cross-server / statistics 报成「插件不读的键」（实测 22 条误报）；
 * 把副本配置当成主配置 → 那一个副本的 config.yml 没有补全与键名诊断。
 */
export function schemaKeyFor(filePath: string, index?: DirClassifier): string {
  const base = baseName(filePath);
  if (base !== 'config.yml') return base;
  const dir = dirOf(filePath);
  if (index?.knowsDir(dir)) {
    return index.isDungeonDir(dir) ? base : PLUGIN_CONFIG_SCHEMA;
  }
  return looksLikePluginRoot(filePath) ? PLUGIN_CONFIG_SCHEMA : base;
}

/** 路径形状判断：`.../liudungeon/config.yml`（且不在 dungeons/ 之下）。 */
function looksLikePluginRoot(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  if (i <= 0) return false;
  const dir = p.slice(0, i);
  if (baseName(dir) !== 'liudungeon') return false;
  return !/(^|\/)dungeons\//.test(dir + '/');
}

/**
 * 副本目录里出现这些文件，就说明它是**副本目录**而不是插件根 ——
 * 插件根下只有 config.yml / gui.yml / data.db 与 dungeons、maps 两个子目录。
 * 给 {@link import('./index-store').IndexStore} 判定插件根兜底用。
 */
export const DUNGEON_CONTENT_FILES: readonly string[] = [
  'monsters.yml',
  'zones.yml',
  'stages.yml',
  'interacts.yml',
  'obstacles.yml',
  'tasks.yml',
  'rewards.yml',
  'chest_rewards.yml',
  'scripts.yml',
  'functions.js',
];

/**
 * 每个文件里「一种写法 → 数据里的规范写法」。
 *
 * <p>插件对同一个位置普遍有多种写法（`障碍物` / `obstacles`、`关闭时` / `on_create` /
 * `创建时`），数据里只记一种为规范名。**只做字面量比较的匹配会把别名写法整个判成不匹配** ——
 * 表现是「用别名写的文件，那一层往下全都没有补全与悬停」：实测 obstacles.yml 写成
 * `obstacles:` 时，障碍物里的 7 个键一个都补不出来；monsters.yml 写成 `怪物组:`、
 * zones.yml 写成 `zones:` 同样全空。所以匹配前先把实际路径按这张表归一化。
 */
const SPELLING_CACHE = new Map<string, Map<string, string>>();

/** 该文件的「写法 → 规范名」表。 */
export function canonicalSpellings(file: string): Map<string, string> {
  const cached = SPELLING_CACHE.get(file);
  if (cached) return cached;

  const map = new Map<string, string>();
  const cfg = CONFIG_FILE_BY_NAME.get(file);
  if (cfg) {
    const pathSegments = new Set<string>();
    for (const n of cfg.nodes) for (const s of splitPath(n.path)) pathSegments.add(s);

    // 1) 容器别名（containerAliases）：一组写法互相等价，规范名取「数据路径里真用到的那个」
    for (const list of Object.values(cfg.containerAliases ?? {})) {
      if (!list.length) continue;
      const canonical = list.find((s) => pathSegments.has(s)) ?? list[0];
      for (const s of list) map.set(s, canonical);
    }
    // 2) 节点自己的别名
    for (const n of cfg.nodes) for (const a of n.aliases ?? []) if (a) map.set(a, n.key);
    // 3) 节点主键永远指向自己（最后写，压过别名层：`区域` 既是容器名也是某个子键时以主键为准）
    for (const n of cfg.nodes) if (n.key && !n.key.includes('<')) map.set(n.key, n.key);
  }
  SPELLING_CACHE.set(file, map);
  return map;
}

/**
 * 该文件里「可以省略不写」的容器段名（没有就返回 null）。
 *
 * <p>插件对 zones / stages / obstacles / interacts / tasks / chest_rewards 的解析都是
 * 「先找容器节，找不到就把根下每个键当条目」—— <b>两种写法都合法</b>。
 * 游戏内编辑器新建条目走的是根级写法，所以扩展必须把「少了外层容器」认成同一个位置，
 * 否则整棵子树都不认（补全/悬停空、还会误报「插件不读的键」）。
 */
const OPTIONAL_CONTAINER_CACHE = new Map<string, string | null>();

export function optionalContainerSegment(file: string): string | null {
  const cached = OPTIONAL_CONTAINER_CACHE.get(file);
  if (cached !== undefined) return cached;
  const cfg = CONFIG_FILE_BY_NAME.get(file);
  let hit: string | null = null;
  if (cfg?.containerOptional) {
    const pathSegments = new Set<string>();
    for (const n of cfg.nodes) for (const s of splitPath(n.path)) pathSegments.add(s);
    for (const list of Object.values(cfg.containerAliases ?? {})) {
      const canonical = list.find((s) => pathSegments.has(s));
      if (canonical) {
        hit = canonical;
        break;
      }
    }
  }
  OPTIONAL_CONTAINER_CACHE.set(file, hit);
  return hit;
}

/**
 * 判断一个「数据里的路径模板」是否匹配（某个文件里）「编辑器的实际路径」。
 *
 * <p>模板段 `<组ID>` / `[]` 视为通配一段；其余段按 {@link canonicalSpellings} 归一化后比较，
 * 所以 `obstacles.出生点屏障.区域` 与数据里的 `障碍物.<障碍物ID>.区域` 是匹配的。
 * 给不出文件（拿不到数据）时退化为纯字面量比较。
 *
 * <p>容器可省略的文件（{@link optionalContainerSegment}）另外允许模板<b>少一段外层容器</b>：
 * 数据里的 `区域.<区域ID>.范围` 也得匹配实际写的 `<区域ID>.范围`。
 */
export function nodePathMatches(file: string, pattern: string, concrete: string): boolean {
  if (isRootPath(pattern) || isRootPath(concrete)) {
    return isRootPath(pattern) && isRootPath(concrete);
  }
  const optional = optionalContainerSegment(file);
  if (optional) {
    const segs = pattern.split('.');
    const canon = canonicalSpellings(file);
    const head = canon?.get(segs[0]) ?? segs[0];
    const c0 = concrete.split('.')[0];
    const concreteHead = canon?.get(c0) ?? c0;
    // 只在**实际路径里没有外层容器**时才允许少这一段。
    // 少了 `concreteHead !== optional` 这个条件会出事：容器本身（写 `tasks:` /
    // `障碍物:` 的那一行）也会被当成"条目 ID"命中 `<任务名>`，于是容器下那一层的
    // 键全被换成条目的字段，任务名/障碍物名反而被报成"插件不读的键"。
    if (segs.length > 1 && head === optional && concreteHead !== optional
        && nodePathMatches(file, segs.slice(1).join('.'), concrete)) {
      return true;
    }
  }
  const p = pattern.split('.').map((s) => s.replace(/\[\]$/, ''));
  const c = concrete.split('.').map((s) => s.replace(/\[\]$/, '')).filter((s) => s !== '');
  if (p.length !== c.length) return false;
  const canon = file ? canonicalSpellings(file) : null;
  for (let i = 0; i < p.length; i++) {
    const patternSeg = p[i];
    const concreteSeg = c[i];
    if (patternSeg === concreteSeg) continue;
    if (PLACEHOLDER.test(patternSeg) || patternSeg === '[]') continue;
    if (canon && (canon.get(concreteSeg) ?? concreteSeg) === patternSeg) continue;
    return false;
  }
  return true;
}

/**
 * 顶层键的匹配：pattern 与 concrete 都是空串（父路径为空 = 根映射）。
 *
 * <p>不特判会出大问题：`''.split('.')` 得到 `['']`（长度 1），于是根层级的匹配
 * 永远失败 —— 表现为**所有 yml 的顶层键都没有补全**（config.yml 的 enable、dungeon、
 * monsters.yml 的 groups …）。这个 bug 一开始被"monsters.yml 特殊回落"掩盖了，
 * 修好匹配后才暴露出来。
 */
function isRootPath(s: string): boolean {
  return s.trim() === '';
}

/** 该模板段是不是通配段。 */
export function isPlaceholderSegment(seg: string): boolean {
  return PLACEHOLDER.test(seg) || seg === '[]';
}

/** 归一化路径（去掉列表标记），便于比较。 */
export function normalizePath(path: string): string {
  return path
    .split('.')
    .map((s) => s.replace(/\[\]$/, ''))
    .join('.');
}

/** 取一个 key 的所有可接受写法（主名 + 别名）。 */
export function keySpellings(node: { key: string; aliases?: string[] }): string[] {
  return [node.key, ...(node.aliases ?? [])].filter(Boolean);
}

/** 把 `groups.<组ID>.monsters[].id` 切成段（去列表标记）。 */
export function splitPath(path: string): string[] {
  return path
    .split('.')
    .map((s) => s.replace(/\[\]$/, ''))
    .filter((s) => s !== '');
}

/**
 * 这个文件名是副本配置目录里的文件吗（插件真的会读的那些）。
 *
 * <p>原来这里是一串硬编码的文件名，漏了 `obstacles.yml` —— 于是任何"按文件名放行"的
 * 地方都会静默跳过障碍物文件。改成从键名数据反推：数据里有哪几份文件，就是哪几份
 * （`gui.yml` 单独列出，它由 GuiConfig 读，不在 CONFIG_DATA 里）。
 */
export function isDungeonFileName(name: string): boolean {
  if (name === 'gui.yml') return true;
  return name !== PLUGIN_CONFIG_SCHEMA && CONFIG_FILE_BY_NAME.has(name);
}

/** 取路径末段（跨平台）。 */
export function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

/** 取路径目录（跨平台）。 */
export function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i <= 0 ? '' : norm.slice(0, i);
}

/** 把行内偏移换算成 0 基行号。 */
export function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}
