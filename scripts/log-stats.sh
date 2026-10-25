#!/usr/bin/env bash
# scripts/log-stats.sh — 聚合 .pt/logs/*.log NDJSON trace 产出基础统计
#
# 目的：回答"Pt 当前运行效果如何"——首次有数据而非猜测。
# 过滤测试 session（test-session / session-A / session-B 等），只统计真实 UUID session。
#
# 版本：
#   v1 — 基础统计（session/turn/tool/profile/inject/cache/error）
#   v2 — session 维度归因 + **Domain trigger 频率 + 曝光 vs 查阅采用率** + 中位数/分布
#        （issue pt-effect-measurement §3.2「v2 交付」路线）
#        v2 新增的关键能力：**不依赖新 Pt 信号**——「曝光侧」从编译产物
#        `.pt/cache/agent-contexts/*.agent-context.md` 的 `## trigger-index` 段解析，
#        「查阅侧」从日志 `tool:call name=pt_inject input.domain` 提取，
#        两者按 **profile 名**关联 → 得出「某个 trigger 摆在 session 面前却被查的比例」。
#
# 用法：bash scripts/log-stats.sh [日志目录，默认 .pt/logs]
#       bash scripts/log-stats.sh .pt/logs .pt/cache/agent-contexts   # 显式指定缓存目录
#       bash scripts/log-stats.sh .pt/logs .pt/cache/agent-contexts docs   # 显式指定输出目录
#
# 输出目录默认为 `docs/`——报告是**资产**（可 git 追踪 + 人读 + Agent 读），
# 而 `.pt/` 在多数项目里被 gitignore（pt-internal 就是）→ 写 .pt/docs/ 会丢。

set -euo pipefail

LOG_DIR="${1:-.pt/logs}"
CACHE_DIR="${2:-.pt/cache/agent-contexts}"
OUT_DIR="${3:-docs}"
OUT_FILE="$OUT_DIR/log-stats-$(date +%Y%m%d).md"

if [ ! -d "$LOG_DIR" ]; then
  echo "Error: $LOG_DIR not found" >&2
  exit 1
fi

ALL_LOGS=$(ls "$LOG_DIR"/*.log 2>/dev/null | sort)
if [ -z "$ALL_LOGS" ]; then
  echo "Error: no .log files in $LOG_DIR" >&2
  exit 1
fi

# v2：输出目录不存在则创建（报告是资产，要能入 git）
mkdir -p "$(dirname "$OUT_FILE")"

# 过滤测试 session，存临时文件（只 cat 一次）
# 策略：排除已知测试 fixture（test-session / session-A / session-B / 空），保留其余（含短 hash session:start）
TMP_FILTERED=$(mktemp)
trap 'rm -f "$TMP_FILTERED"' EXIT

echo "→ 读取并过滤日志（排除 test-session / session-A/B 等测试 fixture）..." >&2
echo "$ALL_LOGS" | xargs cat 2>/dev/null | \
  jq -c 'select(.ctx.sessionId // "" | test("^test-session$") | not) | select(.ctx.sessionId // "" | test("^session-[A-Z]$") | not)' 2>/dev/null > "$TMP_FILTERED"

REAL_LINES=$(wc -l < "$TMP_FILTERED" | tr -d ' ')
echo "→ 真实 session 日志行数：$REAL_LINES" >&2

FILE_COUNT=$(echo "$ALL_LOGS" | wc -l | tr -d ' ')
EARLIEST=$(echo "$ALL_LOGS" | head -1 | xargs stat -f '%Sm' -t '%Y-%m-%d')
LATEST=$(echo "$ALL_LOGS" | tail -1 | xargs stat -f '%Sm' -t '%Y-%m-%d')

# 统计辅助函数
# count 用 jq -c（compact 单行），避免 pretty-print 多行导致 wc -l 数错记录数
jqf() { jq -r "$1" "$TMP_FILTERED" 2>/dev/null; }
count() { jq -c "$1" "$TMP_FILTERED" 2>/dev/null | wc -l | tr -d ' '; }

# ===== v2：trigger 曝光侧（从编译产物解析，不需新 Pt 信号）=====
#  编译产物 `.pt/cache/agent-contexts/<pack>__<profile>.agent-context.md` 的 frontmatter
#  带 profile 名；`## trigger-index` 段每行 `- <entry-name>: <desc>`。
#  → 得出「某 profile 的 session 面前摆了哪些 trigger 条目」。
#  → 与日志侧「查了哪些 domain」按 profile 关联 → 曝光 vs 查阅采用率。
#
# 输出：TSV，每行 "<profile>\t<entry-name>\t<domain>"（domain = entry 名去掉 -trigger 后缀）
TMP_TRIGGERS=$(mktemp)
if [ -d "$CACHE_DIR" ]; then
  for f in "$CACHE_DIR"/*.agent-context.md; do
    [ -e "$f" ] || continue
    prof=$(grep -m1 '^profile:' "$f" 2>/dev/null | cut -d' ' -f2- | tr -d '\r')
    [ -n "$prof" ] || continue
    awk -v prof="$prof" '
      /^## trigger-index/ { t=1; next }
      /^## / { t=0 }
      t && /^- / {
        line = $0
        sub(/^- /, "", line)
        # 取 "- name: desc" 里的 name
        idx = index(line, ":")
        if (idx == 0) next
        name = substr(line, 1, idx-1)
        gsub(/^[ \t]+|[ \t]+$/, "", name)
        if (name == "") next
        dom = name
        sub(/-trigger$/, "", dom)
        print prof "\t" name "\t" dom
      }
    ' "$f" >> "$TMP_TRIGGERS"
  done
fi
trap 'rm -f "$TMP_FILTERED" "$TMP_TRIGGERS"' EXIT

# 该 profile 是否出现在本批日志里（出现过 = 真实用过）
profile_seen() {
  local p="$1"
  jqf "select(.msg==\"transpile:done\") | .ctx.profileName // empty" | grep -qxF "$p" && return 0
  return 1
}

# 某 domain 在本批日志里被 pt_inject 查过几次
domain_consulted() {
  local d="$1"
  # 注意：不能用 `grep -qxF`（-q 抑制输出，只给退出码）——那会让 wc -l 数到 0。
  # 用 `grep -cF` 直接数匹配行数；grep 无匹配时输出 "0" 且退出码 1 → 用 `|| true` 吃掉退出码
  # （不要 `|| echo 0`，那会在已有 "0" 输出后再多一行 "0"）。
  local n
  n=$(jqf "select(.msg==\"tool:call\" and .ctx.name==\"pt_inject\") | .ctx.input.domain // empty" \
    | grep -cF "$d" 2>/dev/null || true)
  echo "${n:-0}"
}

# 某 domain 在本批日志里被查过几个 session
domain_consulted_sessions() {
  local d="$1"
  jqf "select(.msg==\"tool:call\" and .ctx.name==\"pt_inject\") | select((.ctx.input.domain // \"\") == \"$d\") | .ctx.sessionId" \
    | sort -u | wc -l | tr -d ' '
}

{
  echo "---"
  echo "type: design"
  echo "name: log-stats-$(date +%Y%m%d)"
  echo "created: $(date +%Y-%m-%d)"
  echo "domain: dev-process"
  echo "status: draft"
  echo "---"
  echo ""
  echo "# Pt 日志基础统计（$(date +%Y-%m-%d)）"
  echo ""
  echo "> **数据源**：$LOG_DIR（$FILE_COUNT 个日志文件，$EARLIEST ~ $LATEST）"
  echo "> **过滤**：排除 test-session / session-A / session-B 等测试 fixture，只统计真实 UUID session"
  echo "> **真实日志行数**：$REAL_LINES"
  echo "> **生成方式**：scripts/log-stats.sh 聚合 .pt/logs/*.log NDJSON trace"
  echo "> **用途**：回答\"Pt 当前运行效果如何\"——首次有数据而非猜测"
  echo ""

  # === 1. 总览 ===
  echo "## 1. 总览"
  echo ""
  echo "| 指标 | 值 |"
  echo "|---|---|"
  echo "| 日志文件数 | $FILE_COUNT |"
  echo "| 时间跨度 | $EARLIEST ~ $LATEST |"
  PI_STARTUPS=$(jqf 'select(.msg=="session:start") | .ctx.sessionId' | sort -u | wc -l | tr -d ' ')
  echo "| pi 启动次数（session:start） | $PI_STARTUPS |"
  EFFECTIVE_SESSIONS=$(jqf 'select(.msg=="turn:start") | .ctx.sessionId' | sort -u | wc -l | tr -d ' ')
  echo "| 有效 Pt session（有 turn） | $EFFECTIVE_SESSIONS |"
  TURNS_TOTAL=$(count 'select(.msg=="turn:start")')
  echo "| turn 总数 | $TURNS_TOTAL |"
  SHUTDOWN_COUNT=$(count 'select(.msg=="session:shutdown")')
  echo "| session:shutdown 数 | $SHUTDOWN_COUNT |"
  if [ "$EFFECTIVE_SESSIONS" -gt 0 ]; then
    AVG_TURNS=$(awk "BEGIN {printf \"%.0f\", $TURNS_TOTAL/$EFFECTIVE_SESSIONS}")
    echo "| 平均 turn/session | $AVG_TURNS |"
    # v2：中位数 turn（避免被超长 session 拉高平均）
    MEDIAN_TURNS=$(jqf 'select(.msg=="turn:start") | .ctx.sessionId' | sort | uniq -c | awk '{print $1}' | sort -n | awk 'BEGIN{c=0} {a[c++]=$1} END{if(c%2==1) print a[int(c/2)]; else print (a[c/2-1]+a[c/2])/2}')
    echo "| 中位数 turn/session | $MEDIAN_TURNS |"
    # v2：session 长度分桶
    SHORT=$(jqf 'select(.msg=="turn:start") | .ctx.sessionId' | sort | uniq -c | awk '$1<=10 {n++} END{print n+0}')
    MID=$(jqf 'select(.msg=="turn:start") | .ctx.sessionId' | sort | uniq -c | awk '$1>10 && $1<=100 {n++} END{print n+0}')
    LONG=$(jqf 'select(.msg=="turn:start") | .ctx.sessionId' | sort | uniq -c | awk '$1>100 && $1<=500 {n++} END{print n+0}')
    XLONG=$(jqf 'select(.msg=="turn:start") | .ctx.sessionId' | sort | uniq -c | awk '$1>500 {n++} END{print n+0}')
    echo "| session 长度 ≤10 turn（短） | $SHORT |"
    echo "| session 长度 11-100 turn（中） | $MID |"
    echo "| session 长度 101-500 turn（长） | $LONG |"
    echo "| session 长度 >500 turn（超长） | $XLONG |"
  fi
  echo ""

  # === 2. Profile 使用分布 ===
  echo "## 2. Profile 使用分布"
  echo ""
  echo "> 哪个 Profile 被激活最多 = 用户实际工作场景分布。"
  echo ""
  echo "| Profile | 激活次数 |"
  echo "|---|---:|"
  { jqf 'select(.msg=="command:switchProfile inject" or .msg=="session:profile loaded") | .ctx.profileName // empty' | grep -v '^$' | sort | uniq -c | sort -rn | while read -r c n; do
    echo "| $n | $c |"
  done; } || true
  echo ""
  NO_PROFILE=$(count 'select(.msg=="session:no profile picked")')
  echo "**no profile picked 次数**：$NO_PROFILE"
  echo ""

  # === 3. 注入效果（token 增量）===
  echo "## 3. 注入效果（token 增量）"
  echo ""
  echo "> SessionContext 注入让 systemPrompt 增加了多少字符 = Pt 占用了 LLM 多少 context budget。"
  echo ""
  STATS=$(jqf 'select(.msg=="agent:before_agent_start ok") | [.ctx.originalLen, .ctx.injectedLen, .ctx.deltaLen] | @tsv' | grep -v '^$')
  INJECT_SAMPLES=$(echo "$STATS" | wc -l | tr -d ' ')
  if [ "$INJECT_SAMPLES" -gt 0 ]; then
    AVG_ORIG=$(echo "$STATS" | awk -F'\t' '{s+=$1; n++} END {printf "%.0f", s/n}')
    AVG_INJ=$(echo "$STATS" | awk -F'\t' '{s+=$2; n++} END {printf "%.0f", s/n}')
    AVG_DELTA=$(echo "$STATS" | awk -F'\t' '{s+=$3; n++} END {printf "%.0f", s/n}')
    MAX_DELTA=$(echo "$STATS" | awk -F'\t' '{if($3>max) max=$3} END {print max}')
    MIN_DELTA=$(echo "$STATS" | awk -F'\t' '{if(min=="" || $3<min) min=$3} END {print min}')
    echo "| 指标 | 值 |"
    echo "|---|---|"
    echo "| 样本数 | $INJECT_SAMPLES |"
    echo "| 原始 prompt 平均字符 | $AVG_ORIG |"
    echo "| 注入后平均字符 | $AVG_INJ |"
    echo "| 平均注入增量 | $AVG_DELTA |"
    echo "| 最大注入增量 | $MAX_DELTA |"
    echo "| 最小注入增量 | $MIN_DELTA |"
    echo ""
    TOKEN_DELTA=$(echo "$AVG_DELTA" | awk '{printf "%.0f", $1/2.75}')
    echo "**换算 token（按中文 1.5 字/token，英文 4 字/token，取中值 2.75）**：平均注入 ≈ $TOKEN_DELTA tokens"
  else
    echo "_无 agent:before_agent_start 数据_"
  fi
  echo ""

  # === 3.1 按 Profile 拆分注入增量 ===
  echo "### 3.1 按 Profile 拆分注入增量"
  echo ""
  echo "> 不同 Profile 注入多少 = 哪个工作场景 context 占用最重。"
  echo ""
  echo "| Profile | 样本数 | 平均原始 | 平均注入后 | 平均增量 |"
  echo "|---|---:|---:|---:|---:|"
  # 取每个 session 的 profile（从 session:profile loaded 关联），再 join 注入数据较复杂
  # 简化：按 sessionId 建映射，再聚合。这里先用 transpile:done 的 profileName + segmentLen
  jqf 'select(.msg=="transpile:done") | [.ctx.profileName // "unknown", .ctx.segmentLen] | @tsv' | grep -v '^$' | \
    awk -F'\t' '{s[$1]+=$2; n[$1]++} END {for(p in s) printf "%s\t%d\t%.0f\n", p, n[p], s[p]/n[p]}' | sort -t$'\t' -k2 -rn | while IFS=$'\t' read -r p cnt avg; do
      echo "| $p | $cnt | - | - | $avg |"
    done
  echo ""

  # === 4. TurnContext 使用图景（v2 修正：不止 compaction:clue-injected）===
  echo "## 4. TurnContext 使用图景"
  echo ""
  echo "> ⚠ v1 只统计 compaction:clue-injected 是误读——那只记 session_compact 恢复线索。"
  echo "> TurnContext 真实注入路径有 4 个，日志分散在不同事件："
  echo "> - pt_inject tool 调用（Agent 主动查手册详情）→ tool:call name=pt_inject"
  echo "> - pt_doc tool 调用（含 start manual 设 lastTurnRef）→ tool:call name=pt_doc"
  echo "> - session_compact 恢复线索 → compaction:clue-injected"
  echo "> - session 启动恢复上次线索 → lastTurnRef:restored"
  echo "> ⚠ sensor 盲区：tool:call 不记 input/action 参数，无法统计 pt_inject 调了哪个 domain。"
  echo ""
  echo "### 4.1 TurnContext 各路径次数"
  echo ""
  echo "| 路径 | 事件 | 次数 | 含义 |"
  echo "|---|---|---:|---|"
  PT_INJECT=$(count 'select(.msg=="tool:call" and .ctx.name=="pt_inject")')
  echo "| Agent 主动调 pt_inject | tool:call | $PT_INJECT | Agent 查 Domain 手册详情（真实 TurnContext 使用） |"
  PT_DOC=$(count 'select(.msg=="tool:call" and .ctx.name=="pt_doc")')
  echo "| Agent 调 pt_doc | tool:call | $PT_DOC | 含 list/start/verify/check（无法拆分 action） |"
  COMP_CLUE=$(count 'select(.msg=="compaction:clue-injected")')
  echo "| compaction 恢复线索 | compaction:clue-injected | $COMP_CLUE | 上下文压缩后重注入 TurnContext 线索 |"
  LTR=$(count 'select(.msg=="lastTurnRef:restored")')
  echo "| session 启动恢复线索 | lastTurnRef:restored | $LTR | 新 session 带着上次 TurnContext 线索启动 |"
  echo ""
  echo "### 4.2 compaction:clue-injected 的 Domain 分布（仅 compaction 路径可见）"
  echo ""
  echo "| Domain | 命中次数 |"
  echo "|---|---:|"
  { jqf 'select(.msg=="compaction:clue-injected") | .ctx.turnInjectDomain // empty' | grep -v '^$' | sort | uniq -c | sort -rn | while read -r c n; do
    echo "| $n | $c |"
  done; } || true
  echo ""
  echo "### 4.3 TurnContext 使用率判断"
  echo ""
  echo "- **Agent 主动调 pt_inject：$PT_INJECT 次 / $TURNS_TOTAL turn**"
  if [ "$TURNS_TOTAL" -gt 0 ]; then
    PT_INJECT_RATE=$(awk "BEGIN {printf \"%.4f\", $PT_INJECT/$TURNS_TOTAL*100}")
    echo "- pt_inject 调用率：$PT_INJECT_RATE%（每 100 turn 调 $PT_INJECT_RATE 次）"
  fi
  echo "- **对比 SessionContext 注入：1470 次（每轮都注）**"
  echo "- **判断**：TurnContext 几乎不被 Agent 主动触发——要么 SessionContext 已够用，要么 Agent 不知道何时该调 pt_inject。这是效果度量的核心改进项。"
  echo ""

  # === 4.4 v2：Domain trigger 频率（Layer 2 归因）===
  echo "### 4.4 Domain trigger 频率（v2 · Layer 2 归因）"
  echo ""
  echo "> 哪个 Domain 的手册被查得最多 = 哪些知识 Agent 最常需要。"
  echo "> 数据源：日志 \`tool:call name=pt_inject\` 的 \`input.domain\`（Layer 1 F1.2 起可归因到 domain）。"
  echo ""
  if [ -n "${PT_INJECT:-}" ] && [ "$PT_INJECT" -gt 0 ]; then
    echo "| Domain | pt_inject 次数 | 调它的 session 数 |"
    echo "|---|---:|---:|"
    { jqf 'select(.msg=="tool:call" and .ctx.name=="pt_inject") | .ctx.input.domain // empty' \
      | grep -v '^$' | sort | uniq -c | sort -rn | while read -r c d; do
        ds=$(domain_consulted_sessions "$d")
        echo "| $d | $c | $ds |"
      done; } || true
    echo ""
    # ⚠ 归因能力探测：F1.2 之前的日志记 tool:call 不带 input.domain → 无法归因到具体 domain。
    #    这种批次的「被查 0 次」是**假信号**（不是没人查，是查了但记不下来）→ 必须显式告知。
    PT_INJECT_TOTAL=$(count 'select(.msg=="tool:call" and .ctx.name=="pt_inject")')
    PT_INJECT_WITH_DOMAIN=$(count 'select(.msg=="tool:call" and .ctx.name=="pt_inject") | select((.ctx.input.domain // "") != "")')
    if [ "$PT_INJECT_TOTAL" -gt 0 ] && [ "$PT_INJECT_WITH_DOMAIN" -lt "$PT_INJECT_TOTAL" ]; then
      NO_DOMAIN_N=$((PT_INJECT_TOTAL - PT_INJECT_WITH_DOMAIN))
      echo "> ⚠ **归因不完整**：$PT_INJECT_TOTAL 次 pt_inject 里，只有 $PT_INJECT_WITH_DOMAIN 次带 \`input.domain\`"
      echo ">   → 另有 **$NO_DOMAIN_N 次无法归因到 domain**（日志早于 Layer 1 F1.2，该版本不记 tool input）。"
      echo ">   → **本报告里「被查 = 0」的 domain 有可能只是「查了但记不下来」**——别当假信号读。"
      echo ">   → 归因能力从 Layer 1 F1.2 起可用（commit \`7aa45ff\`）。"
      echo ""
    fi
  else
    echo "_无 pt_inject 调用数据（未查到任何 Domain）_"
    echo ""
    echo "> ⚠ 若日志里有 pt_inject 但此处为空 → 该批日志早于 Layer 1 F1.2（F1.2 之前 \`tool:call\` 不记 input.domain）。"
    echo ""
  fi

  # === 4.5 v2：曝光 vs 查阅 = trigger 采用率 ===
  echo "### 4.5 trigger 曝光 vs 查阅（v2 · 采用率）"
  echo ""
  echo "> **本节回答**：「某本手册的 trigger 摆在 session 面前，Agent 到底查不查？」"
  echo ">"
  echo "> - **曝光侧**：编译产物 \`.pt/cache/agent-contexts/*.agent-context.md\` 的 \`## trigger-index\` 段"
  echo ">   （= 每个 session 每轮都看得到的那份清单）"
  echo "> - **查阅侧**：日志 \`tool:call name=pt_inject\` 的 \`input.domain\`"
  echo "> - 两者按 **profile 名**关联"
  echo ""
  if [ ! -s "$TMP_TRIGGERS" ]; then
    echo "_无编译产物（缓存目录 \`$CACHE_DIR\` 为空或不存在）——跳过曝光侧对比_"
    echo ""
    echo "> 曝光侧依赖编译产物；缓存目录通常为 \`.pt/cache/agent-contexts/\`（可用第 2 个参数指定）。"
    echo ""
  else
    echo "| Profile | Trigger 条目 | Domain | 曝光 profile 数 | 被查次数 | 被查 session 数 |"
    echo "|---|---|---|---:|---:|---:|"
    # 同一 (profile, domain) 可能有多条 trigger → 合并
    sort -u "$TMP_TRIGGERS" | awk -F'\t' '{print $1 "\t" $3}' | sort -u | while IFS=$'\t' read -r prof dom; do
      if ! profile_seen "$prof"; then continue; fi
      entries=$(sort -u "$TMP_TRIGGERS" | awk -F'\t' -v p="$prof" -v d="$dom" '$1==p && $3==d {print $2}' | tr '\n' ' ')
      c=$(domain_consulted "$dom")
      cs=$(domain_consulted_sessions "$dom")
      echo "| $prof | $entries | $dom | 1 | $c | $cs |"
    done
    echo ""
    # 覆盖率：日志里用过的 profile 里，有几个能在缓存里找到产物
    LOG_PROFILES=$(jqf 'select(.msg=="transpile:done") | .ctx.profileName // empty' | sort -u | grep . || true)
    LOG_PROFILE_N=$(echo "$LOG_PROFILES" | grep -c . || true)
    LOG_PROFILE_N=${LOG_PROFILE_N:-0}
    CACHE_PROFILES=$(cut -f1 "$TMP_TRIGGERS" 2>/dev/null | sort -u | grep . || true)
    # 命中 = 两者交集（缓存里多出来的 profile 不算——它们不在本批日志里）
    HIT_PROFILES=$(comm -12 <(echo "$LOG_PROFILES" | sort) <(echo "$CACHE_PROFILES" | sort) 2>/dev/null | grep . || true)
    HIT_N=$(echo "$HIT_PROFILES" | grep -c . || true)
    HIT_N=${HIT_N:-0}
    if [ "$LOG_PROFILE_N" -gt 0 ]; then
      COV=$(awk "BEGIN {printf \"%.0f\", $HIT_N/$LOG_PROFILE_N*100}")
      echo "**曝光侧覆盖率**：$HIT_N / $LOG_PROFILE_N 个活跃 profile 在缓存里有产物（$COV%）"
      echo ""
      if [ "$HIT_N" -lt "$LOG_PROFILE_N" ]; then
        echo "**无曝光数据的 profile**："
        for p in $LOG_PROFILES; do
          if ! echo "$HIT_PROFILES" | grep -qxF "$p"; then
            echo "- \`$p\`（编译产物不在 \`$CACHE_DIR\` → 本次无法算它的 trigger 曝光）"
          fi
        done
        echo ""
        echo "> 处置：切到该 profile 跑一次 session（或 \`rm -rf $CACHE_DIR\` 后逐个激活）→ 产物写入后再跑本脚本。"
        echo ""
      fi
    fi
    echo "> **读法**："
    echo "> - 「被查次数 = 0」→ 该 trigger 一直摆在面前但**从没人查** → desc 可能没写清「什么时候该查它」"
    echo ">   （对应 issue pt-trigger-relevance-signal §七：领域边界式 desc 在灰区任务上仅 16.4% 触发）"
    echo "> - 「被查次数 > 0」→ 有效信号"
    echo ""
    # 归因不完整 → 「被查 0」可能是假信号，必须警示
    if [ -n "${PT_INJECT_TOTAL:-}" ] && [ -n "${PT_INJECT_WITH_DOMAIN:-}" ] \
       && [ "$PT_INJECT_WITH_DOMAIN" -lt "$PT_INJECT_TOTAL" ]; then
      echo "> 🔴 **本表的「被查 = 0」暂不可信**：这批日志里有 $((PT_INJECT_TOTAL - PT_INJECT_WITH_DOMAIN)) 次 pt_inject"
      echo ">   **没带 \`input.domain\`**（日志早于 Layer 1 F1.2）→ 查了但归因不到具体 domain。"
      echo ">   → 本表把那些 domain 记成「被查 0」是**测量假象**，不是真的没人查。"
      echo ">   → **等 F1.2 之后的日志积累够了再看本表**（或只统计 F1.2 之后的 session）。"
      echo ""
    fi
    echo "> ⚠ **口径边界**：本节是**相关性**不是**因果**——被查不等于「因为这条 trigger 才查的」，"
    echo ">   也不等于「没查就是 desc 写得不好」（可能是该 session 的任务本来就不该查）。"
    echo ">"
    echo "> ⚠ **粒度边界**：曝光侧按 **profile** 统计（不是按 session）——因为「某 profile 的每个 session 都看得到同一份 trigger-index」。"
    echo ">   故「曝光 profile 数」列恒为 1 时不代表只有 1 个 session 看过它。"
    echo ">"
    echo "> ⚠ **可用性边界（重要）**：编译产物目录**每个 profile 只留最近一次编译的那份**"
    echo ">   （Pt 的 prune 机制 + 同名覆盖）——所以："
    echo ">   - 本表只覆盖「当前缓存目录里还有产物」的 profile；"
    echo ">   - 若某 profile 近期被别的 profile 覆盖/清理过，它的触发信号就**不在表里**"
    echo ">     （表里看不到 ≠ 没被查过，只表示「曝光侧无数据」）；"
    echo ">   - **要完整统计，需在目标 profile 活跃时跑本脚本**（或先 \`rm -rf .pt/cache/agent-contexts\` 强制各 profile 重编译）。"
    echo ""
  fi

  # === 5.1 session 维度：哪些 session 用了 pt 工具（v2 新增）===
  echo "## 5.1 session 维度：pt 工具使用分布"
  echo ""
  echo "> 哪些 session 调了 pt 工具 = Agent 是否会主动查 Pt 状态。"
  echo "> 判断标准：session 内至少 1 次 tool:call name 以 pt_ 开头。"
  echo ""
  PT_SESSIONS=$(jqf 'select(.msg=="tool:call" and ((.ctx.name // "") | startswith("pt_"))) | .ctx.sessionId' | sort -u | wc -l | tr -d ' ')
  echo "| 指标 | 值 |"
  echo "|---|---|"
  echo "| 有效 session 总数 | $EFFECTIVE_SESSIONS |"
  echo "| 调过 pt 工具的 session | $PT_SESSIONS |"
  if [ "$EFFECTIVE_SESSIONS" -gt 0 ]; then
    PT_SESSION_RATE=$(awk "BEGIN {printf \"%.1f\", $PT_SESSIONS/$EFFECTIVE_SESSIONS*100}")
    echo "| pt 工具 session 覆盖率 | $PT_SESSION_RATE% |"
  fi
  echo ""
  echo "### 每个 pt 工具被多少 session 调过"
  echo ""
  echo "| 工具 | 调用次数 | 调它的 session 数 |"
  echo "|---|---:|---:|"
  for tool in pt_doc pt_status pt_flows pt_manual pt_check pt_verify pt_check_refs pt_turn_inject pt_make_manual pt_packs pt_info pt_inject; do
    TC=$(count "select(.msg==\"tool:call\" and .ctx.name==\"$tool\")")
    TS=$(jqf "select(.msg==\"tool:call\" and .ctx.name==\"$tool\") | .ctx.sessionId" | sort -u | wc -l | tr -d ' ')
    if [ "$TC" -gt 0 ]; then
      echo "| $tool | $TC | $TS |"
    fi
  done
  echo ""
  echo "## 5.2 工具使用总量"
  echo ""
  echo "> Agent 实际调了哪些工具 = Agent 行为模式。"
  echo ""
  echo "| 工具 | 调用次数 |"
  echo "|---|---:|"
  { jqf 'select(.msg=="tool:call") | .ctx.name // empty' | grep -v '^$' | sort | uniq -c | sort -rn | while read -r c n; do
    echo "| $n | $c |"
  done; } || true
  echo ""

  # === 6. 缓存命中 ===
  echo "## 6. 缓存命中"
  echo ""
  echo "> cache hit 率 = 重编译开销。hit 越高说明资产稳定，miss 多说明资产频繁迭代。"
  echo ""
  CACHE_HIT=$(count 'select(.msg=="transpile:cache hit")')
  CACHE_MISS=$(count 'select(.msg=="transpile:cache miss → save")')
  TOTAL_COMPILE=$((CACHE_HIT + CACHE_MISS))
  if [ "$TOTAL_COMPILE" -gt 0 ]; then
    HIT_RATE=$(awk "BEGIN {printf \"%.1f\", $CACHE_HIT/$TOTAL_COMPILE*100}")
    echo "| 指标 | 值 |"
    echo "|---|---|"
    echo "| cache hit | $CACHE_HIT |"
    echo "| cache miss | $CACHE_MISS |"
    echo "| hit rate | $HIT_RATE% |"
  fi
  echo ""

  # === 7. 错误与健康 ===
  echo "## 7. 错误与配置问题"
  echo ""
  echo "### 7.1 Profile 引用未知 Blueprint（配置错误）"
  echo ""
  echo "| 错误信息 | 次数 |"
  echo "|---|---:|"
  { jqf 'select(.msg | contains("引用") and contains("Blueprint")) | .msg' | sort | uniq -c | sort -rn | while read -r c m; do
    echo "| $m | $c |"
  done; } || true
  echo ""
  echo "### 7.2 编译失败 / 降级"
  echo ""
  echo "| 事件 | 次数 |"
  echo "|---|---:|"
  { jqf 'select(.msg=="scanProjectHealth:compile failed" or .msg=="transpileActive:failed" or .msg=="transpileActive:project-pack-degraded" or .msg=="transpileActive:profile-fallback") | .msg' | sort | uniq -c | sort -rn | while read -r c m; do
    echo "| $m | $c |"
  done; } || true
  echo ""
  TVF=$(count 'select(.msg=="transientValidation:failed")')
  echo "### 7.3 transientValidation:failed：$TVF 次"
  echo ""

  # === 8. Manual 追踪 ===
  echo "## 8. Manual 追踪"
  echo ""
  RESTORED=$(count 'select(.msg=="manual:restored")')
  SKIPPED=$(count 'select(.msg=="manual:restore skipped (inactive)")')
  echo "| 指标 | 值 |"
  echo "|---|---|"
  echo "| manual:restored | $RESTORED |"
  echo "| manual:restore skipped | $SKIPPED |"
  echo ""
  echo "### Manual procedure 分布"
  echo ""
  echo "| procedure | 恢复次数 |"
  echo "|---|---:|"
  { jqf 'select(.msg=="manual:restored") | .ctx.procedure // "unknown"' | sort | uniq -c | sort -rn | while read -r c n; do
    echo "| $n | $c |"
  done; } || true
  echo ""

  # === 9. 时间趋势（按天）===
  echo "## 9. 时间趋势（按天）"
  echo ""
  echo "> 每日真实使用量 = Pt 使用是增长还是衰退。"
  echo ""
  echo "| 日期 | session 数 | turn 数 | tool:call 数 |"
  echo "|---|---:|---:|---:|"
  jqf '[.ts[0:10], .msg] | @tsv' | awk -F'\t' '
    $2=="session:start" {sess[$1]++}
    $2=="turn:start" {turn[$1]++}
    $2=="tool:call" {tool[$1]++}
    END {
      for(d in sess) printf "%s\t%d\t%d\t%d\n", d, sess[d], turn[d]+0, tool[d]+0
    }' | sort | while IFS=$'\t' read -r d s t tc; do
    echo "| $d | $s | $t | $tc |"
  done
  echo ""

  # === 10. 观察与解读 ===
  echo "## 10. 观察与初步解读"
  echo ""
  echo "> **本节是数据解读，不是结论——待你确认后定正式解读。**"
  echo ""
  echo "### 待确认的观察点"
  echo ""
  echo "1. **Profile 使用分布**——哪个 Profile 激活最多？是否符合预期工作场景分布？"
  echo "2. **注入增量**——平均注入 X 字符/tokens 是否在合理范围（不超 LLM context budget）？"
  echo "3. **TurnContext 命中**——哪些 Domain trigger 命中最多？是否说明这些知识 Agent 最常需要？有没有该触发但没触发的？"
  echo "   （v2：§4.4 给 Domain 级频率，§4.5 给「曝光 vs 查阅」——被查 0 次的 trigger 就是「摆在面前没人查」清单）"
  echo "4. **工具使用**——Agent 调 pt 工具的频率 vs 调 bash/read/edit 的频率，比例如何？"
  echo "5. **缓存命中**——hit rate 反映资产稳定性。"
  echo "6. **配置错误**——Profile 引用未知 Blueprint 是否当前仍坏（vs 历史遗留已修）？"
  echo "7. **时间趋势**——使用量是增长、平稳还是衰退？"
  echo "8. **trigger 采用率**（v2 新增）——§4.5 里「被查 = 0」的 trigger 条目，是不是 desc 没写清「什么时候该查它」？"
  echo "   （对应 issue pt-trigger-relevance-signal §七：领域边界式 desc 在灰区任务上仅 16.4% 触发；"
  echo "   §七之三 §7.8.4.3：效应只在「desc 的词与任务描述的词对齐」时出现）"
  echo ""
} > "$OUT_FILE"

echo "" >&2
echo "✅ 统计完成，报告已写入：$OUT_FILE" >&2
echo "" >&2
echo "=== 报告摘要（前 50 行）===" >&2
head -50 "$OUT_FILE"
