# LiuDungeon 脚本与配置支持（VS Code 扩展）

给 LiuDungeon 地牢副本插件写配置和脚本时用：**脚本语法补全**、悬停文档、跨文件校验、一键片段。

目标只有一个：写 `scripts.yml` / `monsters.yml` / `functions.js` 时不用再翻文档、不用再靠
「改完进游戏看有没有反应」来试错。

---

## 1. 它能做什么

| 能力 | 说明 |
| --- | --- |
| **action.* / dungeon.* 补全** | 70 个 `action.*` + 49 个 `dungeon.*` 方法，含签名、参数表、分类、可直接跑的示例 |
| **YAML 里嵌的 JS 也能补全** | 两种写法都支持：引号字符串 `- "action.spawn_group('…')"`，以及**块标量** `on_end: \|-` 下面的多行脚本（块标量正文里补全、悬停、诊断照常生效） |
| **配置文件键名补全** | `config.yml` / `monsters.yml` / `stages.yml` / `zones.yml` / `interacts.yml` / `tasks.yml` / `rewards.yml` / `scripts.yml` 的 167 个键，含中文别名与枚举取值 |
| **悬停文档** | 鼠标停在方法名、键名、`@all`、`{player.name}` 上直接看中文说明 |
| **跳转到定义** | `trigger_group: wave_1` 里的 `wave_1`、脚本里的 `'通关奖励'` 都能跳回定义处 |
| **大纲** | 文件里定义了哪些波次 / 区域 / 奖励，侧边栏直接看 |
| **诊断（重点）** | 方法名写错、参数给多、选择器没实现、占位符写错、时间写法不合法、钩子名写错、引用了不存在的怪物组 / 区域 / 奖励、`spawn` 写到 `dungeon` 段里…… 全部直接标出来 |
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
# scripts.yml —— 输入 action. 之后会列出全部 70 个动作，选中即带参数骨架
start:
  - "action.spawn_group('|')"     # 光标在引号里 → 直接列出 monsters.yml 里已定义的组名

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
| `钩子名不是 scripts.yml 的钩子` | 拼错的钩子不会执行，也不报错 |
| `怪物组 / 区域 / 奖励「x」不存在` | 同副本目录里找不到定义 |
| `spawn 写在 dungeon 段里不会生效` | 运行时读的是 `world.spawn` |
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
  index-store.ts     副本目录索引：定义了哪些组 / 区域 / 奖励
  api-model.ts       把 data/*.json 规整成可用结构
  snippets.ts        片段定义
data/                从插件源码与文档提取的参考数据
  action-methods.json / dungeon-methods.json / config-files.json
test/lsp-harness.mjs 端到端自检（真跑一个 LSP 服务）
snippets/            构建时生成的 VS Code 片段
```

---

## 7. 开发与自检

```bash
npm run typecheck   # TS 类型检查
npm test            # 构建 + 端到端自检（62 项断言，约 3 秒）
npm run package     # 打成 vsix
```

自检脚本会：真启动语言服务、发真实 LSP 报文、并用插件仓库里 `src/main/resources/example/`
的真实配置做「不许有误报」的回归。它还会核对 ActionApi.java / DungeonApi.java 的每个
public 方法都在补全数据里，防止插件升级后扩展悄悄过期。

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
