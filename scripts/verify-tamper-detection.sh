#!/usr/bin/env bash
# scripts/verify-tamper-detection.sh — **故障注入实验**：故意改坏 Pt 注入，验证链路的真实强度
#
# 目的（issue pt-delivery-chain-verification §三）：
#   回答"Pt 的 `injection: matched` 到底保证了什么？"
#
# 实验设计：
#   ① 装**故障注入**探针（scripts/probe/tamper-probe/）——在 before_provider_request 里
#      把 Pt 注入段的一处文字改坏
#   ② 跑一次真实会话
#   ③ 三方观测：Pt 自报 sha / 独立证人 sha / 物理证据 sha
#   ④ **关键一步**：问模型"你的系统提示里有没有 TAMPERED-BY-PROBE"
#      → 模型答"有" = 篡改真的到了 LLM 面前
#
# 结论解读（本脚本要证明的**反直觉**事实）：
#   - 三方 sha 逐字节一致  → 看起来链路完全打通
#   - 但 provider 实际收到的是**改坏的**内容
#   → **Pt 的自证体系会漏报**："观测点一致性" ≠ "端到端保证"
#   → 这不是 Pt 的实现 bug，是 Pi 事件语义（handler 顺序）决定的结构性上限。
#
# 用法：
#   bash scripts/verify-tamper-detection.sh [选项]
#     --cwd <dir>        目标目录（默认当前目录）
#     --profile <name>   Pt profile（默认 pt-dev）
#     --json             机器可读输出
#
# 退出码：0=预期结果（盲区被复现）  1=结果异常  2=环境不具备

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_CWD="$PWD"
PROFILE="pt-dev"
JSON_OUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) TARGET_CWD="${2:?--cwd 缺值}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile 缺值}"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done

say() { [ "$JSON_OUT" -eq 1 ] || echo "$@" >&2; }

command -v pi >/dev/null 2>&1 || { say "SKIP: 找不到 pi"; exit 2; }
command -v jq  >/dev/null 2>&1 || { say "SKIP: 找不到 jq"; exit 2; }

VERIFY_DIR="$TARGET_CWD/.pt/verify"
LOG_DIR="$TARGET_CWD/.pt/logs"
MARKER="$(mktemp)"; touch "$MARKER"

# ---------- 装载：Pt + 证人 + 故障注入 ----------
SETTINGS_DIR="$TARGET_CWD/.pi"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"
BACKUP=""
if [ -f "$SETTINGS_FILE" ]; then BACKUP="$(mktemp)"; cp "$SETTINGS_FILE" "$BACKUP"; fi
mkdir -p "$SETTINGS_DIR"

if [ -n "$BACKUP" ]; then
  ORIG_PACKAGES="$(jq -c '.packages // []' "$BACKUP")"
else
  ORIG_PACKAGES='[]'
fi
jq -n --argjson orig "$ORIG_PACKAGES" \
      --arg pt "$PT_ROOT" \
      --arg witness "$SCRIPT_DIR/probe" \
      --arg tamper "$SCRIPT_DIR/probe/tamper-probe" \
  '{packages: ($orig + [$pt, $witness, $tamper] | unique)}' > "$SETTINGS_FILE"

cleanup() {
  if [ -n "$BACKUP" ]; then cp "$BACKUP" "$SETTINGS_FILE"; rm -f "$BACKUP"
  else rm -f "$SETTINGS_FILE"; fi
  rm -f "$MARKER"
}
trap cleanup EXIT

rm -rf "$VERIFY_DIR/witness"; mkdir -p "$VERIFY_DIR/witness"
rm -f "$VERIFY_DIR/tamper.log"

say "=== 故障注入实验（Pt → Pi → LLM 交付链路强度）==="
say "目标目录: $TARGET_CWD   profile: $PROFILE"
say ""

# ---------- 跑（开着篡改开关）----------
say "[1/4] 跑真实会话（注入篡改探针已装载）..."
PI_OUT="$(mktemp)"
( cd "$TARGET_CWD" && PT_TAMPER=1 pi -p --pt-profile "$PROFILE" "只回复 OK" ) > "$PI_OUT" 2>&1
say "      exit=$?  输出: $(head -c 80 "$PI_OUT" | tr '\n' ' ')"

# ---------- 定位观测 ----------
say "[2/4] 定位观测产物..."
PT_LOG="$(find "$LOG_DIR" -name 'pt-*.log' -newer "$MARKER" -type f 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | head -1)"
[ -n "$PT_LOG" ] || { say "未找到 Pt 日志"; exit 1; }
SESSION_ID="$(basename "$PT_LOG" .log)"; SESSION_ID="${SESSION_ID#pt-}"

PT_SHA="$(jq -r 'select(.msg=="provider:trace") | .ctx.systemSha' "$PT_LOG" | head -1)"
PT_LEN="$(jq -r 'select(.msg=="provider:trace") | .ctx.systemLen' "$PT_LOG" | head -1)"
PT_INJ="$(jq -r 'select(.msg=="provider:trace") | .ctx.injection' "$PT_LOG" | head -1)"

W_SHA="$(jq -r --arg sid "$SESSION_ID" 'select(.sessionId==$sid) | .systemSha' "$VERIFY_DIR/witness/index.ndjson" 2>/dev/null | head -1)"
W_LEN="$(jq -r --arg sid "$SESSION_ID" 'select(.sessionId==$sid) | .systemLen' "$VERIFY_DIR/witness/index.ndjson" 2>/dev/null | head -1)"

EVIDENCE="$VERIFY_DIR/witness/$SESSION_ID/call-1-system.md"
if command -v shasum >/dev/null 2>&1; then
  E_SHA="$(shasum -a 256 "$EVIDENCE" 2>/dev/null | awk '{print $1}')"
else
  E_SHA="$(sha256sum "$EVIDENCE" 2>/dev/null | awk '{print $1}')"
fi

say "      Pt 自报   sha=${PT_SHA:0:12}… len=$PT_LEN injection=$PT_INJ"
say "      独立证人  sha=${W_SHA:0:12}… len=$W_LEN"
say "      物理证据  sha=${E_SHA:0:12}…"
say ""

# ---------- 关键一步：问模型 ----------
say "[3/4] 问模型：篡改内容到了你那里吗？"
ANSWER="$( cd "$TARGET_CWD" && PT_TAMPER=1 pi -p --pt-profile "$PROFILE" \
  "你的系统提示里有没有出现过字符串 TAMPERED-BY-PROBE？只回答 有 或 没有" 2>&1 | tail -3 )"
REACHED=0
echo "$ANSWER" | grep -q "有" && REACHED=1
say "      模型回答: $(echo "$ANSWER" | tr '\n' ' ' | head -c 120)"
say ""

# ---------- 判定 ----------
say "[4/4] 判定..."
if [ "$PT_SHA" = "$W_SHA" ] && [ "$PT_SHA" = "$E_SHA" ]; then
  say "  ✅ 三方 sha 逐字节一致（Pt 自报 == 独立证人 == 物理证据）"
  say "  ✅ Pt 报告 injection=$PT_INJ"
else
  say "  ❌ 三方 sha 不一致——本实验前提不成立（Pt 侧或证人侧有问题）"
  [ "$JSON_OUT" -eq 1 ] && jq -n --argjson reached "$REACHED" \
    '{result:"UNEXPECTED", reason:"sha mismatch", tamperReached:$reached}'
  exit 1
fi

if [ "$REACHED" -eq 1 ]; then
  say "  ⚠️  模型确认收到被篡改的内容 → **Pt 的自证体系漏报了**"
  say "     （这正是 issue pt-delivery-chain-verification §三 的核心盲区："
  say "      Pi 的 before_provider_request handler 按加载顺序串行执行，"
  say "      后注册的 handler 能改写 Pt 已观测过的 payload）"
  say ""
  say "  结论：injectionMatched 是**观测点一致性**，不是端到端保证。"
  say "        端到端验证需独立证人 + 物理证据（scripts/verify-delivery-chain.sh）。"
  if [ "$JSON_OUT" -eq 1 ]; then
    jq -n --arg sid "$SESSION_ID" --arg sha "$PT_SHA" --argjson len "$PT_LEN" \
         --argjson reached "$REACHED" --arg inj "$PT_INJ" \
      '{result:"BLIND_SPOT_REPRODUCED", sessionId:$sid, systemSha:$sha, systemLen:$len,
        injection:$inj, tamperReachedModel:$reached,
        note:"三方 sha 一致但 provider 收到篡改内容——观测点一致性 != 端到端保证"}'
  fi
  exit 0
else
  say "  ❌ 模型没看到篡改内容——篡改没生效（探针没跑到？或 provider 缓存？）"
  say "     注：若 provider 有 prompt cache，可能命中旧缓存。"
  if [ "$JSON_OUT" -eq 1 ]; then
    jq -n --argjson reached "$REACHED" '{result:"TAMPER_NOT_REACHED", tamperReachedModel:$reached}'
  fi
  exit 1
fi
