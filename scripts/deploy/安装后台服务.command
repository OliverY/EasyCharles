#!/bin/bash
# 双击：把 EasyCharles 装成 macOS 后台服务（launchd 用户级 agent）
#
#   · 登录后自动启动（RunAtLoad）
#   · 崩溃自动拉起（KeepAlive + ThrottleInterval=10 防热循环）
#   · 停止并移除自启 → 双击「卸载后台服务.command」
#
# 做的事：读 easy-charles.env（可选）→ 解析 node 绝对路径 → 把本目录的
# local.easycharles.server.plist 填好后写到 ~/Library/LaunchAgents/ 并装载。
#
# 为什么必须解析 node 绝对路径：launchd 给 job 的 PATH 只有
# /usr/bin:/bin:/usr/sbin:/sbin，Homebrew / nvm 装的 node 不在其中，
# run.sh 里的 `command -v node` 会找不到。
#
# 文件名故意不带空格（原因见「启动EasyCharles.command」顶部注释）。

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

LABEL="local.easycharles.server"
PLIST_SRC="$DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/EasyCharles"

pause() { [ -t 0 ] || return 0; read -n 1 -s -r -p "按任意键关闭窗口..."; echo ""; }
die() {
  echo ""
  echo "✖  $*"
  echo ""
  pause
  exit 1
}

# ── 0) 环境检查 ────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "这个脚本只能在 macOS 上双击运行（Linux 请用包内 easy-charles.service）"
[ -f "$PLIST_SRC" ] || die "缺模板文件：${PLIST_SRC}（发布包不完整）"
[ -f "$DIR/run.sh" ] || die "缺 run.sh（发布包不完整）"

# ── 1) 读本地配置（可选）──────────────────────────────────────
PORT="8899"
ADMIN=""
PASSWORD=""
EXTRA_ARGS=""
if [ -f "$DIR/easy-charles.env" ]; then
  # shellcheck disable=SC1091
  . "$DIR/easy-charles.env"
  PORT="${EC_PORT:-$PORT}"
  ADMIN="${EC_ADMIN:-}"
  PASSWORD="${EC_PASSWORD:-}"
  EXTRA_ARGS="${EC_ARGS:-}"
  echo "▸  已读取本地配置：$DIR/easy-charles.env"
fi

DATA_DIR="${EC_DATA_DIR:-$HOME/Library/Application Support/EasyCharles/data}"

# ── 2) 口令（不允许静默用默认值）──────────────────────────────
if [ -z "$PASSWORD" ]; then
  echo ""
  echo "控制台口令是全局单一口令，默认值 123456 只适合本机自用，共享网络下必须改。"
  printf "请输入要使用的口令（直接回车 = 用默认 123456，不安全）: "
  read -r -s PASSWORD
  echo ""
  if [ -z "$PASSWORD" ]; then
    PASSWORD="123456"
    echo "⚠  使用默认口令 123456（局域网内任何人都能进控制台）"
  fi
fi

# ── 3) 解析 node 绝对路径 ─────────────────────────────────────
find_node() {
  if [ -n "${EC_NODE_BIN:-}" ] && [ -x "${EC_NODE_BIN}" ]; then
    printf '%s\n' "$EC_NODE_BIN"
    return 0
  fi
  local c
  c="$(command -v node 2>/dev/null || true)"
  if [ -n "$c" ] && [ -x "$c" ]; then
    printf '%s\n' "$c"
    return 0
  fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  local g
  for g in "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.asdf/installs/nodejs/*/bin/node; do
    if [ -x "$g" ]; then
      printf '%s\n' "$g"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node)" || die "没找到 node。请先安装 Node 22.6+（推荐 23.6+），或在 easy-charles.env 里用 EC_NODE_BIN 指定绝对路径。"
echo "▸  使用 node：${NODE_BIN}（$("$NODE_BIN" -v 2>/dev/null)）"

# ── 4) 准备目录 ────────────────────────────────────────────────
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$DATA_DIR"
echo "▸  数据目录：$DATA_DIR"
echo "▸  日志目录：$LOG_DIR"

# ── 5) 生成 plist ─────────────────────────────────────────────
# XML 转义 + sed 替换转义，两步都要：口令里出现 & < > 会把 plist 写坏
xml_esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed_esc() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
sub() { sed_esc "$(xml_esc "$1")"; }

sed -e "s|__INSTALL_DIR__|$(sub "$DIR")|g" \
  -e "s|__PORT__|$(sub "$PORT")|g" \
  -e "s|__DATA_DIR__|$(sub "$DATA_DIR")|g" \
  -e "s|__PASSWORD__|$(sub "$PASSWORD")|g" \
  -e "s|__ADMIN__|$(sub "$ADMIN")|g" \
  -e "s|__NODE_BIN__|$(sub "$NODE_BIN")|g" \
  -e "s|__EXTRA_ARGS__|$(sub "$EXTRA_ARGS")|g" \
  -e "s|__LOG_DIR__|$(sub "$LOG_DIR")|g" \
  "$PLIST_SRC" >"$PLIST_DST"
echo "▸  已写入：$PLIST_DST"

# ── 6) 装载（已在跑就先摘掉）──────────────────────────────────
# bootout 是**异步**的：紧接着 bootstrap 同一个 label 会因 launchd 还没摘干净而失败
# （Bootstrap failed: 5: Input/output error）。症状很隐蔽 —— 脚本报「已装载」，
# 但 launchctl print 查不到、node 根本没跑（健康检查才发现）。
# 人工双击两次中间隔着几秒，所以碰不到；脚本化部署（毫秒级连续）必然踩中。
# 因此：先等它真的消失，再 bootstrap，并且失败要重试 + 把错误打出来。
UID_N="$(id -u)"
DOMAIN="gui/$UID_N"
BOOT_ERR="$(mktemp)"
trap 'rm -f "$BOOT_ERR"' EXIT

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done

LOADED=0
for _ in $(seq 1 10); do
  if launchctl bootstrap "$DOMAIN" "$PLIST_DST" 2>"$BOOT_ERR"; then
    LOADED=1
    break
  fi
  sleep 0.5
done
if [ "$LOADED" -ne 1 ]; then
  BOOT_MSG="$(cat "$BOOT_ERR" 2>/dev/null)"
  # 老系统没有 bootstrap，退回 load -w；但 load 常常装到**别的域**，
  # 所以之后必须用 print 验证，不能只看它的退出码（这正是上面那个隐蔽 bug 的来源）。
  launchctl load -w "$PLIST_DST" 2>/dev/null || true
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 ||
    die "装载失败（10 次重试都没成功）。
  launchd 报错：${BOOT_MSG}
  手工执行看看：launchctl bootstrap $DOMAIN \"$PLIST_DST\""
fi
echo "▸  已装载 launchd 服务：$LABEL"

# ── 7) 等它就绪并报告 ─────────────────────────────────────────
URL="http://127.0.0.1:$PORT/"
OK=0
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
    OK=1
    break
  fi
  sleep 0.5
done

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
[ -n "$IP" ] || IP="$(ipconfig getifaddr en1 2>/dev/null || true)"

echo ""
if [ "$OK" -eq 1 ]; then
  echo "✅ EasyCharles 已作为后台服务运行（开机自启 + 崩溃自动拉起）"
else
  echo "⚠  服务已装载，但 $URL 还没就绪。看日志："
  echo "     tail -50 \"$LOG_DIR/server.err.log\""
fi
echo ""
echo "   控制台          $URL"
if [ -n "$IP" ]; then
  echo "   手机 / 同网段   http://$IP:$PORT/"
fi
echo "   日志            $LOG_DIR/server.log 与 server.err.log"
echo "   数据            $DATA_DIR"
if [ -n "$EXTRA_ARGS" ]; then
  echo "   额外参数        $EXTRA_ARGS"
else
  echo "   额外参数        无（兼容层等参数请在 easy-charles.env 里用 EC_ARGS 配）"
fi
echo ""
echo "   停止并取消自启 → 双击「卸载后台服务.command」"
echo "   ⚠ 数据面不鉴权（ADR-015）：只在可信内网开着；macOS 防火墙若弹窗"
echo "     「是否允许 node 接受传入连接」，要选允许，否则手机连不上。"
echo ""
pause
