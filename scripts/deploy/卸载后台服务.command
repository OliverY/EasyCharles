#!/bin/bash
# 双击：停止 EasyCharles 后台服务并取消开机自启
#
#   · 从 launchd 卸载（KeepAlive 会一直拉起进程，所以必须先卸载、不能只 kill）
#   · 删掉 ~/Library/LaunchAgents/local.easycharles.server.plist
#   · **不动数据目录、不删日志**：规则 / 用户绑定 / 快照都还在，重装即恢复
#
# 文件名故意不带空格（原因见「启动EasyCharles.command」顶部注释）。

set -uo pipefail

LABEL="local.easycharles.server"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/EasyCharles"

pause() { [ -t 0 ] || return 0; read -n 1 -s -r -p "按任意键关闭窗口..."; echo ""; }

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✖  这个脚本只能在 macOS 上双击运行（Linux 用 systemctl stop easy-charles）"
  pause
  exit 1
fi

UID_N="$(id -u)"
STOPPED=0

if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && STOPPED=1
elif [ -f "$PLIST_DST" ]; then
  launchctl unload -w "$PLIST_DST" 2>/dev/null && STOPPED=1
fi

if [ -f "$PLIST_DST" ]; then
  rm -f "$PLIST_DST" && echo "▸  已移除自启配置：$PLIST_DST"
fi

# 确认端口真的释放了（KeepAlive 若还在生效，这里会是"仍在运行"）
PORT="${EC_PORT:-8899}"
if [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/easy-charles.env" ]; then
  # shellcheck disable=SC1091
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/easy-charles.env"
  PORT="${EC_PORT:-$PORT}"
fi

echo ""
if [ "$STOPPED" -eq 1 ]; then
  echo "✅ EasyCharles 后台服务已停止，开机自启已取消"
else
  echo "ℹ  没有发现已装载的后台服务（可能本来就没装）"
fi
echo ""
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠  端口 $PORT 仍有进程在监听 —— 若那是你前台启动的实例，"
  echo "   在它的终端窗口按 Ctrl-C 即可；也可能是别的程序占用。"
else
  echo "   端口 $PORT 已释放"
fi
echo ""
echo "   数据与日志都保留着："
echo "     日志  $LOG_DIR"
echo "   要重新启用 → 双击「安装后台服务.command」"
echo ""
pause
