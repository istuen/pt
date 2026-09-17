#!/usr/bin/env bash
# scripts/setup-pt-symlinks.sh
#
# 建立主仓 .pt/assets + .pt/packs/fullstack symlink，指向 pt-internal 仓
# （v15.x symlink 方案——gitfile + packs/ 布局改为 symlink + assets/）
#
# 设计源：.pt/docs/designs/pt-internal-symlink-plan.md §四 阶段 3
#
# 用法（在主仓根目录运行）：
#   ./scripts/setup-pt-symlinks.sh                          # 默认路径 ~/prot/pt-internal/
#   ./scripts/setup-pt-symlinks.sh --pack-dir ~/pro/pt-internal
#   PT_INTERNAL_DIR=~/pro/pt-internal ./scripts/setup-pt-symlinks.sh
#
# 选项：
#   --pack-dir <path>      pt-internal 仓路径（默认 ~/prot/pt-internal/，可被 PT_INTERNAL_DIR 环境变量覆盖）
#   --prj-pack <name>      prj pack 名（默认 pt-project）
#   --fullstack-name <name> fullstack pack 名（默认 fullstack）
#   --force                覆盖已有 symlink（谨慎使用——可能覆盖指向其他目标的 symlink）
#   -h, --help             显示帮助

set -euo pipefail

# ==================== 默认值 ====================
PT_INTERNAL_DIR="${PT_INTERNAL_DIR:-$HOME/prot/pt-internal}"
PRJ_PACK="pt-project"
FULLSTACK_PACK="fullstack"
FORCE=0

# ==================== 参数解析 ====================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pack-dir)
      PT_INTERNAL_DIR="$2"
      shift 2
      ;;
    --prj-pack)
      PRJ_PACK="$2"
      shift 2
      ;;
    --fullstack-name)
      FULLSTACK_PACK="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "未知参数: $1（用 -h 查看帮助）" >&2
      exit 1
      ;;
  esac
done

# ==================== 检测 ====================
if [[ ! -d "$PT_INTERNAL_DIR" ]]; then
  echo "❌ pt-internal 仓不存在: $PT_INTERNAL_DIR" >&2
  echo "   请先 clone:" >&2
  echo "     git clone https://github.com/istuen/pt-internal.git \"$PT_INTERNAL_DIR\"" >&2
  exit 1
fi

if [[ ! -d "$PT_INTERNAL_DIR/$PRJ_PACK" ]]; then
  echo "❌ prj pack 不存在: $PT_INTERNAL_DIR/$PRJ_PACK" >&2
  echo "   当前 prj pack 名: $PRJ_PACK（用 --prj-pack <name> 指定其他）" >&2
  exit 1
fi

if [[ ! -d "$PT_INTERNAL_DIR/$FULLSTACK_PACK" ]]; then
  echo "❌ fullstack pack 不存在: $PT_INTERNAL_DIR/$FULLSTACK_PACK" >&2
  echo "   当前 fullstack pack 名: $FULLSTACK_PACK（用 --fullstack-name <name> 指定其他）" >&2
  exit 1
fi

# ==================== 主仓根判断 ====================
# 脚本必须在主仓根运行（有 .git 子目录且不是 .pt/ 内部）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -d "$SCRIPT_DIR/.git" && ! -d "$SCRIPT_DIR/../.git" ]]; then
  echo "❌ 请在主仓根目录运行此脚本（当前: $SCRIPT_DIR）" >&2
  exit 1
fi
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ==================== 建 symlink ====================
ensure_symlink() {
  local link_path="$1"
  local target="$2"
  local name="$3"

  if [[ -L "$link_path" ]]; then
    local current_target
    current_target="$(readlink "$link_path")"
    if [[ "$current_target" == "$target" ]]; then
      echo "✅ $name symlink 已正确指向 $target"
      return 0
    fi
    if [[ $FORCE -eq 1 ]]; then
      rm "$link_path"
      echo "🔄 $name symlink 覆盖: $current_target → $target"
    else
      echo "❌ $name symlink 已存在但指向不同目标: $current_target（预期: $target）" >&2
      echo "   用 --force 覆盖" >&2
      exit 1
    fi
  elif [[ -e "$link_path" ]]; then
    echo "❌ $link_path 已存在但不是 symlink（请手动删除或用 --force）" >&2
    exit 1
  else
    echo "🔗 创建 $name symlink: $link_path → $target"
  fi

  ln -s "$target" "$link_path"
}

mkdir -p "$REPO_ROOT/.pt/packs"
ensure_symlink "$REPO_ROOT/.pt/assets" "$PT_INTERNAL_DIR/$PRJ_PACK" "prj"
ensure_symlink "$REPO_ROOT/.pt/packs/$FULLSTACK_PACK" "$PT_INTERNAL_DIR/$FULLSTACK_PACK" "settings($FULLSTACK_PACK)"

echo ""
echo "✅ symlink 建立完成"
echo "   prj:      $REPO_ROOT/.pt/assets → $PT_INTERNAL_DIR/$PRJ_PACK"
echo "   settings: $REPO_ROOT/.pt/packs/$FULLSTACK_PACK → $PT_INTERNAL_DIR/$FULLSTACK_PACK"