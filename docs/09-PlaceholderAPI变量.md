# 九、PlaceholderAPI 变量

> [← 八、地图模板管理](08-地图模板管理.md) · [总目录](../05-使用说明.md) · [十、排错与常见问题 →](10-排错与常见问题.md)

装好 PlaceholderAPI 后，插件自动注册标识符为 `liudungeon` 的扩展，共 **45 个**变量。
随时可用 `/ld placeholders` 查看注册状态与完整清单。

注册走反射加载，**PAPI 没装时插件照常启动**，只是变量保持原样不解析。

## 9.1 通用规则（先看这段，比逐个查表更重要）

| 规则 | 说明 |
|---|---|
| 大小写 | 变量名**大小写不敏感**；带参数的变量只对前缀不敏感，参数部分原样保留（因此支持中文参数名，如 `var_房间进度`） |
| 需要玩家在线 | 除 6 个服务器级变量外，其余都需要「请求里带着一个在线玩家」。控制台发起或 `player == null` 时返回**空串** |
| 不在副本里 | 副本内变量一律返回**空串**，而不是 `0`。这是刻意的：计分板上「未进本」应该显示空白 |
| 子系统未启用 | 阶段 / 区域 / 复活 / 队伍 / 奖励模块未加载时返回各自兜底值 |
| 写错变量名 | 返回空串（不是原文），计分板上会直接消失 |
| 颜色 | 返回值都是纯文本，不含 `&` 颜色代码，配色由计分板自己控制 |

## 9.2 服务器级变量（不需要玩家在线，控制台可用）

| 变量 | 含义 | 无数据时 |
|---|---|---|
| `%liudungeon_dungeons%` | 已加载的副本数量 | `0` |
| `%liudungeon_instances%` | 全服运行中的实例数 | `0` |
| `%liudungeon_instances_creating%` | 正在创建中的实例数 | `0` |
| `%liudungeon_players_in_dungeon%` | 全服在副本内的在线玩家数 | `0` |
| `%liudungeon_parties%` | 全服队伍数量 | `0` |
| `%liudungeon_chunk_tickets%` | 当前区块票据数量 | `0` |

## 9.3 玩家 / 副本实例变量（需要玩家在线）

| 变量 | 含义 | 示例 |
|---|---|---|
| `%liudungeon_in_dungeon%` | 是否在副本中 | `true` / `false` |
| `%liudungeon_dungeon%` | 当前副本定义 ID | `abyss_01` |
| `%liudungeon_dungeon_name%` | 当前副本显示名（已去色） | `深渊回廊` |
| `%liudungeon_instance_id%` | 实例短 ID | `3f9a1c02` |
| `%liudungeon_instance_status%` | 实例生命周期状态 | `进行中` / `准备中` / `已完成` / `已失败` / `已取消` / `清理中` |
| `%liudungeon_instance_time%` | 本局已运行秒数 | `423` |
| `%liudungeon_instance_time_clock%` | 本局已运行时间 `mm:ss` | `07:03` |
| `%liudungeon_instance_players%` | 本实例在线人数 | `4` |
| `%liudungeon_instance_kills%` | 本实例累计击杀 | `156` |
| `%liudungeon_instance_deaths%` | **自己**在本局的死亡次数 | `2` |
| `%liudungeon_mobs_alive%` | 本实例当前存活怪物数 | `23` |
| `%liudungeon_group_count%` | 本副本配置的怪物组总数 | `8` |
| `%liudungeon_waves_cleared%` | 已清（完成或跳过）的怪物组数 | `5` |
| `%liudungeon_stage%` | 当前阶段 ID | `boss_room` |
| `%liudungeon_stage_name%` | 当前阶段显示名 | `BOSS 房间` |
| `%liudungeon_stage_index%` | 当前是第几个阶段（从 1 起） | `3` |
| `%liudungeon_stage_count%` | 本副本阶段总数 | `5` |
| `%liudungeon_stage_elapsed%` | 当前阶段已进行秒数 | `48` |
| `%liudungeon_zone_id%` | 自己所在区域 ID | `hall_a` |
| `%liudungeon_zone%` | 自己所在区域显示名 | `前厅` |
| `%liudungeon_revive_left%` | 剩余复活次数（无限时为 `∞`） | `2` |
| `%liudungeon_pending_revive%` | 当前倒下（等待复活）人数 | `1` |
| `%liudungeon_player_state%` | 自己的生存状态 | `ALIVE` / `DOWNED` / `DEAD` |

## 9.4 带参数的变量（7 个，都要求人在副本里）

参数按原样大小写匹配配置里的名字，必须与副本配置完全一致。

| 变量 | 含义 | 无数据时 |
|---|---|---|
| `%liudungeon_group_alive_<组名>%` | 该怪物组当前存活数 | 组不存在 → `0` |
| `%liudungeon_group_killed_<组名>%` | 该怪物组累计击杀 | 组不存在 → `0` |
| `%liudungeon_group_cleared_<组名>%` | 该怪物组是否已清空 | 组不存在 → `false` |
| `%liudungeon_reward_pity_<奖励名>%` | 该奖励的保底进度（连续未出次数） | **`0`** —— 奖励不存在 / 没配保底 / 无存档，一律返回数字 `0`，不是「—」 |
| `%liudungeon_zone_in_<区域ID>%` | 指定区域内的玩家数 | → `0` |
| `%liudungeon_var_<变量名>%` | 透传脚本 `setVar` 写入的实例变量 | 不存在 → 空串 |

`var_` 是最灵活的一个：脚本里 `setVar('房间进度', 3)`，计分板写
`%liudungeon_var_房间进度%` 就能直接显示，**不需要改插件代码**。

## 9.5 队伍变量（10 个，需要玩家在线，**不需要在副本里**）

| 变量 | 含义 | 无数据时 |
|---|---|---|
| `%liudungeon_party_in%` | 是否在队伍中 | 模块未加载 → 空串 |
| `%liudungeon_party_size%` | 队伍总人数（含离线） | 无队伍 → `0` |
| `%liudungeon_party_online%` | 队伍在线人数 | 无队伍 → `0` |
| `%liudungeon_party_max%` | 队伍人数上限 | ⚠ 队伍模块未加载时返回**空串**。另外它读的是**全服配置** `party.max-size`（默认 4），不是「你这个队伍的上限」（本插件没有 per-party 上限） |
| `%liudungeon_party_name%` | 队伍名（已去色） | 无队伍 → 空串 |
| `%liudungeon_party_leader%` | 队长名 | 无队伍 → 空串 |
| `%liudungeon_party_isleader%` | 自己是否队长 | 无队伍 → `false` |
| `%liudungeon_party_loot%` | 战利品分配模式 | 无队伍 → 空串 |
| `%liudungeon_party_exp%` | 经验共享模式 | 无队伍 → 空串 |
| `%liudungeon_party_scope%` | 共享范围 | 无队伍 → 空串 |

## 9.6 写计分板的实用建议

- 想显示「只在副本内才出现的一行」，直接写 `%liudungeon_stage_name%`，
  副本外它天然是空白，不需要额外判断。
- 判断「现在能不能显示副本信息」用 `%liudungeon_in_dungeon%`（`true`/`false`），
  不要用 `%liudungeon_dungeon%` 是否为空 —— 两者行为是分层的。
- `%liudungeon_instance_status%` 是**实例生命周期**状态，
  和副本内的「阶段」是两套状态机，别混用。
- 服务器级 6 个变量可以放心用在 TAB 表头、公告板里（不需要玩家上下文）。


---
