/**
 * 小工具集合：路径模板匹配、文件名判定、缩进解析。
 *
 * 这里刻意不放任何状态，便于被 context / completion / diagnostics 三个模块共用。
 */
export { CONFIG_FILE_BY_NAME, CONFIG_DATA, type ConfigNode } from './api-model';

const PLACEHOLDER = /^<.+>$/;

/**
 * 判断一个「数据里的路径模板」是否匹配「编辑器里的实际路径」。
 * 模板段 `<组ID>` / `[]` 视为通配一段。
 */
export function nodePathMatchesSafe(pattern: string, concrete: string): boolean {
  const p = pattern.split('.').map((s) => s.replace(/\[\]$/, ''));
  const c = concrete.split('.').filter((s) => s !== '');
  if (p.length !== c.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === c[i]) continue;
    if (PLACEHOLDER.test(p[i]) || p[i] === '[]') continue;
    return false;
  }
  return true;
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
