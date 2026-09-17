/**
 * 快速修复（Code Action）：把「能确定性修好的诊断」变成一次点击。
 *
 * <p>只做**机械且无歧义**的修复 —— 凡是需要判断意图的（比如 revive.count 到底填几次）
 * 就给出几个候选，而不是替服主拍板。误改配置比不改更糟。
 *
 * <p>返回的是「与 URI 无关」的动作（TextEdit 列表 + 标题），由 server.ts 负责填 URI：
 * 这样这个模块不依赖 LSP 的文档 URI，测试也更好写。
 */
import { CodeActionKind, Diagnostic, Range, TextEdit } from 'vscode-languageserver';

export interface PendingAction {
  title: string;
  kind: string;
  /** 该修复对应的诊断（用于让编辑器把它挂到那条波浪线上）。 */
  diagnostics: Diagnostic[];
  isPreferred?: boolean;
  edits: TextEdit[];
  /** 传给编辑器的附加数据（目前只带诊断 code，便于自检断言）。 */
  code?: string;
}

export interface CodeActionInput {
  text: string;
  diagnostics: Diagnostic[];
}

/** 钩子名的合法集合（与 scripts.yml 一致）。 */
const HOOKS = ['init', 'start', 'complete', 'fail', 'exit', 'player_death', 'all_death'];

export function provideCodeActions(input: CodeActionInput): PendingAction[] {
  const out: PendingAction[] = [];
  const lines = input.text.split(/\r?\n/);

  for (const d of input.diagnostics) {
    const line = lines[d.range.start.line] ?? '';
    switch (d.code) {
      case 'spawn-key':
        if (/^\s*spawn\s*:/.test(line)) {
          out.push({
            title: '删除这一行（出生点只认 world.spawn）',
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            isPreferred: true,
            edits: [deleteLine(lines, d.range.start.line)],
            code: 'spawn-key',
          });
        }
        break;

      case 'revive-count': {
        const indent = line.length - line.trimStart().length;
        const key = /count\s*:/.exec(line)?.[0];
        if (!key) {
          out.push({
            title: '把 revive.count 设为 -1（无限复活）',
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            edits: [
              TextEdit.insert(
                { line: d.range.start.line + 1, character: 0 },
                `${' '.repeat(indent)}count: -1\n`,
              ),
            ],
            code: 'revive-count',
          });
          break;
        }
        for (const [value, title] of [
          ['-1', '把 revive.count 设为 -1（无限复活）'],
          ['3', '把 revive.count 设为 3（可复活 3 次）'],
        ] as const) {
          out.push({
            title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            isPreferred: value === '-1',
            edits: [TextEdit.replace(Range.create(d.range.start.line, 0, d.range.start.line, line.length), `${' '.repeat(indent)}${key} ${value}`)],
            code: 'revive-count',
          });
        }
        break;
      }

      case 'reward-options-missing': {
        const indent = line.length - line.trimStart().length;
        const pad = ' '.repeat(indent);
        const body = [
          `${pad}options:`,
          `${pad}  普通:`,
          `${pad}    weight: 70`,
          `${pad}    commands:`,
          `${pad}      - "give %player% stone 1"`,
          `${pad}  稀有:`,
          `${pad}    weight: 30`,
          `${pad}    money: 1000`,
        ].join('\n');
        out.push({
          title: '补上 options 段（随机奖励必须有它才会发奖）',
          kind: CodeActionKind.QuickFix,
          diagnostics: [d],
          isPreferred: true,
          edits: [TextEdit.insert({ line: d.range.start.line + 1, character: 0 }, body + '\n')],
          code: 'reward-options-missing',
        });
        break;
      }

      case 'reward-weight': {
        if (/\S/.test(line) && !/weight\s*:/.test(line)) {
          const indent = line.length - line.trimStart().length;
          out.push({
            title: '给这个选项补上 weight: 10',
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            isPreferred: true,
            edits: [
              TextEdit.insert(
                { line: d.range.start.line + 1, character: 0 },
                `${' '.repeat(indent + 2)}weight: 10\n`,
              ),
            ],
            code: 'reward-weight',
          });
        }
        break;
      }

      case 'unknown-hook': {
        const word = line.trim().split(':')[0].trim();
        const guess = closest(word, HOOKS);
        if (guess) {
          const start = line.indexOf(word);
          out.push({
            title: `改成 ${guess}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            isPreferred: true,
            edits: [TextEdit.replace(Range.create(d.range.start.line, Math.max(0, start), d.range.start.line, Math.max(0, start) + word.length), guess)],
            code: 'unknown-hook',
          });
        }
        break;
      }

      case 'script-quote': {
        // 选择器 / 颜色代码 / 文本少了引号：把整个参数套上引号（诊断范围就是参数本身）
        const raw = line.slice(d.range.start.character, d.range.end.character);
        if (raw.trim() !== '') {
          out.push({
            title: `给参数加上引号（'${raw}'）`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            isPreferred: true,
            edits: [TextEdit.replace(d.range, `'${raw}'`)],
            code: 'script-quote',
          });
        }
        break;
      }

      case 'placeholder': {
        // 占位符写错：给出最接近的正确写法
        const raw = line.slice(d.range.start.character, d.range.end.character);
        const guess = closestPlaceholder(raw);
        if (guess) {
          out.push({
            title: `改成 ${guess}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [d],
            isPreferred: true,
            edits: [TextEdit.replace(d.range, guess)],
            code: 'placeholder',
          });
        }
        break;
      }

      default:
        break;
    }
  }
  return out;
}

/** 删掉整行（含换行）。 */
function deleteLine(lines: string[], line: number): TextEdit {
  const isLast = line >= lines.length - 1;
  if (isLast) {
    // 最后一行：从上一行行尾删到本行行尾
    const prevLen = (lines[line - 1] ?? '').length;
    return TextEdit.del(Range.create(Math.max(0, line - 1), prevLen, line, (lines[line] ?? '').length));
  }
  return TextEdit.del(Range.create(line, 0, line + 1, 0));
}

/** 占位符的候选（与 diagnostics 的白名单一致）。 */
const PLACEHOLDERS = [
  '{player.name}',
  '{trigger.name}',
  '{player.level}',
  '{player.health}',
  '{player.x}',
  '{player.y}',
  '{player.z}',
  '{player.pos}',
  '{dungeon.time}',
  '{dungeon.players}',
  '{dungeon.name}',
  '{total_kills}',
  '{zone}',
  '{zone.name}',
  '{from_zone}',
];

function closestPlaceholder(raw: string): string | null {
  const norm = raw.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const p of PLACEHOLDERS) {
    const score = levenshtein(norm, p.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // 允许较小差异才算"看得出是写错了"，否则不给建议
  return best && bestScore <= 4 ? best : null;
}

/** 最接近的候选（用于拼错的钩子名）。 */
function closest(word: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = levenshtein(word.toLowerCase(), c);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const limit = word.length <= 3 ? 1 : 2;
  return bestScore <= limit ? best : null;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
