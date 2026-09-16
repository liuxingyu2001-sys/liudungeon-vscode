/**
 * 副本目录索引：扫描工作区里所有副本目录，抽出“定义了哪些名字”，
 * 供补全（列出现有怪物组/区域/奖励）与诊断（引用是否存在）使用。
 *
 * 识别规则与插件一致：副本目录必须含有 config.yml，其余文件按文件名匹配；
 * 容器节点支持中英文别名（见 Keys.getSectionMap）。
 */
import { parseDocument, isMap, YAMLMap, YAMLSeq, Scalar } from 'yaml';
import {
  CONFIG_FILE_BY_NAME,
  CONFIG_DATA,
  baseName,
  dirOf,
  nodePathMatchesSafe,
} from './yaml-shared';

export interface Def {
  name: string;
  file: string;
  line: number;
  doc?: string;
}

export interface DungeonIndex {
  /** 副本目录 URI（不含末尾斜杠）。 */
  dir: string;
  /** 副本 ID（目录名）。 */
  id: string;
  /** 容器类型 → 名字列表。 */
  defs: Record<RefKind, Def[]>;
  /** 文件绝对路径 → 文件类型；用于按文件名分派补全。 */
  files: string[];
}

export type RefKind =
  | 'groups'
  | 'zones'
  | 'obstacles'
  | 'interacts'
  | 'stages'
  | 'tasks'
  | 'rewards'
  | 'points';

/** 每种引用的提示名（用于诊断消息）。 */
export const REF_LABEL: Record<RefKind, string> = {
  groups: '怪物组',
  zones: '区域',
  obstacles: '障碍物',
  interacts: '交互点',
  stages: '阶段',
  tasks: '任务',
  rewards: '奖励',
  points: '点位',
};

/** 每一种引用在哪个文件里定义。 */
const DEFINING_FILE: Record<RefKind, string> = {
  groups: 'monsters.yml',
  zones: 'zones.yml',
  obstacles: 'obstacles.yml',
  interacts: 'interacts.yml',
  stages: 'stages.yml',
  tasks: 'tasks.yml',
  rewards: 'rewards.yml',
  points: 'zones.yml',
};

/**
 * 全部引用类型。
 *
 * <p>遍历「所有种类」的地方（悬停找定义、诊断列举）请用它，不要就地写一份数组 ——
 * 之前 hover.ts 里硬编码的清单漏了 obstacles，新增类型时不会报错、只会静默少一项。
 */
export const ALL_REF_KINDS = Object.keys(DEFINING_FILE) as RefKind[];

/** 允许出现在副本目录里的文件（与 DungeonScaffold 的清单对齐）。 */
export const KNOWN_FILES = new Set(
  CONFIG_DATA.files.map((f) => f.file).concat(['说明.md', 'chest_rewards.yml', 'gui.yml']),
);

export class IndexStore {
  private byDir = new Map<string, DungeonIndex>();
  /** 文件路径 → 所属副本目录。 */
  private fileToDir = new Map<string, string>();

  /** 用一批文件重建索引（files 是绝对路径 + 文本）。 */
  rebuild(files: Array<{ path: string; text: string }>): void {
    this.byDir.clear();
    this.fileToDir.clear();

    // 先按目录分组
    const dirs = new Map<string, Array<{ path: string; text: string }>>();
    for (const f of files) {
      const dir = dirOf(f.path);
      if (!dir) continue;
      const list = dirs.get(dir) ?? [];
      list.push(f);
      dirs.set(dir, list);
    }

    for (const [dir, group] of dirs) {
      const names = new Set(group.map((f) => baseName(f.path)));
      // 副本目录的判定：目录里必须有 config.yml
      if (!names.has('config.yml')) continue;

      const defs: Record<RefKind, Def[]> = {
        groups: [],
        zones: [],
        obstacles: [],
        interacts: [],
        stages: [],
        tasks: [],
        rewards: [],
        points: [],
      };

      for (const kind of Object.keys(DEFINING_FILE) as RefKind[]) {
        const file = group.find((f) => baseName(f.path) === DEFINING_FILE[kind]);
        if (!file) continue;
        // 点位住在 zones.yml 的「区域.<区域名>.点位」里，容器别名必须按 zones 取；
        // 按 points 取会退回 ['points']，于是所有点位都收不到。
        const containerKind: RefKind = kind === 'points' ? 'zones' : kind;
        const containers = containerAliases(DEFINING_FILE[kind], containerKind);
        if (kind === 'points') {
          defs[kind] = collectPoints(file.text, file.path, containers);
        } else {
          defs[kind] = collectNames(file.text, file.path, containers);
        }
      }

      const index: DungeonIndex = {
        dir,
        id: baseName(dir),
        defs,
        files: group.map((f) => f.path).sort(),
      };
      this.byDir.set(dir, index);
      for (const f of group) this.fileToDir.set(f.path, dir);
    }
  }

  /** 单个文件更新（编辑器里改了内容但没保存时也能用）。 */
  upsert(filePath: string, text: string, knownFiles: Array<{ path: string; text: string }>): void {
    const next = knownFiles.filter((f) => f.path !== filePath);
    next.push({ path: filePath, text });
    this.rebuild(next);
  }

  dirForFile(filePath: string): string | undefined {
    return this.fileToDir.get(filePath);
  }

  /** 取某个文件所属副本的索引（含该文件的最新文本）。 */
  forFile(filePath: string): DungeonIndex | undefined {
    const dir = this.fileToDir.get(filePath);
    return dir ? this.byDir.get(dir) : undefined;
  }

  list(): DungeonIndex[] {
    return [...this.byDir.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 名字集合（同名去重），供补全使用。 */
  names(kind: RefKind, dir?: string): Def[] {
    if (dir) {
      return this.byDir.get(dir)?.defs[kind] ?? [];
    }
    const merged = new Map<string, Def>();
    for (const idx of this.byDir.values()) {
      for (const d of idx.defs[kind]) if (!merged.has(d.name)) merged.set(d.name, d);
    }
    return [...merged.values()];
  }

  /** 某个副本里是否定义了该名字。 */
  has(kind: RefKind, dir: string, name: string): boolean {
    return (this.byDir.get(dir)?.defs[kind] ?? []).some((d) => d.name === name);
  }
}

/**
 * 取某个文件的「容器别名」。
 *
 * 数据里的 containerAliases 形如 {"groups": ["groups","怪物组","waves","波次"]}；
 * 对 zones/interacts 这类“空文件默认写在根节点”的文件，根映射本身就是容器。
 *
 * <p><b>键必须是 {@link RefKind}（不是容器名）</b>。这条契约一度被写反：zones.yml
 * 那份写成了 `{"区域": [...]}` 而这里查的是 `['zones']`，于是查不到、静默退回 `[kind]`，
 * 结果「区域 / 交互 / 阶段」三类的名字一个都没进索引 —— 补全空白、引用校验全放行。
 * 这类笔误不会报错，所以由 harness 的用例 24 直接对数据文件断言，别只靠这里兜。
 */
export function containerAliases(file: string, kind: RefKind): string[] {
  const cfg = CONFIG_FILE_BY_NAME.get(file);
  const fromData = cfg?.containerAliases?.[kind];
  if (fromData && fromData.length) return fromData;
  return [kind];
}

/** 该文件的顶层容器下应当出现的节点前缀（用于把 nodes 归类）。 */
export { nodePathMatchesSafe };

// ==================================================================
//  YAML 遍历工具
// ==================================================================

function toPlain(node: unknown): unknown {
  if (node instanceof YAMLMap) {
    const out: Record<string, unknown> = {};
    for (const item of node.items) {
      const k = scalarText(item.key);
      if (k == null) continue;
      out[k] = toPlain(item.value);
    }
    return out;
  }
  if (node instanceof YAMLSeq) {
    return node.items.map((i) => toPlain(i));
  }
  if (node instanceof Scalar) return node.value;
  return node;
}

function scalarText(node: unknown): string | null {
  if (node instanceof Scalar) return String(node.value);
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return null;
}

/** 取映射里第一个命中别名的条目（返回节点与行号）。 */
function entryOfAlias(node: YAMLMap, aliases: string[]): { value: unknown; line: number } | null {
  for (const item of node.items) {
    const key = scalarText(item.key);
    if (key == null) continue;
    if (aliases.includes(key)) {
      return { value: item.value, line: keyLine(item.key) };
    }
  }
  return null;
}

function keyLine(node: unknown): number {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? range[0] : 0;
}

/** 行号（0 基）→ 位置（1 基）由调用方转换；这里返回 0 基行。 */
function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * 抽出一份 yml 里的“名字列表”（容器下的子键名）。
 * 找不到容器时返回空（不猜根节点，避免把配置项误当名字）。
 */
function collectNames(text: string, file: string, containers: string[]): Def[] {
  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length && !doc.contents) return [];
  const root = doc.contents;
  if (!isMap(root)) return [];

  let container: YAMLMap | null = null;
  for (const alias of containers) {
    const hit = entryOfAlias(root, [alias]);
    if (hit && hit.value instanceof YAMLMap) {
      container = hit.value;
      break;
    }
  }
  // zones.yml / interacts.yml 允许直接写在根节点。
  // 这里必须比 basename：file 是绝对路径，早先拿全路径跟 'zones.yml' 比，
  // 这个兜底从来没生效过（写根节点的文件一个名字都收不到）。
  const shortName = baseName(file);
  if (!container && (shortName === 'zones.yml' || shortName === 'interacts.yml')) {
    container = root;
  }
  if (!container) return [];

  const out: Def[] = [];
  for (const item of container.items) {
    const name = scalarText(item.key);
    if (name == null || name === '') continue;
    // 根节点兜底时跳过明显的配置段（避免把 名称/范围 当成区域名）
    if (container === root && /^(名称|范围|进入脚本|离开脚本|点位|参数|说明|type|name)$/.test(name)) {
      continue;
    }
    if (containers.includes(name)) continue;
    out.push({
      name,
      file,
      line: lineOf(text, keyLine(item.key)),
      doc: describeNode(item.value),
    });
  }
  return out;
}

function describeNode(value: unknown): string | undefined {
  if (value instanceof YAMLMap) {
    const hit = entryOfAlias(value, ['名称', 'name', '说明', 'description']);
    const txt = hit ? scalarText(hit.value) : null;
    if (txt) return txt;
  }
  return undefined;
}

/** zones.yml 的命名点位：区域 → 点位 → 名字，引用写法是 `区域.点位`。 */
function collectPoints(text: string, file: string, containers: string[]): Def[] {
  const doc = parseDocument(text);
  const root = doc.contents;
  if (!isMap(root)) return [];
  let zoneMap: YAMLMap | null = null;
  for (const alias of containers) {
    const hit = entryOfAlias(root, [alias]);
    if (hit?.value instanceof YAMLMap) {
      zoneMap = hit.value;
      break;
    }
  }
  if (!zoneMap) zoneMap = root;

  const out: Def[] = [];
  for (const zoneItem of zoneMap.items) {
    const zoneName = scalarText(zoneItem.key);
    if (zoneName == null) continue;
    if (!(zoneItem.value instanceof YAMLMap)) continue;
    const pointHit = entryOfAlias(zoneItem.value, ['点位', 'points']);
    if (!pointHit || !(pointHit.value instanceof YAMLMap)) continue;
    for (const p of pointHit.value.items) {
      const pName = scalarText(p.key);
      if (pName == null) continue;
      out.push({
        name: `${zoneName}.${pName}`,
        file,
        line: lineOf(text, keyLine(p.key)),
        doc: `区域「${zoneName}」的命名点位`,
      });
    }
  }
  return out;
}

export { toPlain, baseName, dirOf };
