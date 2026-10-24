#!/usr/bin/env bash
# scripts/verify-delivery-chain.sh — **Pt → Pi → LLM 交付链路**的端到端验证
#
# 目的：回答一个 Pt 长期没回答的问题——
#   **「Pt 说它注入了的东西，真的到 LLM 面前了吗？」**
#
# 为什么需要这个脚本（issue pt-delivery-chain-verification 的核心盲区）：
#   Pt 的所有既有观测都是**自报**：
#     - `agent:before_agent_start ok` → "我返回了 N 字符的 systemPrompt"（Pt 侧计数）
#     - `provider:trace`             → "我看到的请求体里有 Pt 段"（Pt 自己抽的）
#   两者**都是 Pt 自己说的**。若 Pt 的抽取/注入逻辑本身有 bug，它会**一致地错**，
#   看起来一切正常 → **循环论证**。而链路中间隔着 Pi 的拼接与 provider 的 body 组装，
#   这两段对 Pt 而言原本是**黑盒**。
#
# 本脚本的做法（**三方独立比对**，互相不共享实现）：
#   ① Pt 自报      —— `.pt/logs/pt-<session>.log` 的 `provider:trace`（Pt 抽的 systemSha）
#   ② 独立证人    —— `scripts/probe/witness-probe.ts`（不 import Pt 任何代码，自己抽 systemSha）
#   ③ 物理证据    —— 证人落盘的 `call-<n>-system.md` 原文（sha 由脚本现算）
#   三者的 sha 必须**逐字节相等** → 链路被证明打通
#
# 判定：
#   ✅ PASS  三方 sha 一致 + Pt 注入段在证据原文里可定位 + 长度自洽
#   ❌ FAIL  任一不一致 / Pt 说注入了但证据里找不到注入段
#   ⚠️ SKIP  环境不具备（无 pi / 无 provider 凭据）→ 不算失败，但**必须显式报出来**
#
# 用法：
#   bash scripts/verify-delivery-chain.sh [选项]
#     --cwd <dir>        在指定目录跑（默认当前目录）
#     --profile <name>   Pt profile（默认 pt-dev）
#     --prompt <text>    测试 prompt（默认"只回复 OK"）
#     --keep             保留 .pt/verify/ 产出（默认保留——它是证据）
#     --json             机器可读输出（给 CI 用）
#
# 退出码：0=PASS  1=FAIL  2=SKIP（环境不具备）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_CWD="$PWD"
PROFILE="pt-dev"
PROMPT="只回复 OK"
JSON_OUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) TARGET_CWD="${2:?--cwd 缺值}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile 缺值}"; shift 2 ;;
    --prompt) PROMPT="${2:?--prompt 缺值}"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done

VERIFY_DIR="$TARGET_CWD/.pt/verify"
WITNESS_DIR="$VERIFY_DIR/witness"
LOG_DIR="$TARGET_CWD/.pt/logs"
say() { [ "$JSON_OUT" -eq 1 ] || echo "$@" >&2; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ========== 0. 环境前置 ==========
command -v pi >/dev/null 2>&1 || { say "SKIP: 找不到 pi 命令"; exit 2; }
command -v jq  >/dev/null 2>&1 || { say "SKIP: 找不到 jq"; exit 2; }
[ -d "$TARGET_CWD" ] || { say "SKIP: 目标目录不存在"; exit 2; }

# 记录跑之前的日志基线（用于定位本次 session 的日志文件）
MARKER="$(mktemp)"
touch "$MARKER"

# 清掉旧的证人产出（避免上一轮残留干扰）
rm -rf "$WITNESS_DIR"
mkdir -p "$WITNESS_DIR"

say "=== 交付链路验证 ==="
say "目标目录: $TARGET_CWD"
say "profile:   $PROFILE"
say "证人:      $SCRIPT_DIR/probe/witness-probe.ts"
say ""

# ========== 1. 跑一次真实会话（Pt + 证人 同时装载）============
# 证人以 package 形式装载：临时 settings 里加 packages 路径。
# 用 PI_ 的环境变量不行（pi 没有这种扩展装载开关）→ 走项目 .pi/settings.json 的 packages。
# 为不污染用户项目，临时在目标目录写一个 .pi/settings.json（先备份）。
SETTINGS_DIR="$TARGET_CWD/.pi"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
BACKUP=""
if [ -f "$SETTINGS_FILE" ]; then
  BACKUP="$(mktemp)"
  cp "$SETTINGS_FILE" "$BACKUP"
fi
mkdir -p "$SETTINGS_DIR"

# 构造 settings：保留原 packages，追加证人 + Pt 源码
WITNESS_PKG_DIR="$SCRIPT_DIR/probe"
if [ -n "$BACKUP" ]; then
  ORIG_PACKAGES="$(jq -c '.packages // []' "$BACKUP")"
else
  ORIG_PACKAGES='[]'
fi
jq -n --argjson orig "$ORIG_PACKAGES" --arg pt "$PT_ROOT" --arg witness "$WITNESS_PKG_DIR" \
  '{packages: ($orig + [$pt, $witness] | unique)}' > "$SETTINGS_FILE"

cleanup() {
  if [ -n "$BACKUP" ]; then cp "$BACKUP" "$SETTINGS_FILE"; rm -f "$BACKUP"
  else rm -f "$SETTINGS_FILE"; fi
  rm -f "$MARKER"
}
trap cleanup EXIT

say "[1/4] 跑真实会话（Pt + 独立证人）..."
PI_OUT="$(mktemp)"
( cd "$TARGET_CWD" && pi -p --pt-profile "$PROFILE" "$PROMPT" ) > "$PI_OUT" 2>&1
PI_EXIT=$?
say "      pi exit=$PI_EXIT"
[ -s "$PI_OUT" ] && say "      输出: $(head -c 200 "$PI_OUT" | tr '\n' ' ')"

# ========== 2. 定位本次 session 的两份观测 ==========
say "[2/4] 定位观测产物..."

# ② Pt 侧：本次 session 的日志（按 mtime 新于 MARKER）
PT_LOG="$(find "$LOG_DIR" -name 'pt-*.log' -newer "$MARKER" -type f 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | head -1)"
[ -n "$PT_LOG" ] || fail "未找到本次 session 的 Pt 日志（.pt/logs/pt-*.log 无新增）——Pt 可能没装载"
SESSION_ID="$(basename "$PT_LOG" .log)"; SESSION_ID="${SESSION_ID#pt-}"
say "      sessionId=$SESSION_ID"
say "      Pt 日志: $(basename "$PT_LOG")"

# ② 证人侧：本次 session 的证人记录
WITNESS_IDX="$WITNESS_DIR/index.ndjson"
[ -f "$WITNESS_IDX" ] || fail "未找到证人记录（$WITNESS_IDX 不存在）——证人扩展可能没装载"
WITNESS_RECS="$(jq -c --arg sid "$SESSION_ID" 'select(.sessionId == $sid)' "$WITNESS_IDX")"
[ -n "$WITNESS_RECS" ] || fail "证人索引里没有本 session 的记录（sessionId=$SESSION_ID）"
W_CALLS="$(echo "$WITNESS_RECS" | wc -l | tr -d ' ')"
say "      证人记录: $W_CALLS 次调用"

# ③ Pt 侧 provider:trace
PT_TRACES="$(jq -c 'select(.msg == "provider:trace")' "$PT_LOG")"
[ -n "$PT_TRACES" ] || fail "Pt 日志里没有 provider:trace——Layer 3 观测没跑起来"
P_CALLS="$(echo "$PT_TRACES" | wc -l | tr -d ' ')"
say "      Pt trace: $P_CALLS 次调用"

# ========== 3. 三方比对 ==========
say "[3/4] 三方独立比对..."

# 每次调用逐一比对（Pt trace 按时间序 ↔ 证人按 call 序）
MISMATCH=0
CHECKED=0
IDX=0
while IFS= read -r p_trace; do
  IDX=$((IDX+1))
  w_rec="$(echo "$WITNESS_RECS" | sed -n "${IDX}p")"
  [ -n "$w_rec" ] || { say "      调用 $IDX: 证人缺记录"; MISMATCH=$((MISMATCH+1)); continue; }

  p_sha="$(echo "$p_trace" | jq -r '.ctx.systemSha // ""')"
  p_len="$(echo "$p_trace" | jq -r '.ctx.systemLen // 0')"
  p_model="$(echo "$p_trace" | jq -r '.ctx.model // ""')"
  p_inj="$(echo "$p_trace" | jq -r '.ctx.injection // ""')"
  w_sha="$(echo "$w_rec" | jq -r '.systemSha // ""')"
  w_len="$(echo "$w_rec" | jq -r '.systemLen // 0')"
  w_model="$(echo "$w_rec" | jq -r '.model // ""')"

  CHECKED=$((CHECKED+1))
  if [ -z "$p_sha" ] || [ "$p_sha" = "null" ]; then
    say "      调用 $IDX: Pt 没记 systemSha（形状不认识？）"; MISMATCH=$((MISMATCH+1)); continue
  fi
  if [ "$p_sha" != "$w_sha" ]; then
    say "      调用 $IDX: ❌ sha 不一致  Pt=$p_sha  证人=$w_sha"
    MISMATCH=$((MISMATCH+1)); continue
  fi
  if [ "$p_len" != "$w_len" ]; then
    say "      调用 $IDX: ❌ 长度不一致  Pt=$p_len  证人=$w_len"
    MISMATCH=$((MISMATCH+1)); continue
  fi
  if [ "$p_model" != "$w_model" ]; then
    say "      调用 $IDX: ❌ 模型不一致  Pt=$p_model  证人=$w_model"
    MISMATCH=$((MISMATCH+1)); continue
  fi
  say "      调用 $IDX: ✅ sha 一致 ${p_sha:0:12}… len=$p_len model=$p_model injection=$p_inj"
done <<< "$PT_TRACES"

[ "$CHECKED" -gt 0 ] || fail "没有可比的调用对（Pt trace 与证人记录无法对齐）"

# ========== 4. 物理证据核验 ==========
say "[4/4] 物理证据核验（证人落盘的原文）..."

# 跨平台 sha256：macOS 是 `shasum -a 256`，Linux 是 `sha256sum`
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  else
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  fi
}

EVIDENCE_FILE="$WITNESS_DIR/$SESSION_ID/call-1-system.md"
EVIDENCE_SHA="$(sha256_of "$EVIDENCE_FILE")"
if [ -z "$EVIDENCE_SHA" ]; then
  say "      ⚠️ 证据文件缺失（$EVIDENCE_FILE）"
  MISMATCH=$((MISMATCH+1))
else
  FIRST_P_SHA="$(echo "$PT_TRACES" | head -1 | jq -r '.ctx.systemSha // ""')"
  if [ "$EVIDENCE_SHA" = "$FIRST_P_SHA" ]; then
    say "      ✅ 证据原文现算 sha == Pt 记录的 sha（${EVIDENCE_SHA:0:12}…）"
  else
    say "      ❌ 证据 sha=$EVIDENCE_SHA != Pt sha=$FIRST_P_SHA"
    MISMATCH=$((MISMATCH+1))
  fi

  # 注入段必须**真的在证据原文里**（不是只有 hash 对上）
  if grep -q "当前任务上下文" "$EVIDENCE_FILE" 2>/dev/null; then
    say "      ✅ 证据原文含 Pt 注入段标记（内容真的在 LLM 面前）"
  else
    say "      ❌ 证据原文里找不到 Pt 注入段标记——Pt 说注入了，LLM 面前却没有"
    MISMATCH=$((MISMATCH+1))
  fi
fi

# ========== 判定 ==========
if [ "$MISMATCH" -gt 0 ]; then
  say ""
  say "❌ FAIL: $MISMATCH 处不一致（详见上文）"
  if [ "$JSON_OUT" -eq 1 ]; then
    jq -n --argjson checked "$CHECKED" --argjson mismatched "$MISMATCH" --arg sid "$SESSION_ID" \
      '{result:"FAIL", sessionId:$sid, checked:$checked, mismatched:$mismatched}'
  fi
  exit 1
fi

say ""
say "✅ PASS: $CHECKED 次调用三方独立比对全部一致"
say "   （Pt 自报 sha == 独立证人 sha == 证据原文现算 sha）"
say "   证据: $WITNESS_DIR/$SESSION_ID/"
if [ "$JSON_OUT" -eq 1 ]; then
  jq -n --argjson checked "$CHECKED" --arg sid "$SESSION_ID" --arg sha "$FIRST_P_SHA" \
    '{result:"PASS", sessionId:$sid, checked:$checked, systemSha:$sha}'
fi
exit 0
