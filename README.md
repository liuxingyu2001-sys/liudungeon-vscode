# LiuDungeon 脚本与配置支持（VS Code 扩展）

给 LiuDungeon 地牢副本插件写配置和脚本时用：**脚本语法补全**、悬停文档、跨文件校验、一键片段。

目标只有一个：写 `scripts.yml` / `monsters.yml` / `functions.js` 时不用再翻文档、不用再靠
「改完进游戏看有没有反应」来试错。

---

## 1. 它能做什么

| 能力 | 说明 |
| --- | --- |
| **action.* / dungeon.* 补全** | 84 个 `action.*` + 51 个 `dungeon.*` 方法，含签名、参数表、分类、可直接跑的示例 |
| **YAML 里嵌的 JS 也能补全** | 脚本字段统一 **`\|-` 块**写法（`complete: \|-` 下面一行一条、行尾分号）；老配置的引号字符串 `- "action.spawn_group('…')"` 列表也照常支持。两种写法里补全、悬停、诊断都生效 |
| **配置文件键名补全** | `config.yml` / `monsters.yml` / `stages.yml` / `zones.yml` / `obstacles.yml` / `interacts.yml` / `tasks.yml` / `rewards.yml` / `chest_rewards.yml` / `scripts.yml` / `functions.js` 的 196 个键，含中文别名与枚举取值。**外层键写别名也认**：`obstacles:` / `怪物组:` / `zones:` 与 `障碍物:` / `groups:` / `区域:` 等价（按插件源码的别名表归一化）；**外层容器也可以整个不写** —— 区域 / 阶段 / 障碍物 / 交互点 / 任务 / 宝箱直接写在根节点（游戏内编辑器保存出来的就是这种，插件解析器没有容器时会回退到根级；`monsters.yml` 是例外，怪物组必须写在容器里） |
| **位置引用写法** | 悬停 `locationRef` 类参数时会写明三种写法：`区域.点位` / **裸区域名**（取区域中心）/ `x,y,z`。注意"取区域中心"是**范围盒几何中心** —— 用游戏内编辑器建的还会自带一个 `点位.中心`（`zones.yml` 里能直接看到，见插件第十二章 12.5.2），想精确到某一格就写 `区域.中心` |
| **名字补全（副本里已定义的名字）** | 参数位置直接列出本副本的定义：`action.spawn_group('…')` 给怪物组、`enable_zone` 给区域、`teleport_point` 给点位、`create_obstacle` 给障碍物、`goto_stage` 给阶段、`grant_reward` 给奖励；YAML 里 `区域:` / `触发组:` / `点位:` 这类键（中英文键名都算）同样给名字 |
| **悬停文档** | 鼠标停在方法名、**键名（含根键与子键）**、`@all`、`{player.name}` 上直接看中文说明 |
| **跳转到定义** | `trigger_group: wave_1` 里的 `wave_1`、脚本里的 `'通关奖励'`、`enable_zone('前厅')` 里的 `'前厅'` 都能跳回定义处 |
| **查找引用（Shift+Alt+F12）** | 一个怪物组 / 区域 / 障碍物 / 奖励被哪些文件用到：`trigger_group`、`action.spawn_group('x')`、`dungeon.isGroupCleared('x')` 全部找出来（注释里的不算） |
| **重命名（F2）** | 改名会同时改定义键与所有引用，跨 `monsters.yml` / `scripts.yml` 一起改；名字非法（含点号/空格/冒号）会被直接拒绝 |
| **同词高亮** | 光标停在某个名字上，本文件里的定义处与引用处分别高亮（写/读两种颜色） |
| **快速修复** | 能确定性修好的诊断给一键修：`count: 0` → `-1`/`3`、随机奖励缺 `options` → 插入骨架、拼错的钩子名 → 改成正确名、`dungeon` 段里的 `spawn` → 删掉 |
| **大纲** | 文件里定义了哪些波次 / 区域 / 奖励，侧边栏直接看 |
| **诊断（重点）** | 方法名写错、参数给多、选择器没实现、占位符写错、时间写法不合法、钩子名写错（**中文钩子名也报** —— 插件只认 `init`/`start`/`complete`/`fail`/`exit`/`player_death`/`all_death`，写「开始:」等于整段脚本不执行）、引用了不存在的怪物组 / 区域 / 障碍物 / 交互点 / 阶段 / 奖励 / 点位（**脚本参数与 YAML 键两种写法都查**）、`spawn` 写到 `dungeon` 段里…… 全部直接标出来 |
| **「插件不读的键」** | 键名写错时插件只是取默认值：既不报错也不生效（例如障碍物里写「开启时候」而不是「开启时」，那行声音脚本一次都不放）。这类键会被标黄并给出最接近的正确写法 —— 只在数据能完整枚举子键的层级上检查，动态命名的层级（怪物组名、`<规则名>`、时间点…）不报 |
| **片段** | 补全面板 + `ld-` 前缀片段；常用写法一键展开 |
| **类型声明** | 自动生成 `.liudungeon/liudungeon.d.ts`，让 VS Code 自带的 JS 智能提示也认识 `action` / `dungeon` |

补全数据来自插件源码（`ActionApi.java` / `DungeonApi.java` / `Keys.java`）与官方文档，
自检脚本会把数据与 Java 源码逐方法对齐，源码新增方法而数据漏了会直接测试失败。

---

## 2. 安装

### 方式一：装 vsix（推荐）

```bash
code --install-extension liudungeon-script.vsix
```

### 方式二：从源码构建

```bash
npm install
npm run package        # 生成 liudungeon-script.vsix
code --install-extension liudungeon-script.vsix
```

开发时用 `npm run watch`，然后在 VS Code 里按 `F5` 启动扩展开发宿主窗口。

---

## 3. 怎么用

1. 用 VS Code 打开**服务器目录**或**插件配置目录**（只要能包含 `plugins/liudungeon/dungeons/`）。
2. 打开任意副本目录下的 `config.yml` / `monsters.yml` / `scripts.yml` …，补全立刻可用。
3. 常用入口：
   - `Ctrl+空格` 手动触发补全
   - `Ctrl+Shift+P` → `LiuDungeon: 重建副本索引`
   - `Ctrl+Shift+P` → `LiuDungeon: 打开脚本文档`
   - `Ctrl+Shift+P` → `LiuDungeon: 插入脚本模板`

### 三个能直接感受到的差别

```yaml
# scripts.yml —— 输入 action. 之后会列出全部 84 个动作，选中即带参数骨架
# 脚本字段的推荐写法：|- 块，一行一条语句、行尾加分号（注释用 //，不要写 YAML 的 #）
complete: |-
  action.title('@all', '&a&l通关！', '&7奖励已发放');
  action.spawn_group('|');     // 光标在引号里 → 直接列出 monsters.yml 里已定义的组名

# monsters.yml —— 输入 sp 就提示 spawn_timing，并给出枚举取值
groups:
  wave_1:
    spawn_timing:
      type: |                      # → AUTO_START / DELAYED / TRIGGERED / MANUAL / SCRIPTED
```

```js
// functions.js —— 与 YAML 里同样的提示
function 检查(d) {
    action.grant_reward('@all', '通关奖励')   // 参数名、类型、返回值都有说明
}
```

---

## 4. 诊断清单（照着改就能少踩坑）

| 诊断 | 为什么会出现 |
| --- | --- |
| `action.xxx() 不存在` | 脚本引擎对 `TypeError` 是**静默吞掉**的 —— 不报错、也不生效，最难查的一类问题 |
| `最多接受 N 个参数` | 按源码签名核对（同名重载取参数最多的版本） |
| `选择器 @party 没有实现` | `resolveSelector` 里没有这个分支，会回落到触发者 |
| `占位符 {player_name} 不会被替换` | 占位符是固定名单，写错就原样显示给玩家 |
| `时间写法 "3秒钟" 解析失败会静默变成 0` | 只认 `3s` / `3秒` / `5m` / `5分` / `2h` / `100t` / `500ms` / 纯数字 |
| `钩子名不是 scripts.yml 的钩子` | 拼错的钩子不会执行，也不报错。**中文钩子名同样报**（插件只认 `init`/`start`/`complete`/`fail`/`exit`/`player_death`/`all_death`；写「开始:」看起来很像对的，实际整段脚本一次都不跑） |
| `怪物组 / 区域 / 障碍物 / 交互点 / 阶段 / 奖励 / 点位「x」不存在` | 同副本目录里找不到定义。脚本参数（`action.enable_zone('前厅')`）、YAML 键（`区域: 前厅`、`zone: 前厅`）与**列表项里的键**（宝箱 `- reward: 通关奖励`）都查 |
| `插件不读「开启时候」这个键` | 插件的解析器一律「按名字取键、取不到用默认值」：键名写错既不报错也不生效。会给出最接近的正确键名 |
| `spawn 写在 dungeon 段里不会生效` | 运行时读的是 `world.spawn` |
| `revive 配了复活方式但 count: 0` | `count` 默认 0 = 禁止复活，`auto`/`item`/`ally` 全都不会生效 —— 玩家倒下后卡在旁观者视角，看起来就像「复活系统跟摆设一样」 |
| `player 在这个钩子里不存在` | `complete` / `fail` / `exit` / `all_death` 等钩子没有触发者，直接引用会抛 `ReferenceError` |
| `钩子永远不会执行` | 用于登记「源码级确认写了不跑」的钩子；当前为空 —— `complete` / `fail` 的顺序问题插件已修复（先跑脚本再切终态） |
| `type: random 的奖励没有 options 段` | 选项直接写在奖励名下面会整段被忽略：解析器只从 `options`（或 `选项`）里取选项，选项数为 0 → 抽奖返回空 → **奖励不发放且不报错**。提示里会把疑似写错的键名点出来 |
| `选项的权重是 0，永远抽不到` | `weight` 默认 0；若所有选项都是 0，会退化成等概率（提示里会说明） |

---

## 5. 设置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `liudungeon.enable` | `true` | 总开关 |
| `liudungeon.diagnostics.enable` | `true` | 诊断总开关 |
| `liudungeon.diagnostics.unknownMethod` | `true` | 未知方法 / 参数个数 |
| `liudungeon.diagnostics.references` | `true` | 跨文件引用校验 |
| `liudungeon.diagnostics.knownHooks` | `true` | 钩子名校验 |
| `liudungeon.dungeonsPath` | 空 | 手动指定副本目录（默认自动探测） |

---

## 6. 目录结构

```
src/client/          扩展主进程（启动语言服务、同步文件、生成 d.ts）
  extension.ts
  dts.ts             生成 .liudungeon/liudungeon.d.ts
  code-snippets.ts   生成 snippets/*.code-snippets
src/server/          语言服务（补全 / 悬停 / 跳转 / 诊断）
  server.ts          LSP 入口
  completion.ts      补全
  hover.ts           悬停
  diagnostics.ts     诊断
  yaml-context.ts    缩进栈解析：键路径 + 识别 YAML 里嵌的 JS
  index-store.ts     副本目录索引：定义了哪些组 / 区域 / 障碍物 / 交互点 / 阶段 / 奖励 / 点位
  references.ts      引用引擎：定义 + 各处引用的位置（跳转/引用/重命名/高亮共用）
  code-actions.ts    快速修复：只做机械且无歧义的改动
  api-model.ts       把 data/*.json 规整成可用结构
  snippets.ts        片段定义
data/                从插件源码与文档提取的参考数据
  action-methods.json / dungeon-methods.json / config-files.json
test/lsp-harness.mjs 端到端自检（真跑一个 LSP 服务）
scripts/mutate-refs.sh 变异测试：把这次的修复逐个改回坏写法，确认自检真的会红
snippets/            构建时生成的 VS Code 片段
```

---

## 7. 开发与自检

```bash
npm run typecheck   # TS 类型检查
npm test            # 构建 + 端到端自检（275 项断言，约 10 秒）+ 校验内置文档与插件仓库同步
bash scripts/mutate-refs.sh   # 变异测试：把关键修复逐个改回坏写法，确认自检真的会红
npm run package     # 打成 vsix
```

自检脚本会：真启动语言服务、发真实 LSP 报文、并用插件仓库里 `src/main/resources/example/`
的真实配置做「不许有误报」的回归。它还会核对 ActionApi.java / DungeonApi.java 的每个
public 方法都在补全数据里，防止插件升级后扩展悄悄过期。

「名字补全」与「引用校验」另有一份 tmp 下现造的副本目录（`test/lsp-harness.mjs` 里的
`REF_FILES`）：插件自带的 example/ 里 `zones.yml` / `stages.yml` / `interacts.yml` 全是
注释示例，一个区域、一个阶段都没定义 —— 只靠它测，这几类名字全空也不会有人发现。

`npm test` 的最后一步是 `scripts/sync-docs.mjs --check`：内置的 12 篇用户文档是从插件仓库
`docs/05-使用说明/` **整篇复制**过来的（这是扩展里"打开文档"命令指向的内容），
插件侧改了文档而扩展没同步，自检会直接报「内容过期」，跑 `npm run sync:docs` 即可。

如果插件仓库不在 `/home/liu/plugins/liudungeon`，用环境变量指定：

```bash
LD_PLUGIN_DIR=/path/to/liudungeon npm test
```

---

## 8. 已知边界

- 键名补全按「路径模板 + 缩进」匹配，**不做完整 YAML AST**：极端缩进（用 Tab、或同一映射里
  缩进忽深忽浅）可能提示不准，但不会误报错误。
- `player.*` 只补全常用 Bukkit 成员，不做完整 Bukkit API 补全（那不是本扩展的目标）。
- 诊断里「钩子永远不会执行」这张表在 `src/server/api-model.ts` 的 `DEAD_HOOKS` 里，当前为空：
  `complete` / `fail` 被终态守卫静默丢弃的问题已在插件 1.0.5 修掉（先跑脚本、再 `setState`）。
  以后若再发现同类问题，往这个表里加一条即可，补全与悬停会自动标注。
