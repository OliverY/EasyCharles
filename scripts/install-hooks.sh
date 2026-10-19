#!/usr/bin/env bash
# 安装 git hook（软链到 scripts/，改脚本即生效，不用重装）
# 用法：bash scripts/install-hooks.sh
#
# pre-commit → 拦「不能进库的内容」（隐私 / 密钥 / 业务标识）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$(cd "$ROOT" && git rev-parse --git-dir)/hooks"

# 源文件:钩子名 —— git 只认后者，别把源文件名直接当钩子名（踩过）
for pair in "pre-commit-privacy:pre-commit"; do
  src="${pair%%:*}"
  hook="${pair##*:}"
  target="$ROOT/scripts/$src.sh"
  [ -f "$target" ] || { echo "✗ 找不到 $target"; exit 1; }
  ln -sf "../../scripts/$src.sh" "$HOOKS/$hook"
  echo "✓ 已安装 $hook → scripts/$src.sh"
done

echo ""
echo "当前 hooks："
ls -l "$HOOKS" | grep -v sample | grep -E 'pre-commit' || echo "（无）"
echo ""
echo "验证：bash scripts/pre-commit-privacy.sh（暂存区为空应静默退出 0）"
echo "跳过检查：git commit --no-verify（请先想清楚）"
