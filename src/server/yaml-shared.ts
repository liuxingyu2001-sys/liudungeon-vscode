/**
 * 小工具集合：路径模板匹配、文件名判定、缩进解析。
 *
 * 这里刻意不放任何状态，便于被 context / completion / diagnostics 三个模块共用。
 */
import { CONFIG_FILE_BY_NAME, CONFIG_DATA, type ConfigNode } from './api-model';

export { CONFIG_FILE_BY_NAME, CONFIG_DATA };
export type { ConfigNode };

const PLACEHOLDER = /^<.+>$/;

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

/** 该文件的所属副本里的其它文件列表（供诊断提示）。 */
export function isDungeonFileName(name: string): boolean {
  return /^(config|monsters|scripts|rewards|zones|interacts|tasks|stages|chest_rewards|gui)\.ya?ml$/.test(
    name,
  ) || name === 'functions.js';
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
