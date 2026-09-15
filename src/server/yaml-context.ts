/**
 * YAML 光标上下文分析：判断光标处在「键名 / 值 / 脚本字符串（其实写的是 JS）」的哪一层，
 * 并算出当前键的完整祖先路径，用于按 nodes 的 path 模板匹配可补全的键。
 *
 * 为什么不用 LSP 的 YAML 服务：Quarkus/Red Hat YAML 扩展是可选依赖；
 * 这里自己做「缩进栈 + 当前行」的轻量解析，顺带能识别 YAML 里嵌的 JS 片段。
 *
 * 祖先路径用「缩进栈」而不是「往回找更小缩进」——后者会漏掉列表项
 * （`- "..."` 的缩进与父键相同），导致 `groups.wave_1.spawn_timing.type`
 * 被算成 `groups.wave_1.type`。
 */
import { CONFIG_FILE_BY_NAME, type ConfigNode, nodePathMatchesSafe, splitPath } from './yaml-shared';

export interface YamlContext {
  /** 当前行光标之前的文本。 */
  lineText: string;
  /** 当前行缩进空格数（制表符按 2 计）。 */
  indent: number;
  /** 光标处正在输入的词（键名或值的前缀）。 */
  word: string;
  /** word 在行内的起始列。 */
  wordStart: number;
  /** true = 光标在 `key: ` 之后（值位置）。 */
  inValue: boolean;
  /** 光标所在字符串的引号类型；null = 不在字符串里。 */
  quote: "'" | '"' | null;
  /** 光标在字符串内容里的偏移；不在字符串里为 -1。 */
  stringOffset: number;
  /** 字符串内容（不含引号）。 */
  stringBody: string;
  /** 当前键之前的祖先键路径。 */
  ancestors: string[];
  /** 当前键（值位置时是它自己的键；键名位置时是正在输入的那个键的父级不参与）。 */
  currentKey: string;
  /** 当前行的键（可能是列表项内容）。 */
  lineKey: string | null;
  /**
   * 光标落在块标量（`|-` / `>`）的正文里时给出区域信息，否则 undefined。
   * 块标量的正文是脚本文本，不是 YAML 结构 —— 所有补全都要按 JS 处理。
   */
  blockScalar?: {
    /** 正文的起始缩进（用于把行内偏移换算成正文偏移）。 */
    contentIndent: number;
    /** 正文第一行的行号（0 基）。 */
    firstLine: number;
    /** 这个块标量挂在哪个键下。 */
    key: string;
  };
}

interface LineInfo {
  indent: number;
  key: string | null;
  isListItem: boolean;
}

export function analyze(text: string, line: number, character: number): YamlContext {
  const lines = text.split(/\r?\n/);
  const raw = lines[line] ?? '';
  const lineText = raw.slice(0, character);
  const indent = leadingSpaces(raw);

  // ---- 祖先：用缩进栈扫到当前行之前 ----
  const stack: LineInfo[] = [];
  for (let i = 0; i < line; i++) {
    const info = lineInfo(lines[i] ?? '');
    if (info.key == null) continue;
    while (stack.length && stack[stack.length - 1].indent >= info.indent) stack.pop();
    stack.push(info);
  }

  // ---- 当前行：可能是「键: 值」也可能是裸的列表项（`- "action.xxx()"`）----
  const isBareItem = /^\s*-\s+/.test(raw) && !/^\s*-\s*[^'"\s][^:]*:/.test(raw);
  const colonOffset = isBareItem ? -1 : findValueColon(raw);
  const inValue = colonOffset >= 0 ? character > colonOffset : isBareItem;

  const info = lineInfo(raw);
  let ancestors = stack.map((s) => s.key as string);

  // 值位置：当前行的键也在祖先里（ancestors 里含它自己），先弹出
  let currentKey = '';
  if (inValue) {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    currentKey = info.key ?? '';
    ancestors = stack.map((s) => s.key as string);
    if (!currentKey && ancestors.length) {
      currentKey = ancestors[ancestors.length - 1];
      ancestors = ancestors.slice(0, -1);
    }
  } else {
    // 键名位置：把当前行所在层级（含同级列表项）先弹掉
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    ancestors = stack.map((s) => s.key as string);
  }

  // ---- 块标量（|- / >- / |+ …）：整段是「值」，但不是 YAML 结构而是脚本文本 ----
  // 这里必须优先判断：`on_end: |-` 下面的每一行都只是文本，
  // 不判断的话它们会被当成 `键: 值`（`action.foo()` 里那个冒号会骗过分析器），
  // 于是 YAML 里嵌的 JS 完全得不到补全。
  const block = detectBlockScalar(lines, line);
  if (block) {
    const rawBody = lines[line] ?? '';
    const lead = rawBody.length - rawBody.trimStart().length;
    const bodyOffset = Math.max(block.contentIndent, lead);
    return {
      lineText,
      indent,
      word: jsWordBefore(lineText),
      wordStart: lineText.length - jsWordBefore(lineText).length,
      inValue: true,
      quote: null,
      stringOffset: character - bodyOffset,
      stringBody: rawBody.slice(bodyOffset, character),
      ancestors: stack.map((s) => s.key as string),
      currentKey: block.key,
      lineKey: lineInfo(raw).key,
      blockScalar: {
        contentIndent: block.contentIndent,
        firstLine: block.firstLine,
        key: block.key,
      },
    };
  }

  // ---- 字符串与词 ----
  let quote: "'" | '"' | null = null;
  let stringBody = '';
  if (inValue) {
    const valueStart = colonOffset >= 0 ? colonOffset + 1 : raw.indexOf('-') + 1;
    const scanned = raw.slice(valueStart, character);
    const scan = scanQuotes(scanned);
    if (scan.quote) {
      quote = scan.quote;
      stringBody = raw.slice(valueStart + scan.start + 1, character);
    } else {
      const closed = matchClosedString(scanned);
      if (closed) {
        quote = closed.quote;
        stringBody = closed.body;
      }
    }
  }

  const wordInfo = inValue
    ? valueWord(lineText, colonOffset, quote, raw)
    : keyWord(lineText);

  return {
    lineText,
    indent,
    word: wordInfo.word,
    wordStart: wordInfo.start,
    inValue,
    quote,
    stringOffset: quote ? stringBody.length : -1,
    stringBody,
    ancestors,
    currentKey,
    lineKey: info.key,
  };
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 2;
    else break;
  }
  return n;
}

/** 找 `key:` 里那个冒号的位置（跳过引号内的冒号与 `http://`）。 */
function findValueColon(raw: string): number {
  // 列表项前缀 `- ` 不算键的一部分
  const start = /^\s*-\s+/.exec(raw)?.[0].length ?? 0;
  let inS = false;
  let inD = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === ':' && !inS && !inD) {
      const next = raw[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

/** 扫描未闭合的引号：返回引号类型与起始位置。 */
function scanQuotes(s: string): { quote: "'" | '"' | null; start: number } {
  let quote: "'" | '"' | null = null;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && quote !== '"') {
      if (quote === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      if (quote === "'") {
        quote = null;
        start = -1;
      } else {
        quote = "'";
        start = i;
      }
    } else if (ch === '"' && quote !== "'") {
      if (s[i - 1] === '\\') continue;
      if (quote === '"') {
        quote = null;
        start = -1;
      } else {
        quote = '"';
        start = i;
      }
    }
  }
  return { quote, start };
}

/** 已经完全闭合的字符串：光标在字符串内部也应给 JS 补全。 */
function matchClosedString(s: string): { quote: "'" | '"'; body: string } | null {
  const m = /^\s*(['"])(.*)\1\s*$/.exec(s);
  if (!m) return null;
  return { quote: m[1] as "'" | '"', body: m[2] };
}

function keyWord(lineText: string): { word: string; start: number } {
  const trimmed = lineText.replace(/\s+$/, '');
  const m = /(^|[\s-])([^\s:#]*)$/.exec(trimmed);
  if (!m) return { word: '', start: lineText.length };
  return { word: m[2], start: trimmed.length - m[2].length };
}

function valueWord(
  lineText: string,
  colonOffset: number,
  quote: "'" | '"' | null,
  raw: string,
): { word: string; start: number } {
  const base = colonOffset >= 0 ? colonOffset : Math.max(0, raw.indexOf('-') + 1);
  if (quote) {
    const qIdx = lastIndexOfQuote(lineText, base, quote);
    const bodyStart = (qIdx >= 0 ? qIdx : colonOffset + 1) + 1;
    const body = lineText.slice(bodyStart);
    const m = /([A-Za-z_$@{}][\w$@{}.:-]*)$/.exec(body);
    const word = m ? m[1] : '';
    return { word, start: lineText.length - word.length };
  }
  const after = lineText.slice(base);
  const ws = after.match(/^\s*/)?.[0].length ?? 0;
  const body = after.slice(ws);
  const m = /([^\s,]*)$/.exec(body);
  const word = m ? m[1] : '';
  return { word, start: lineText.length - word.length };
}

function lastIndexOfQuote(lineText: string, from: number, quote: "'" | '"'): number {
  let idx = -1;
  for (let i = from; i < lineText.length; i++) {
    if (lineText[i] !== quote) continue;
    if (quote === '"' && lineText[i - 1] === '\\') continue;
    idx = i;
  }
  return idx;
}

function lineInfo(raw: string): LineInfo {
  const indent = leadingSpaces(raw);
  const content = raw.trim();
  let isListItem = false;
  let body = content;
  if (/^-\s/.test(body)) {
    isListItem = true;
    body = body.replace(/^-\s+/, '').trim();
  } else if (body === '-') {
    isListItem = true;
    body = '';
  }
  const m = /^("([^"]*)"|'([^']*)'|([^:#]+?))\s*:(?:\s|$)/.exec(body);
  const key = m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : null;
  return { indent, key, isListItem };
}

/** 在某个文件的 nodes 里找“父路径匹配 + 可补全的键”。 */
export function childNodes(file: string, ctx: YamlContext): ConfigNode[] {
  const cfg = CONFIG_FILE_BY_NAME.get(file);
  if (!cfg) return [];
  const parentPath = ctx.ancestors.join('.');
  const out: ConfigNode[] = [];
  for (const node of cfg.nodes) {
    const segments = splitPath(node.path);
    if (segments.length === 0) continue;
    const parentSegments = segments.slice(0, -1);
    if (!nodePathMatchesSafe(parentSegments.join('.'), parentPath)) continue;
    if (node.key.includes('<')) continue; // 占位符节点不作为键提示
    out.push(node);
  }
  return out;
}

/** 找到与当前路径完全匹配（含占位符）的节点。 */
export function nodeAt(file: string, ctx: YamlContext): ConfigNode | undefined {
  const cfg = CONFIG_FILE_BY_NAME.get(file);
  if (!cfg) return undefined;
  const concrete = [...ctx.ancestors, ctx.currentKey].filter(Boolean).join('.');
  if (!concrete) return undefined;
  for (const node of cfg.nodes) {
    if (nodePathMatchesSafe(node.path, concrete)) return node;
  }
  return undefined;
}

/**
 * 找光标所在行所属的块标量（`|-`、`|`、`>`、`>-`、`|+` 等）。
 *
 * 判定规则：从光标行往上找第一个非空行，若它比更上面的某一行「缩进更深」，
 * 那么它就是块标量的正文，再往上找到声明行 `key: |-` 即成立。
 * 正文缩进取正文第一行的缩进（YAML 规范允许它比父键多缩进任意格）。
 */
function detectBlockScalar(
  lines: string[],
  line: number,
): { contentIndent: number; firstLine: number; key: string } | null {
  let i = line;
  // 先往上跳过空行（块标量正文可以包含空行）
  while (i >= 0 && (lines[i] ?? '').trim() === '') i--;
  if (i < 0) return null;

  const body = lines[i] ?? '';
  const bodyIndent = leadingSpaces(body);
  if (bodyIndent === 0) return null;

  // 跳过与首行同级（含更深）的其它正文行，找到正文开始处
  let first = i;
  const contentIndent = bodyIndent;
  while (first - 1 >= 0) {
    const prev = lines[first - 1] ?? '';
    if (prev.trim() === '') {
      // 空行可以属于正文（但如果再往上是声明行，则停在空行之后）
      const above = findPrevNonBlank(lines, first - 2);
      if (above < 0) break;
      if (leadingSpaces(lines[above]) >= contentIndent) {
        first = above;
        continue;
      }
      break;
    }
    if (leadingSpaces(prev) >= contentIndent) {
      first = first - 1;
      continue;
    }
    break;
  }

  const header = findPrevNonBlank(lines, first - 1);
  if (header < 0) return null;
  if (!isBlockScalarHeader(lines[header] ?? '')) return null;

  const m = /^\s*(?:-\s+)?("([^"]*)"|'([^']*)'|([^:#]+?))\s*:/.exec(lines[header] ?? '');
  const key = m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
  return { contentIndent, firstLine: first, key };
}

function findPrevNonBlank(lines: string[], from: number): number {
  for (let i = from; i >= 0; i--) {
    if ((lines[i] ?? '').trim() !== '') return i;
  }
  return -1;
}

/** `on_end: |-` / `on_end: >-` / `on_end: |` … */
function isBlockScalarHeader(line: string): boolean {
  return /:\s*[|>][+-]?\d*\s*(#.*)?$/.test(line.trim());
}

/**
 * 光标前正在输入的 JS 词。
 *
 * 只匹配标识符字符（`.` 由 completion 的 parseJsContext 负责解析），
 * 这样 `action.complete` 会得到词 `complete`，而不是整串。
 */
function jsWordBefore(lineText: string): string {
  const m = /[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*$/.exec(lineText);
  return m ? m[0] : '';
}
