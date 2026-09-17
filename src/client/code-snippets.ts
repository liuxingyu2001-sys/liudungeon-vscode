/**
 * 生成 snippets/*.code-snippets：
 *   liudungeon-js.code-snippets    → 在 .js / .lds 里输入前缀直接展开
 *   liudungeon-yaml.code-snippets  → 在 yml 里输入前缀直接展开（脚本行、整份文件模板）
 *
 * 由 build 阶段调用（esbuild 插件），保证片段与 api-model 的数据同源。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ACTION_METHODS, ALL_CONFIG_FILES, BUILTIN_FUNCTIONS, CONFIG_DATA, DUNGEON_METHODS, scriptBlockLines } from '../server/api-model';
import { functionSnippets, javascriptSnippets } from '../server/snippets';

interface CodeSnippet {
  prefix: string;
  body: string[];
  description?: string;
}

export function buildCodeSnippets(jsPath: string, yamlPath: string): void {
  const js: Record<string, CodeSnippet> = {};

  // 1. 内置函数
  for (const fn of BUILTIN_FUNCTIONS) {
    js[`ld-${fn.name}`] = {
      prefix: `ld-${fn.name}`,
      body: [fn.example],
      description: `${fn.doc}（返回：${fn.returns}）`,
    };
  }

  // 2. 脚本片段（与补全面板同源）
  for (const s of javascriptSnippets(false)) {
    js[`ld-${s.label}`] = { prefix: `ld-${s.label}`, body: splitLines(s.body), description: s.doc };
  }
  for (const s of functionSnippets()) {
    js[`ld-${s.label}`] = { prefix: `ld-${s.label}`, body: splitLines(s.body), description: s.doc };
  }

  // 3. 常用 action / dungeon 方法（只挑高频的，避免片段面板被 119 条淹没）
  const frequency = [
    'action.message',
    'action.title',
    'action.actionbar',
    'action.broadcast',
    'action.complete_dungeon',
    'action.fail',
    'action.exit_dungeon',
    'action.spawn_group',
    'action.stop_repeat',
    'action.cancel_group',
    'action.wait',
    'action.wait_clear',
    'action.grant_reward',
    'action.teleport',
    'action.teleport_point',
    'action.teleport_zone',
    'action.enable_zone',
    'action.disable_zone',
    'action.trigger_interact',
    'action.revive',
    'action.add_revive',
    'action.give_item',
    'action.sound',
    'action.particle',
    'action.time',
    'action.weather',
    'action.gamerule',
    'action.gamemode',
    'action.apply_potion',
    'action.heal',
    'action.command',
    'action.player_command',
    'action.stats',
    'action.goto_stage',
    'action.restart_stage',
    'action.complete_stage',
    'dungeon.isGroupCleared',
    'dungeon.getAliveMonsterCount',
    'dungeon.getTotalAliveMonsters',
    'dungeon.getTotalMobKills',
    'dungeon.getZonePlayerCount',
    'dungeon.getOnlinePlayerCount',
    'dungeon.getRunningTime',
    'dungeon.getStage',
    'dungeon.getReviveLeft',
  ];
  for (const key of frequency) {
    const [ns, method] = key.split('.');
    const table = ns === 'action' ? ACTION_METHODS : DUNGEON_METHODS;
    const meta = table.get(method);
    if (!meta) continue;
    js[`ld-${method}`] = {
      prefix: `ld-${method}`,
      body: [meta.example],
      description: `${meta.signature} — ${meta.doc}`,
    };
  }

  // ---- YAML 片段 ----
  const yaml: Record<string, CodeSnippet> = {};

  for (const hook of CONFIG_DATA.scriptHooks) {
    yaml[`ld-hook-${hook.name}`] = {
      prefix: `ld-hook-${hook.name}`,
      body: scriptBlockLines(hook.name, hook.example),
      description: `${hook.doc}（触发者：${hook.hasTrigger ? '有' : '无'}）`,
    };
  }

  // 每份配置数据都给一个「最小可用模板」片段。
  // 用 ALL_CONFIG_FILES 而不是 CONFIG_DATA.files：插件**主配置**
  // （plugins/liudungeon/config.yml）也得有自己的前缀（ld-pluginconfigyml）——
  // 否则在它里面只有 ld-configyml 可打，一敲就是一份**副本**配置的模板，插进去全是不生效的键。
  for (const file of ALL_CONFIG_FILES) {
    if (!file.example) continue;
    const key = file.file.replace(/\W/g, '');
    yaml[`ld-${key}`] = {
      prefix: `ld-${key}`,
      body: splitLines(file.example),
      description: `${file.title} —— 最小可用模板`,
    };
  }

  // 常见整段脚本写法（一律 |- 块：一行一条语句、行尾加分号，见插件文档 7.1.1）
  yaml['ld-message'] = {
    prefix: 'ld-message',
    body: [`action.message('@all', '&e\${1:文本}');`],
    description: '给全队发消息的一行脚本（写进 |- 块里）',
  };
  yaml['ld-script-block'] = {
    prefix: 'ld-script',
    body: ['\${1:start}: |-', '  action.message(\'@all\', \'&e\${2:开始}\');'],
    description: '钩子 + 一行脚本（|- 块写法）',
  };

  mkdirSync(dirname(jsPath), { recursive: true });
  writeFileSync(jsPath, JSON.stringify(js, null, 2) + '\n', 'utf-8');
  writeFileSync(yamlPath, JSON.stringify(yaml, null, 2) + '\n', 'utf-8');
}

function splitLines(text: string): string[] {
  return text.replace(/\n$/, '').split('\n');
}
