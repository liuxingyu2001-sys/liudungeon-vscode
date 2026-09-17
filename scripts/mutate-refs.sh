#!/usr/bin/env bash
# 变异测试：把这次修的每一处逐个改回坏写法，确认自检变红（红 = 断言有牙）。
#
#   bash scripts/mutate-refs.sh
#
# 注意：这些文件**带着未提交的正常改动**，所以还原必须用「变异前先备份到 tmp」，
# 绝不能 git checkout —— 那会把本轮的真实修改一起抹掉（第一次跑就踩了）。
# 每处变异都会断言「替换数符合预期」，避免一个静默没改成的变异被误判成「断言没牙」。
# 目前 22 处：索引层 3、引用类型单一出处 2、诊断 3、路径匹配/列表项 2、悬停 1、
# 别名归一化 1、数据文件 3（containerAliases 的键、chest_rewards 的整份数据、顶层 priority）、
# 插件主配置 7（两份同名 config.yml 的区分、plugin.yml 线索、诊断分派、主配置数据 2、
# 副本文件名清单 1）。
#
# 「变红」的判定也必须看**测试摘要行**，不能只看退出码：日志文件建不出来、
# node 起不来、npm 脚本改名…… 都会让退出码非 0，只看退出码就会把"根本没跑起来"
# 当成"断言抓到了" —— 这正是本脚本第 3 个坑（前两个是 cd 目录与 git checkout），
# 第 4 个是"被中断时变异留在文件里"（见下面的 trap）。
set -uo pipefail
cd "$(dirname "$0")/.."   # 仓库根

FILES=(data/config-files.json data/plugin-config.json src/server/index-store.ts src/server/diagnostics.ts \
       src/server/references.ts src/server/yaml-shared.ts src/server/yaml-context.ts src/server/hover.ts)
BAK=$(mktemp -d)
LOG="$BAK/mut.log"
# 退出时**先还原再删备份**：脚本被 Ctrl-C、被 timeout 杀掉时，最后那次变异会留在
# 文件里 —— 下一次跑就把它当成"基线"，于是基线本身是红的、变异反而"未生效"。
# 这不是假设：第一次被 timeout 杀掉后就留下了 M18 的变异（源码里躺着一句 `if (false)`），
# 下一次跑出现「还原后没有全绿」，查了半天才发现污染源是上一次的自己。
#
# 只写 EXIT trap 还不够：bash 收到 SIGTERM 而没设对应 trap 时会**直接死掉，EXIT trap
# 不执行**。所以要显式接住这几个信号再 exit，让 EXIT trap 兜底。
SNAPSHOT_DONE=0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap '[ "$SNAPSHOT_DONE" = 1 ] && restore; rm -rf "$BAK"' EXIT

snapshot() { for f in "${FILES[@]}"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done; SNAPSHOT_DONE=1; }
restore() { for f in "${FILES[@]}"; do cp "$BAK/$f" "$f"; done; }

# 跑一次 npm test，把「测试摘要行」打到 stdout（没有摘要 = 没跑起来）
run_tests() {
    npm test >"$LOG" 2>&1
    local code=$?
    grep -E '^通过 [0-9]+ 项，失败 [0-9]+ 项' "$LOG" | tail -1
    return $code
}

BAD=0
run_case() {
    local name="$1"
    local line
    line=$(run_tests)
    local code=$?
    if [ -z "$line" ]; then
        echo "  ✗ 跑不起来（日志里没有测试摘要）：$name"
        echo "      ↳ 最后几行日志："
        tail -5 "$LOG" | sed 's/^/        /'
        BAD=$((BAD + 1))
    elif [ $code -ne 0 ]; then
        echo "  ✓ 变红：$name  $line"
    else
        echo "  ✗ 仍然全绿：$name  ← 断言没牙"
        BAD=$((BAD + 1))
    fi
}

# 替换数必须等于期望值，否则当场退出（不是继续跑出一个假的「全绿」）
mutate() {
    local file="$1" old="$2" new="$3" expect="${4:-1}"
    python3 - "$file" "$old" "$new" "$expect" <<'PY'
import io, sys
path, old, new, expect = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
s = io.open(path, encoding='utf-8').read()
got = s.count(old)
if got != expect:
    sys.exit(f'变异未生效：{path} 里 "{old[:44]}" 出现 {got} 次，期望 {expect} 次')
io.open(path, 'w', encoding='utf-8').write(s.replace(old, new))
PY
}

snapshot
echo "=== 变异测试（每一项都应当变红）==="

# 先确认基线（未变异）是绿的：否则"变异变红"里混着"基线本来就红"，
# 根本分不清是哪一边的问题。上一次被中断留下的变异也会让基线变红。
BASE=$(run_tests)
BASE_CODE=$?
if [ -z "$BASE" ] || [ $BASE_CODE -ne 0 ]; then
    echo "  ✗ 基线（未变异）就不是全绿：${BASE:-（日志里没有测试摘要，根本没跑起来）}"
    echo "     先修好再跑；若是上一次被中断留下的变异，见脚本开头的 trap 说明。"
    exit 1
fi
echo "  ✓ 基线全绿：$BASE"

mutate data/config-files.json '        "zones": [' '        "区域": ['
run_case "M1 containerAliases 的键写成容器名（原始 bug：区域类名字全丢）"
restore

mutate src/server/index-store.ts \
    "  const shortName = baseName(file);
  if (!container && (shortName === 'zones.yml' || shortName === 'interacts.yml')) {" \
    "  if (!container && (file === 'zones.yml' || file === 'interacts.yml')) {"
run_case "M2 根节点兜底拿绝对路径比 'zones.yml'（原始 bug：根节点写法收不到）"
restore

mutate src/server/index-store.ts \
    "const containerKind: RefKind = kind === 'points' ? 'zones' : kind;" \
    "const containerKind: RefKind = kind;"
run_case "M3 点位容器别名按 points 取（点位一个都收不到）"
restore

mutate src/server/references.ts \
    "export function refKindOfYamlKey(key: string): RefKind | undefined {" \
    "export function refKindOfYamlKey(key: string): RefKind | undefined {
  return undefined;"
run_case "M4 可校验的 YAML 引用键表失效（YAML 侧引用校验空转）"
restore

mutate src/server/references.ts \
    "export function kindOfJsMethod(method: string): RefKind | undefined {" \
    "export function kindOfJsMethod(method: string): RefKind | undefined {
  return undefined;"
run_case "M5 方法名 → 引用类型的表失效（括号里退回一长串方法名）"
restore

mutate src/server/diagnostics.ts \
    "const row = rows.find((r) => r.params.length === arity) ?? method;" \
    "const row = method;"
run_case "M6 重载不按实参个数选行（单参 trigger_interact 不校验）"
restore

mutate src/server/diagnostics.ts \
    'const m = /^([^\s:#-][^:#]*?)\s*:/.exec(line);' \
    'const m = /^([A-Za-z_][\w-]*)\s*:/.exec(line);'
run_case "M7 钩子名正则只认 ASCII（中文钩子名不报）"
restore

mutate src/server/references.ts \
    "  const kinds: RefKind[] = ALL_REF_KINDS;" \
    "  const kinds: RefKind[] = ['groups', 'zones', 'rewards', 'stages', 'interacts', 'tasks', 'points'];"
run_case "M8 symbolAt 硬编码 kind 清单（障碍物能补全但跳不过去）"
restore

mutate src/server/yaml-shared.ts \
    "    if (canon && (canon.get(concreteSeg) ?? concreteSeg) === patternSeg) continue;" \
    "    if (canon && concreteSeg === patternSeg) continue;"
run_case "M9 容器别名不归一化（用 obstacles: / 怪物组: 写的文件整棵子树没有补全）"
restore

mutate src/server/yaml-context.ts \
    "    const keep = info.isListItem ? top.indent <= info.indent : top.indent < info.indent;" \
    "    const keep = top.indent < info.indent;"
run_case "M10 列表项不留宿主键/序列框（- id: 下面几行的父路径错一层）"
restore

mutate src/server/diagnostics.ts \
    "  const cfg = CONFIG_FILE_BY_NAME.get(fileName);
  if (!cfg) return out;" \
    "  const cfg = CONFIG_FILE_BY_NAME.get(fileName);
  if (cfg || !cfg) return out;"
run_case "M11 不检查插件读不到的键（开启时候 这类笔误静默失效）"
restore

mutate src/server/diagnostics.ts \
    "    const m = /^\\s*(?:-\\s+)?([^\\s:#-][^:#]*?)\\s*:\\s*(.*)$/.exec(lines[i]);" \
    "    const m = /^\\s*([^\\s:#-][^:#]*?)\\s*:\\s*(.*)$/.exec(lines[i]);"
run_case "M12 引用校验不认列表项里的键（- reward: 通关奖励 不受校验）"
restore

mutate src/server/hover.ts \
    "  const onOwnKey = ctx.lineKey !== null && ctx.lineKey === word.word;" \
    "  const onOwnKey = false;"
run_case "M13 悬停不看光标下的键（根键没说明、子键显示上一级的说明）"
restore

mutate data/config-files.json \
    '      "file": "chest_rewards.yml",' \
    '      "file": "chest_rewards_unused.yml",'
run_case "M14 丢掉 chest_rewards.yml 的数据（宝箱文件一个字都补不出来）"
restore

# M15：顶层 priority 的**键名**改掉（插件 1.4.4 新增）。
# 危害不是"少一条补全"，而是把合法的顶层键报成「插件不读的键」——
# 照文档配了 priority 的服主会把它删掉，于是"把主推副本排第一"静默失效。
# 只改 path 不够：unknown-key 是按**键名**匹配的，path 变了键名还在，
# 于是只有悬停会失效（第一次就是这么写的，实测只红 1 条）。必须连键名一起改。
mutate data/config-files.json \
    $'          "path": "priority",\n          "key": "priority",' \
    $'          "path": "priority",\n          "key": "priority_unused",'
run_case "M15 顶层 priority 的键名没了（照文档配的排序优先级被报成插件不读的键）"
restore

# M16：schemaKeyFor 退回按 basename 认文件 —— 这就是本轮修掉的原始 bug：
# plugins/liudungeon/config.yml（插件主配置）与副本目录里的 config.yml 同名但键名毫无交集，
# 按 basename 认就会拿副本的键名表去套主配置。
mutate src/server/yaml-shared.ts \
    "    return index.isDungeonDir(dir) ? base : PLUGIN_CONFIG_SCHEMA;" \
    "    return base;"
run_case "M16 两份同名 config.yml 不区分（主配置被套上副本键名表，22 条假警告）"
restore

# M17：插件根的内容判定失效 —— 插件根（plugins/liudungeon）里也有一个 config.yml，
# 于是它被当成一个名叫 liudungeon 的副本目录，主配置跟着按副本配置处理（原始 bug 的另一半）。
#
# 注意不能写成 `if (false) continue;`：那样 isPluginRoot 就成了未使用标识符，
# tsc 的 noUnusedLocals 会先把测试拦下（日志里没有测试摘要），跑不到断言。
#
# 也不能只改这一处就算完：夹具里若给 plugins/liudungeon/ 放了 plugin.yml，
# 上一条判定会先把目录认出来，这个变异就静默全绿（第一次跑正是如此）。
# harness 的数据目录夹具刻意不放 plugin.yml，两条判定各有一个变异盯着。
mutate src/server/index-store.ts \
    "  return !DUNGEON_CONTENT_FILES.some((f) => names.has(f));" \
    "  return !DUNGEON_CONTENT_FILES.some(() => true);"
run_case "M17 插件根的内容判定失效（主配置归到名叫 liudungeon 的假副本下）"
restore

# M18：去掉「同目录有 plugin.yml」这条线索 —— 插件源码里的 src/main/resources/config.yml
# 目录名叫 resources，路径形状与插件根完全不像，只剩这一条能认出它是主配置。
mutate src/server/index-store.ts \
    "  if (names.has('plugin.yml')) return true;" \
    "  if (false) return true;"
run_case "M18 plugin.yml 线索失效（打开插件仓库时 src/main/resources/config.yml 被当成副本配置）"
restore

# M19：诊断的分派入口不用 schemaKeyFor（补全/悬停都对、诊断却按 basename 走）。
# 写成 `const name = baseName(...)` 会让 schemaKeyFor 成为未使用导入（同样是 noUnusedLocals
# 先拦下），所以用 `&&` 保持它仍被引用，运行时行为等价于只认 basename。
mutate src/server/diagnostics.ts \
    "  const name = schemaKeyFor(input.filePath, input.index);" \
    "  const name = schemaKeyFor(input.filePath, input.index) && baseName(input.filePath);"
run_case "M19 诊断入口按 basename 认文件（主配置的键全被报成插件不读的键）"
restore

# M20：主配置数据里少一个键 —— 那一行会被报成「插件不读的键」教人删掉，
# 而它恰恰是跨服功能唯一的必配项。
mutate data/plugin-config.json \
    $'    {\n      "path": "server-id",' \
    $'    {\n      "path": "server-id_unused",'
run_case "M20 主配置数据里没有 server-id（跨服必配项被报成插件不读的键）"
restore

# M21：枚举取值与 Java enum 对不上（补全教人写出会被静默回落的值）。
mutate data/plugin-config.json \
    $'      "values": [\n        "YAML",\n        "SQLITE",\n        "MYSQL"\n      ],' \
    $'      "values": [\n        "SQLITE"\n      ],'
run_case "M21 database.type 的取值与 DatabaseType 对不上（补全教人写错）"
restore

# M22：副本文件名清单退回硬编码的那串（漏 obstacles.yml）—— 按文件名放行的地方
# 会整片跳过障碍物文件，那类「开启时候」的笔误又回到静默失效。
mutate src/server/yaml-shared.ts \
    "  return name !== PLUGIN_CONFIG_SCHEMA && CONFIG_FILE_BY_NAME.has(name);" \
    "  return /^(config|monsters|scripts|rewards|zones|interacts|tasks|stages|chest_rewards|gui)\\.ya?ml$/.test(name) || name === 'functions.js';"
run_case "M22 副本文件名清单退回硬编码（漏 obstacles.yml，障碍物文件不再出诊断）"
restore

echo "=== 还原后复跑 ==="
SUMMARY=$(run_tests)
FINAL=$?
echo "$SUMMARY"
if [ $FINAL -ne 0 ] || [ -z "$SUMMARY" ]; then
    echo "  ✗ 还原后没有全绿"$([ -z "$SUMMARY" ] && echo "（日志里没有测试摘要，根本没跑起来）")
    BAD=$((BAD + 1))
fi
echo "--- 与变异前的快照逐文件比对（应全部一致）---"
for f in "${FILES[@]}"; do
    if diff -q "$BAK/$f" "$f" >/dev/null; then echo "  ✓ $f 与快照一致"; else echo "  ✗ $f 与快照不一致"; BAD=$((BAD + 1)); fi
done

# 快照比对放在最后：它同时充当"变异没把文件改坏"的守门人
echo
if [ $BAD -ne 0 ]; then
    echo "变异测试未通过：$BAD 项异常"
    exit 1
fi
echo "变异测试通过：全部变异都变红，且还原后与变异前逐文件一致"
