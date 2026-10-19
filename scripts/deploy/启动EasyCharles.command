#!/bin/bash
# 双击：前台启动 EasyCharles 服务（终端窗口里能看到全部日志）
#
#   · 关掉这个终端窗口 / 按 Ctrl-C 就等于停止服务
#   · 想让它后台常驻、开机自启、崩溃自动拉起 → 双击「安装后台服务.command」
#   · 带 --lan（等价 --host 0.0.0.0），手机和同网段机器才连得上
#     ⚠ 数据面按设计不鉴权（ADR-015），请先复制 easy-charles.env.example 为
#       easy-charles.env 并设好 EC_PASSWORD，否则控制台会用默认口令 123456
#
# 文件名不带空格（shell 里好写、也不用引号）。隐私钩子曾经会被含空格/非 ASCII 的路径绕过，
# 已于 ADR-023 修好（`-z` + `read -d ''`），所以本文件在钩子检查范围内。

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ -f "$DIR/easy-charles.env" ]; then
  # set -a 必须留着：easy-charles.env 里是普通赋值（KEY=value，不带 export），
  # 只 source 不自动导出的话，下面的 run.sh 是**子进程**，一个变量都收不到
  # ——表现为端口/数据目录/口令全部回落到默认值（这个坑实测踩过一次）。
  set -a
  # shellcheck disable=SC1091
  . "$DIR/easy-charles.env"
  set +a
  echo "▸  已读取本地配置：$DIR/easy-charles.env"
fi

echo "▸  EasyCharles 前台启动（Ctrl-C 或关闭本窗口即停止）"
echo ""

"$DIR/run.sh" --lan
code=$?

# 出错时留住窗口，否则双击启动的人根本看不到失败原因
if [ "$code" -ne 0 ] && [ "$code" -ne 130 ]; then
  echo ""
  echo "✖  服务已退出，退出码 ${code}（原因见上方输出）"
  if [ -t 0 ]; then
    read -n 1 -s -r -p "按任意键关闭窗口..."
    echo ""
  fi
fi
exit "$code"
