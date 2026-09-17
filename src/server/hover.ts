/**
 * 悬停文档：鼠标停在方法名 / 键名 / 选择器 / 占位符上时给出说明。
 *
 * 与补全共用同一份数据（api-model），所以文档不会出现「补全有、悬停没有」的漂移。
 */
import { Hover, MarkupKind, Range } from 'vscode-languageserver';
import {
  ACTION_METHODS,
  BUILTIN_FUNCTIONS,
  CONDITION_KEYWORDS,
  CONFIG_DATA,
  DEAD_HOOKS,
  DUNGEON_METHODS,
  PLACEHOLDERS,
  SELECTORS,
  TIME_FORMATS,
  scriptBlockLines,
  type ApiMethod,
} from './api-model';
import { ALL_REF_KINDS, IndexStore, REF_LABEL } from './index-store';
import { analyze, nodeAt } from './yaml-context';
import { baseName, keySpellings } from './yaml-shared';

export interface HoverInput {
  filePath: string;
  text: string;
  line: number;
  character: number;
  index: IndexStore;
}

export function provideHover(input: HoverInput): Hover | null {
  const name = baseName(input.filePath);
  const lines = input.text.split(/\r?\n/);
  const line = lines[input.line] ?? '';
  const isYaml = /\.(ya?ml)$/.test(name);

  const word = wordAt(line, input.character);
  if (!word) return null;
  const range = Range.create(input.line, word.start, input.line, word.start + word.word.length);

  // 1) action.xxx / dungeon.xxx
  const methodHit = methodAround(line, word.start, word.word);
  if (methodHit) {
    const md = renderMethod(methodHit.object, methodHit.method);
    return { contents: { kind: MarkupKind.Markdown, value: md }, range };
  }

  // 2) 内置函数
  const fn = BUILTIN_FUNCTIONS.find((f) => f.name === word.word);
  if (fn) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${fn.signature}** → \`${fn.returns}\`\n\n${fn.doc}\n\n\`\`\`js\n${fn.example}\n\`\`\``,
      },
      range,
    };
  }

  // 2b) 中文条件关键词（条件里写中文，引擎求值前替换成 JS）
  const cn = CONDITION_KEYWORDS.find((k) => k.cn === word.word);
  if (cn) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value:
          `**${cn.cn}** · 中文条件关键词\n\n` +
          `求值前会被引擎替换成 \`${cn.js}\`，所以可以直接写 \`${cn.cn} <= 5\`。\n\n` +
          '⚠ 条件必须**全部为真**才允许这一组生成；为假不会作废 —— 会挂起，之后每次有怪物死亡' +
          '再判一次，条件成立就补刷（最多 300 次）。\n\n' +
          '⚠ 表以外的中文词（如「小于等于」）会被当成未定义标识符 → 条件恒为 false，' +
          '怪物永远不出来；插件只认这里列出的词，其余要写 JS。',
      },
      range,
    };
  }

  // 3) 选择器
  if (word.word.startsWith('@')) {
    const doc = SELECTORS.get(word.word);
    if (doc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**${word.word}** · 玩家选择器\n\n${doc}\n\n常用：\`@all\` 全队 / \`@trigger\` 触发者 / \`@others\` 除触发者 / \`@nearest\` 最近 / \`@random\` 随机一人`,
        },
        range,
      };
    }
  }

  // 4) 文本占位符
  if (word.word.startsWith('{')) {
    const doc = PLACEHOLDERS.get(word.word);
    const time = TIME_FORMATS.find((t) => t.value === word.word);
    if (doc) {
      return {
        contents: { kind: MarkupKind.Markdown, value: `**${word.word}** · 文本占位符\n\n${doc}` },
        range,
      };
    }
    if (time) {
      return {
        contents: { kind: MarkupKind.Markdown, value: `**${word.word}** · 时间写法\n\n${time.doc}` },
        range,
      };
    }
  }

  if (!isYaml) return null;

  // 5) YAML 键名
  //
  // 光标**落在键名上**时 analyze 的 currentKey 是空的（它是为「值位置」设计的），
  // 于是这里只能拿父路径去查节点，结果是：根键（obstacles、world、enable…）查不到 →
  // 没有悬停；子键查到的是**上一级**的说明 → 悬停 `区域:` 显示的是它所在的障碍物是什么。
  // 所以先把光标下的那个键补进路径查一次，查不到再退回原来的父路径。
  const ctx = analyze(input.text, input.line, input.character);
  const onOwnKey = ctx.lineKey !== null && ctx.lineKey === word.word;
  const node = onOwnKey
    ? nodeAt(name, { ...ctx, currentKey: word.word })
    : nodeAt(name, ctx);
  if (node) {
    const md = renderNode(name, node);
    return { contents: { kind: MarkupKind.Markdown, value: md }, range };
  }

  // 6) 钩子名（scripts.yml 顶层）
  if (name === 'scripts.yml') {
    const hook = CONFIG_DATA.scriptHooks.find((h) => h.name === word.word);
    if (hook) {
      const dead = DEAD_HOOKS.get(hook.name);
      const md = [
        `**${hook.name}** · 生命周期钩子`,
        '',
        hook.doc,
        '',
        `触发者：${hook.hasTrigger ? '有（player / trigger 可用）' : '无（player 不存在）'}`,
        '',
        '```yaml',
        ...scriptBlockLines(hook.name, hook.example),
        '```',
        dead ? `\n> ⚠ ${dead}` : '',
      ];
      return { contents: { kind: MarkupKind.Markdown, value: md.join('\n') }, range };
    }
  }

  // 7) 引用的名字（怪物组 / 区域 / 障碍物 / 奖励 …）→ 显示定义位置
  const dir = input.index.dirForFile(input.filePath);
  if (dir) {
    for (const kind of ALL_REF_KINDS) {
      const def = input.index.names(kind, dir).find((d) => d.name === word.word);
      if (def) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**${def.name}** · ${REF_LABEL[kind]}\n\n${def.doc ?? ''}\n\n定义位置：\`${def.file}:${def.line + 1}\``,
          },
          range,
        };
      }
    }
  }

  return null;
}

function renderMethod(object: string, method: ApiMethod): string {
  const lines = [
    `\`\`\`js`,
    `${object}.${method.signature}`,
    '```',
    '',
    method.doc,
    '',
    `分类：${method.category} ｜ 返回：\`${method.returns}\``,
  ];
  if (method.params.length) {
    lines.push('', '| 参数 | 类型 | 说明 |', '| --- | --- | --- |');
    for (const p of method.params) {
      lines.push(`| \`${p.name}\` | ${p.type} | ${p.doc} |`);
    }
  }
  lines.push('', '```js', method.example, '```');
  if (method.aliases?.length) lines.push('', `别名：${method.aliases.join(' / ')}`);
  return lines.join('\n');
}

function renderNode(fileName: string, node: ReturnType<typeof nodeAt> & object): string {
  const spellings = keySpellings(node);
  const lines = [`**${node.key}** · ${fileName}`, '', node.doc];
  if (node.type) lines.push('', `类型：\`${node.type}\``);
  if (node.values?.length) lines.push(`取值：${node.values.map((v) => `\`${v}\``).join(' / ')}`);
  if (spellings.length > 1) lines.push('', `同义写法：${spellings.slice(1).join(' / ')}`);
  if (node.required) lines.push('', '**必填**');
  const dead = DEAD_HOOKS.get(node.key);
  if (dead) lines.push('', `> ⚠ ${dead}`);
  return lines.join('\n');
}

function wordAt(line: string, character: number): { word: string; start: number } | null {
  // 不含点号：`action.complete_dungeon` 要分成 action / complete_dungeon 两段，
  // 否则 methodAround() 永远匹配不到方法名。
  const re = /[@{}]?[\w\u4e00-\u9fa5:_-]*[\w\u4e00-\u9fa5}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[0] === '') continue;
    const start = m.index;
    const end = start + m[0].length;
    if (character >= start && character <= end) {
      return { word: m[0], start };
    }
  }
  return null;
}

/** 从光标位置判断是不是 `action.xxx` 里的 xxx。 */
function methodAround(
  line: string,
  wordStart: number,
  word: string,
): { object: string; method: ApiMethod } | null {
  const before = line.slice(0, wordStart);
  const m = /(action|dungeon)\s*\.\s*$/.exec(before);
  if (!m) return null;
  const table = m[1] === 'action' ? ACTION_METHODS : DUNGEON_METHODS;
  const method = table.get(word);
  if (!method) return null;
  return { object: m[1], method };
}
