/**
 * 脚本片段（Snippet）：补全面板里可直接展开的常用写法。
 *
 * 只放「真的能跑」的片段 —— 每个片段都对应 docs/05-使用说明/07-脚本开发指南.md
 * 里验证过的写法，避免给出会让服主踩坑的示例。
 */

export interface SnippetDef {
  label: string;
  body: string;
  doc: string;
}

/** 插入到 scripts.yml / 任务脚本里的完整语句片段。 */
export function javascriptSnippets(conditionOnly: boolean): SnippetDef[] {
  if (conditionOnly) return CONDITION_SNIPPETS;
  return SCRIPT_SNIPPETS;
}

const SCRIPT_SNIPPETS: SnippetDef[] = [
  {
    label: 'msg',
    body: "action.message('@all', '&e${1:文本}')",
    doc: '给全队发消息（支持 & 颜色与 {player.name} 占位符）',
  },
  {
    label: 'title',
    body: "action.title('@all', '&6${1:主标题}', '&7${2:副标题}')",
    doc: '标题 + 副标题',
  },
  {
    label: 'actionbar',
    body: "action.actionbar('@all', '&7剩余 &c' + dungeon.getTotalAliveMonsters())",
    doc: '动作栏显示剩余怪物数',
  },
  {
    label: 'broadcast',
    body: "action.broadcast('&6&l★ ${1:全服公告} ★')",
    doc: '全服广播（带插件前缀）',
  },
  {
    label: 'spawn',
    body: "action.spawn_group('${1:wave_1}')",
    doc: '立即生成一个怪物组',
  },
  {
    label: 'wait',
    body: "action.wait('${1:3s}')",
    doc: '等待（脚本线程阻塞，写法像同步代码；上限 10 分钟）',
  },
  {
    label: 'waitclear',
    body: "action.wait_clear('${1:wave_1}')",
    doc: '等到某个怪物组被清空（最多等 10 分钟）',
  },
  {
    label: 'complete',
    body: 'action.complete_dungeon()',
    doc: '标记通关（会走结算与自动出本流程）',
  },
  {
    label: 'fail',
    body: "action.fail('${1:全员阵亡}')",
    doc: '标记失败',
  },
  {
    label: 'exit',
    body: 'action.exit_dungeon()',
    doc: '把所有玩家送回主世界（不结算）',
  },
  {
    label: 'reward',
    body: "action.grant_reward('@all', '${1:通关奖励}')",
    doc: '发奖励：奖励名必须能在 rewards.yml 里找到，否则静默无效',
  },
  {
    label: 'var',
    body: "setVar('${1:变量名}', ${2:1})",
    doc: '写脚本变量（作用域是本次副本实例）',
  },
  {
    label: 'getvar',
    body: "getVar('${1:变量名}')",
    doc: '读脚本变量；不存在时返回数字 0（不是 null）',
  },
  {
    label: 'title_safe',
    body: "if (typeof player !== 'undefined') {\n    action.message('@trigger', '&7${1:只有触发者能看到}')\n}",
    doc: '只在有触发者时执行的写法（complete/exit/条件里 player 不存在）',
  },
  {
    label: 'log',
    body: "log('${1:调试信息：}' + dungeon.getStatusLabel())",
    doc: '打控制台日志，排查脚本有没有被执行',
  },
  {
    label: 'zone_in',
    body: "action.enable_zone('${1:前厅}')",
    doc: '开启区域（开启后进出脚本才会触发）',
  },
  {
    label: 'interact',
    body: "action.trigger_interact('@trigger', '${1:开门}')",
    doc: '按名字触发一个交互点',
  },
  {
    label: 'tp',
    body: "action.teleport('@all', '${1:前厅.落点}')",
    doc: '传送到命名点位（区域.点位）或 x,y,z',
  },
  {
    label: 'sound',
    body: "action.sound('@all', '${1:ENTITY_PLAYER_LEVELUP}', ${2:1.0}, ${3:1.0})",
    doc: '播放音效（音效名用 Bukkit Sound 枚举）',
  },
  {
    label: 'time',
    body: "action.time('${1:night}')",
    doc: '设置世界时间：day / noon / night / midnight 或 tick',
  },
  {
    label: 'potion',
    body: "action.apply_potion('@all', '${1:SPEED}', '${2:30s}', ${3:1})",
    doc: '给玩家上药水效果（时长写法见 3s / 5m / 2h）',
  },
  {
    label: 'loop_names',
    body:
      "var names = dungeon.getPlayerNames()\nvar line = ''\nfor (var i = 0; i < names.size(); i++) line += (i ? ', ' : '') + names.get(i)\naction.message('@all', '&7队员: &f' + line)",
    doc: '遍历 Java 列表（只能 size()/get(i)，没有 forEach）',
  },
];

const CONDITION_SNIPPETS: SnippetDef[] = [
  {
    label: 'cleared',
    body: "dungeon.isGroupCleared('${1:wave_1}')",
    doc: '该怪物组是否已清空（组完成会触发阶段条件重新求值）',
  },
  {
    label: 'alive',
    body: 'dungeon.getTotalAliveMonsters() <= 0',
    doc: '全副本没有存活怪物',
  },
  {
    label: 'kills',
    body: 'dungeon.getTotalMobKills() >= ${1:20}',
    doc: '累计击杀达到 N',
  },
  {
    label: 'zonecount',
    body: "dungeon.getZonePlayerCount('${1:前厅}') >= ${2:1}",
    doc: '某区域内至少有 N 名玩家',
  },
  {
    label: 'inzone',
    body: "dungeon.isInZone(player, '${1:前厅}')",
    doc: '触发者是否在某区域（需要触发者，条件里通常没有）',
  },
  {
    label: 'var',
    body: "getVar('${1:已开箱数}') >= ${2:3}",
    doc: '脚本变量达到 N（不存在时 getVar 返回 0）',
  },
  {
    label: 'time',
    body: 'dungeon.getRunningTime() >= ${1:300}',
    doc: '副本已运行 N 秒',
  },
  {
    label: 'stagename',
    body: "dungeon.getStage() === '${1:阶段1}'",
    doc: '当前阶段是某个 id',
  },
  {
    label: 'cn',
    body: '存活怪物 <= ${1:0}',
    doc: '中文条件写法（关键词会被引擎替换成 JS）',
  },
  {
    label: 'and',
    body: "dungeon.isGroupCleared('${1:wave_1}') && getVar('${2:已开箱数}') >= ${3:1}",
    doc: '多个条件与（&&）',
  },
];

/** functions.js 里的函数骨架片段。 */
export function functionSnippets(): SnippetDef[] {
  return [
    {
      label: 'function',
      body: 'function ${1:函数名}(${2:参数}) {\n    ${3:// 实现}\n}',
      doc: '普通函数；本副本所有脚本都能直接按名字调用（中文函数名也可以）',
    },
    {
      label: '基础函数',
      body:
        "// 函数名用中文完全可以；调用处直接写  喊话('内容')\n" +
        'function ${1:喊话}(内容) {\n' +
        "    action.message('@all', '&e' + 内容);\n" +
        '}',
      doc: '函数库最基础的写法（封装一句提示，别处一行就能用）',
    },
    {
      label: '记进度',
      body:
        'function ${1:记进度}(说明) {\n' +
        "    var 当前进度 = getVar('${2:进度}') + 1;   // 变量不存在时 getVar 返回 0\n" +
        "    setVar('${2:进度}', 当前进度);\n" +
        "    action.message('@all', '&e${2:进度} ' + 当前进度 + '：' + 说明);\n" +
        '}',
      doc: '用变量记进度 / 记击杀数（getVar 不存在时返回 0）',
    },
    {
      label: 'ifplayer',
      body: "if (typeof player !== 'undefined') {\n    ${1:action.message('@trigger', '&7只有触发者能看到')}\n}",
      doc: 'player 的存在性判断（complete / fail / all_death 等钩子里没有 player）',
    },
  ];
}
