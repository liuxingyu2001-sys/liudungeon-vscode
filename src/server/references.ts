/**
 * 符号引用引擎：把「这个组名 / 区域名 / 奖励名在哪里被用到」找出来。
 *
 * 这是跳转定义、查找引用、重命名、同词高亮四件事的共同底座 ——
 * 之前只有定义索引（index-store），引用位置是现算的，所以这四件事都做不了。
 *
 * 判定规则严格照插件运行期的真实引用形态写（而不是"字符串相等就算"）：
 *   - monsters.yml 的 trigger_group / group
 *   - 脚本里的 action.spawn_group('x')、action.grant_reward('@all','x')、
 *     dungeon.isGroupCleared('x') 这类具名参数
 *   - 区域/点位的字符串字面量
 * 这样才不会把注释里、文案里恰好同名的字符串误认成引用。
 */
import { Location, Position, Range } from 'vscode-languageserver';
import { IndexStore, RefKind, REF_LABEL } from './index-store';
import { baseName } from './yaml-shared';

export interface RefHit {
  file: string;
  uri: string;
  line: number;
  start: number;
  length: number;
  /** true = 定义处本身。 */
  isDefinition: boolean;
  kind: RefKind;
  name: string;
}

export interface SymbolAtCursor {
  kind: RefKind;
  name: string;
  dir: string;
  /** 光标所在的词范围（重命名时替换这个范围）。 */
  range: Range;
}

/** 每种符号定义在哪个文件里（索引里的 file 字段就是 basename）。 */
const DEF_FILE: Record<RefKind, string> = {
  groups: 'monsters.yml',
  zones: 'zones.yml',
  interacts: 'interacts.yml',
  rewards: 'rewards.yml',
  stages: 'stages.yml',
  tasks: 'tasks.yml',
  points: 'zones.yml',
};

/** 每种符号允许出现的位置：YAML 键 + 脚本 API 的方法名（字符串参数里）。 */
const RULES: Record<RefKind, { yamlKeys: string[]; jsMethods: string[] }> = {
  groups: {
    yamlKeys: ['trigger_group', 'group', '触发组', '分组'],
    jsMethods: [
      'spawn_group',
      'monster_group',
      'random_spawn_group',
      'random_monster_group',
      'stop_repeat',
      'cancel_group',
      'clear_group',
      'skip_group',
      'wait_clear',
      'getAliveMonsterCount',
      'isGroupCleared',
      'isGroupActive',
      'getGroupSpawned',
      'getGroupKilled',
      'getRepeatCount',
      'isBossKilled',
    ],
  },
  zones: {
    yamlKeys: [
      'zone',
      '区域',
      '进入区域',
      '离开区域',
      '区域名称',
      'teleport_zone',
      '默认开启',
      '范围',
    ],
    jsMethods: [
      'enable_zone',
      'disable_zone',
      'teleport_zone',
      'getZone',
      'getZoneName',
      'getZones',
      'isInZone',
      'getZonePlayerCount',
      'isZoneEnabled',
    ],
  },
  interacts: {
    yamlKeys: ['interact', 'interact_id', '交互', '交互点'],
    jsMethods: ['trigger_interact'],
  },
  rewards: {
    yamlKeys: ['reward', 'reward_name', '奖励', 'sweep.reward'],
    jsMethods: ['grant_reward', 'reward'],
  },
  stages: {
    yamlKeys: ['stage', '阶段', 'goto', '入口', '目标'],
    jsMethods: ['goto_stage', 'restart_stage'],
  },
  tasks: {
    yamlKeys: ['task', '任务'],
    jsMethods: [],
  },
  points: {
    yamlKeys: ['落点', 'point', '点位'],
    jsMethods: ['teleport_point'],
  },
};

/** 由 kind 反查：某个 YAML 键名属于哪种符号（用来在键值位置识别引用）。 */
export function kindOfYamlKey(key: string): RefKind[] {
  const out: RefKind[] = [];
  for (const kind of Object.keys(RULES) as RefKind[]) {
    const keys = RULES[kind].yamlKeys;
    if (keys.some((k) => k === key || k.endsWith('.' + key))) out.push(kind);
  }
  return out;
}

/**
 * 在一行里找出所有字符串字面量。返回内容与在行内的起始列
 * （列指向引号**内部**的第一个字符）。
 */
export function stringLiterals(line: string): Array<{ value: string; start: number }> {
  const out: Array<{ value: string; start: number }> = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push({ value: m[2], start: m.index + 1 });
  }
  return out;
}

/**
 * YAML 值位置的候选片段：既支持带引号的写法，也支持裸标量。
 *
 * <p>必须两种都认：`trigger_group: wave_1`（裸标量）在真实配置里非常常见，
 * 只扫引号字符串会导致这种引用被整条漏掉 —— 表现就是"查找引用少一处、
 * 重命名漏改一处"，而且不报错。
 */
export function yamlValueCandidates(
  value: string,
  offset: number,
): Array<{ value: string; start: number }> {
  const out: Array<{ value: string; start: number }> = [];

  // 带引号：'wave_1' / "wave_1"
  for (const lit of stringLiterals(value)) {
    out.push({ value: lit.value, start: offset + lit.start });
  }

  // 裸标量：取第一个非引号 token，遇到 # 注释或逗号/方括号截断
  const bare = /^\s*([^\s#'"\[\],{}]+)/.exec(value);
  if (bare) {
    out.push({ value: bare[1], start: offset + (bare[0].length - bare[1].length) });
  }
  return out;
}

/** 该行是不是注释行（YAML 注释或 JS 行注释）。 */
function isCommentLine(line: string): boolean {
  return /^\s*(#|\/\/)/.test(line);
}

/**
 * 遍历所有已知文件，找出所有引用（含定义处）。
 *
 * @param files 全部文件（路径 + 文本）
 */
export function findReferences(
  index: IndexStore,
  files: Array<{ path: string; text: string }>,
  dir: string,
  kind: RefKind,
  name: string,
): RefHit[] {
  const hits: RefHit[] = [];
  const rules = RULES[kind];

  // 定义处。注意不能用「文件必须在扫描集合里」当条件 ——
  // 索引里的 file 是 basename（`monsters.yml`），调用方传进来的集合未必包含它，
  // 那种写法会把定义处整条丢掉（重命名时就少改一处）。
  const defFile = index.list().find((i) => i.dir === dir)?.files.find((f) => baseName(f) === DEF_FILE[kind]);
  for (const def of index.names(kind, dir)) {
    if (def.name !== name) continue;
    const defLineText = defFile
      ? (files.find((f) => f.path === defFile)?.text ?? '').split(/\r?\n/)[def.line] ?? ''
      : '';
    const indent = defLineText.length - defLineText.trimStart().length;
    const at = defLineText ? Math.max(indent, defLineText.indexOf(def.name, indent)) : 0;
    hits.push({
      file: defFile ?? `${dir}/${DEF_FILE[kind]}`,
      uri: '',
      line: def.line,
      start: at >= 0 ? at : 0,
      length: name.length,
      isDefinition: true,
      kind,
      name,
    });
  }

  const names = new Set(
    index.names(kind, dir).map((d) => d.name).filter((n) => n === name),
  );
  if (!names.size) return hits;

  const scanList = [...files];
  if (defFile && !scanList.some((f) => f.path === defFile)) {
    // 调用方只推了"打开的文件"时，定义文件可能不在里面 —— 补上，
    // 否则同一份文件里的 trigger_group 这类引用会被漏掉。
    scanList.push({ path: defFile, text: '' });
  }

  for (const f of scanList) {
    if (index.dirForFile(f.path) !== dir) continue;
    if (!/\.(ya?ml|js|lds)$/.test(baseName(f.path))) continue;
    const lines = f.text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      // ---- 1) YAML 键：`trigger_group: wave_1` ----
      const yamlKey = /^(\s*-?\s*)([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*)\s*:\s*(.+)$/.exec(line);
      if (yamlKey && rules.yamlKeys.includes(yamlKey[2])) {
        const valueStart = line.indexOf(yamlKey[3], yamlKey[0].indexOf(yamlKey[2]) + yamlKey[2].length);
        for (const lit of yamlValueCandidates(line.slice(valueStart), valueStart)) {
          if (!names.has(lit.value)) continue;
          hits.push({
            file: f.path,
            uri: '',
            line: i,
            start: lit.start,
            length: lit.value.length,
            isDefinition: false,
            kind,
            name,
          });
        }
      }

      // ---- 2) 脚本里的具名参数：action.spawn_group('wave_1') ----
      if (rules.jsMethods.length) {
        for (const method of rules.jsMethods) {
          const call = new RegExp(
            `(?:action|dungeon)\\s*\\.\\s*${method}\\s*\\(([^)]*)\\)`,
            'g',
          );
          let m: RegExpExecArray | null;
          while ((m = call.exec(line)) !== null) {
            const argsText = m[1];
            const argsOffset = m.index + m[0].indexOf(argsText);
            for (const lit of stringLiterals(argsText)) {
              // 选择器不是符号引用
              if (lit.value.startsWith('@') || lit.value.includes('{')) continue;
              if (!names.has(lit.value)) continue;
              hits.push({
                file: f.path,
                uri: '',
                line: i,
                start: argsOffset + lit.start,
                length: lit.value.length,
                isDefinition: false,
                kind,
                name,
              });
            }
          }
        }
      }

      // ---- 3) 点位：`区域.点位` 的字面量 ----
      if (kind === 'points') {
        for (const lit of stringLiterals(line)) {
          if (!lit.value.includes('.')) continue;
          if (!names.has(lit.value)) continue;
          hits.push({
            file: f.path,
            uri: '',
            line: i,
            start: lit.start,
            length: lit.value.length,
            isDefinition: false,
            kind,
            name,
          });
        }
      }
    }
  }

  // 去重（同一个位置可能被多条规则命中）
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.file}:${h.line}:${h.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 光标位置上的符号（若有）。
 *
 * 判定顺序：先看是不是定义键（容器下的子键），再看它在哪个引用规则的键/参数里。
 */
export function symbolAt(
  index: IndexStore,
  filePath: string,
  lines: string[],
  position: Position,
): SymbolAtCursor | null {
  const dir = index.dirForFile(filePath);
  if (!dir) return null;
  const line = lines[position.line] ?? '';
  const fileName = baseName(filePath);

  // 直接命中某个名字（键名位置 = 定义处）
  const word = wordAt(line, position.character);
  if (!word) return null;

  const kinds: RefKind[] = ['groups', 'zones', 'rewards', 'stages', 'interacts', 'tasks', 'points'];
  for (const kind of kinds) {
    const def = index.names(kind, dir).find((d) => d.name === word.word);
    if (!def) continue;
    // 定义处：必须在定义它的文件里
    if (def.file === fileName) {
      return { kind, name: word.word, dir, range: wordRange(position.line, word) };
    }
  }

  // 引用处：看这行用的是哪个键 / 哪个方法
  const yamlKey = /^\s*-?\s*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*)\s*:/.exec(line);
  const candidates: RefKind[] = [];
  if (yamlKey) {
    for (const kind of kinds) {
      if (RULES[kind].yamlKeys.includes(yamlKey[1])) candidates.push(kind);
    }
  }
  const method = /(?:action|dungeon)\s*\.\s*([A-Za-z_][\w]*)\s*\(/.exec(line);
  if (method) {
    for (const kind of kinds) {
      if (RULES[kind].jsMethods.includes(method[1])) candidates.push(kind);
    }
  }
  for (const kind of candidates) {
    const def = index.names(kind, dir).find((d) => d.name === word.word);
    if (def) return { kind, name: def.name, dir, range: wordRange(position.line, word) };
  }

  // 兜底：只要这个名字在某个 kind 里存在，且光标下的词范围落在它内部（点位含点号）
  for (const kind of kinds) {
    for (const def of index.names(kind, dir)) {
      const idx = line.indexOf(def.name);
      if (idx < 0) continue;
      if (position.character >= idx && position.character <= idx + def.name.length) {
        return {
          kind,
          name: def.name,
          dir,
          range: Range.create(
            position.line,
            idx,
            position.line,
            idx + def.name.length,
          ),
        };
      }
    }
  }
  return null;
}

function wordAt(line: string, character: number): { word: string; start: number } | null {
  const re = /[@{}]?[\w\u4e00-\u9fa5:_-]*[\w\u4e00-\u9fa5}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (!m[0]) continue;
    const start = m.index;
    if (character >= start && character <= start + m[0].length) {
      return { word: m[0], start };
    }
  }
  // 点位这类含点号的名字：整个词法不含点，退回"包含"判定
  const dot = /[\w\u4e00-\u9fa5]+(?:\.[\w\u4e00-\u9fa5]+)+/g;
  while ((m = dot.exec(line)) !== null) {
    if (character >= m.index && character <= m.index + m[0].length) {
      return { word: m[0], start: m.index };
    }
  }
  return null;
}

function wordRange(line: number, word: { word: string; start: number }): Range {
  return Range.create(line, word.start, line, word.start + word.word.length);
}

export function toLocation(hit: RefHit): Location {
  return {
    uri: hit.uri,
    range: Range.create(hit.line, hit.start, hit.line, hit.start + hit.length),
  };
}

export { REF_LABEL };
