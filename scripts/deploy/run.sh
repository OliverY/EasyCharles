#!/bin/bash
# EasyCharles 服务端启动入口（发布包内自带，不要单独拷走）
#
# 发布包是「零构建」形态：直接把 .ts 交给 Node 的类型剥离跑，所以这个包装脚本
# 只做三件不改服务端代码的事：
#   1. 校验发布包完整（src / web / node_modules/ws 都在）
#   2. 探测本机 Node 能否直接跑 .ts
#      ⚠ 判定口径与 scripts/easy-charles-lib.sh 的 ec_node_ts_flag 一致，改一处要同步另一处
#   3. 把 EC_* 环境变量翻译成服务端命令行参数
#      （这样 systemd unit 里不必出现口令明文，配合 EnvironmentFile 使用）
#
# 用法：./run.sh [服务端原参数...]
#   ./run.sh --lan
#   EC_PASSWORD=xxx EC_DATA_DIR=/var/lib/easycharles ./run.sh --lan --port 8899
#   EC_NODE_BIN=/usr/local/bin/node ./run.sh --host 0.0.0.0
#   EC_ARGS="--compat-route /mock-proxy --app-id my-app" ./run.sh --lan
#
# 参数优先级：命令行 > EC_* 环境变量 > EC_ARGS > 默认值。
# 服务端支持的参数见 DEPLOY.md 或 `node server/src/index.ts --help`（无 help，见 config.ts）。

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$DIR/server"

fail() { printf '✖  %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }

# ── 1) 发布包完整性 ────────────────────────────────────────────
# web/*.html 是每请求现读的（index.ts 按 __dirname/../web 定位），缺了控制台直接 500，
# 所以这里必须拦住，而不是等用户打开浏览器才发现。
[ -f "$SERVER/src/index.ts" ] || fail "发布包不完整：缺 server/src/index.ts"
[ -f "$SERVER/web/index.html" ] || fail "发布包不完整：缺 server/web/index.html"
[ -f "$SERVER/web/about.html" ] || fail "发布包不完整：缺 server/web/about.html"
[ -f "$SERVER/web/snapshot.html" ] || fail "发布包不完整：缺 server/web/snapshot.html"
[ -d "$SERVER/node_modules/ws" ] || fail "发布包不完整：缺 server/node_modules/ws（运行时唯一依赖）"

# ── 2) Node 能力探测 ──────────────────────────────────────────
NODE_BIN="${EC_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
[ -n "$NODE_BIN" ] || fail "没找到 node。请安装 Node 22.6+（推荐 23.6+），或用 EC_NODE_BIN 指定完整路径。"
[ -x "$NODE_BIN" ] || fail "EC_NODE_BIN 指向的路径不可执行：$NODE_BIN"

node_ver="$("$NODE_BIN" -v 2>/dev/null || true)"
case "$node_ver" in
v[0-9]*) ;;
*) fail "无法识别 node 版本：${node_ver}（期望形如 v22.6.0）" ;;
esac

v="${node_ver#v}"
major="${v%%.*}"
minor="$(printf '%s' "$v" | cut -d. -f2)"
case "$major" in '' | *[!0-9]*) fail "无法识别 node 主版本号：$node_ver" ;; esac
case "$minor" in '' | *[!0-9]*) minor=0 ;; esac

NODE_PRE=()
if [ "$major" -gt 23 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; }; then
  : # 23.6+ 默认剥离类型，无需 flag
elif [ "$major" -eq 23 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 6 ]; }; then
  NODE_PRE=(--experimental-strip-types) # 22.6~22.x / 23.0~23.5 需要显式开启
else
  fail "Node 版本过低（${node_ver}）：本项目直接运行 TypeScript，需要 Node 22.6+（推荐 23.6+）。"
fi

# 版本号只是「应该有」，能不能跑要真跑一次才知道（自编译版本 / 发行版裁剪都可能例外）
PROBE="$(mktemp -d)"
trap 'rm -rf "$PROBE"' EXIT
printf 'const n: number = 1\nif (n !== 1) process.exit(1)\n' >"$PROBE/probe.ts" || fail "无法创建探测文件：$PROBE"
if ! "$NODE_BIN" ${NODE_PRE[@]+"${NODE_PRE[@]}"} "$PROBE/probe.ts" >/dev/null 2>&1; then
  if [ "${#NODE_PRE[@]}" -eq 0 ] && "$NODE_BIN" --experimental-strip-types "$PROBE/probe.ts" >/dev/null 2>&1; then
    NODE_PRE=(--experimental-strip-types)
  else
    fail "本机 Node（${node_ver}）无法直接运行 .ts（类型剥离不可用）。需要 Node 22.6+（推荐 23.6+）。"
  fi
fi
rm -rf "$PROBE"
trap - EXIT

# ── 3) EC_* 环境变量 → 命令行参数 ─────────────────────────────
# 显式传了的参数一律不动（命令行优先），避免覆盖运维的显式意图。
ts=("$@")
# 两个扫描列表，用途不同，别合并：
#   cli  —— 只看命令行。用来判断「运维已经显式传了这个 flag」，从而跳过对应 EC_* 的翻译。
#           EC_ARGS **不能**进这个列表：它只是兜底通道，不该压制 EC_*（压了就等于
#           EC_ARGS 优先级最高，和"命令行 > EC_* > EC_ARGS"的说法自相矛盾）。
#   scan —— cli + EC_ARGS。用来判断「是否暴露到非回环」，否则 EC_ARGS="--lan"
#           会绕过 ADR-015 那三条警告。
cli=("$@")
scan=("$@")
if [ -n "${EC_ARGS:-}" ]; then
  # 故意不加引号做词分割：EC_ARGS 里写的是一个参数串（与 scripts/easy-charles-lib.sh 同语义）
  for a in $EC_ARGS; do scan+=("$a"); done
fi
want_data_dir=1
want_port=1
want_password=1
want_admin=1
exposed=0
prev=""
for a in ${cli[@]+"${cli[@]}"}; do
  case "$a" in
  --data-dir) want_data_dir=0 ;;
  --port) want_port=0 ;;
  --password) want_password=0 ;;
  --admin) want_admin=0 ;;
  esac
done
for a in ${scan[@]+"${scan[@]}"}; do
  case "$a" in
  --lan) exposed=1 ;;
  esac
  if [ "$prev" = "--host" ]; then
    case "$a" in
    127.0.0.1 | localhost) ;;
    *) exposed=1 ;;
    esac
  fi
  prev="$a"
done
case "${EC_HOST:-}" in
'') ;;
127.0.0.1 | localhost) ;;
*) exposed=1 ;;
esac

data_dir="${EC_DATA_DIR:-$DIR/data}"
if [ "$want_data_dir" -eq 1 ]; then
  ts+=(--data-dir "$data_dir")
fi
if [ "$want_port" -eq 1 ] && [ -n "${EC_PORT:-}" ]; then
  ts+=(--port "$EC_PORT")
fi
if [ "$want_password" -eq 1 ] && [ -n "${EC_PASSWORD:-}" ]; then
  ts+=(--password "$EC_PASSWORD")
fi
if [ "$want_admin" -eq 1 ] && [ -n "${EC_ADMIN:-}" ]; then
  ts+=(--admin "$EC_ADMIN")
fi
if [ "$want_port" -eq 1 ] && [ -n "${EC_HOST:-}" ]; then
  ts+=(--host "$EC_HOST")
fi
if [ "${EC_LAN:-}" = "1" ] && [ "$exposed" -eq 0 ]; then
  ts+=(--lan)
  exposed=1
fi

# EC_ARGS：EC_* 覆盖不到的那些 flag 的透传通道，典型用途是兼容层
# （--compat-route / --compat-*-header / --app-id，这些没有对应的 EC_* 变量）。
# 服务端 config.ts 的 readArg 取**第一个**匹配，所以顺序就决定了优先级：
#   命令行 → EC_* → EC_ARGS → 默认值，EC_ARGS 抢不过任何显式设置。
if [ -n "${EC_ARGS:-}" ]; then
  for a in $EC_ARGS; do ts+=("$a"); done
fi

# 安全提醒（ADR-015）：数据面按设计不鉴权，暴露到非回环还用默认口令是真实风险
if [ "$exposed" -eq 1 ] && [ "$want_password" -eq 1 ] && [ -z "${EC_PASSWORD:-}" ]; then
  warn "监听非回环地址，但未设置 EC_PASSWORD：控制台将使用默认口令 123456。"
  warn "数据面按设计不鉴权（ADR-015），任何能访问该端口的人都能把这台机器当开放中转代理用。"
  warn "请设置 EC_PASSWORD（systemd 可用 EnvironmentFile=），或确认只在可信内网短时使用。"
fi

log "▸ 数据目录    $data_dir"
log "▸ 控制台页面  $SERVER/web"
log "▸ Node        ${NODE_BIN}（$node_ver${NODE_PRE[0]:+，${NODE_PRE[0]}}）"

# 数据目录交给服务端自己创建（rules.ts / store.ts 都是 mkdirSync recursive），
# 这里只检查父目录可写，避免以受限用户运行时启动即失败且原因难懂。
parent="$(dirname "$data_dir")"
if [ ! -d "$data_dir" ] && [ ! -w "$parent" ]; then
  fail "数据目录不可写：${data_dir}（父目录 $parent 对当前用户 $(id -un) 不可写）"
fi

cd "$SERVER"
exec "$NODE_BIN" ${NODE_PRE[@]+"${NODE_PRE[@]}"} src/index.ts ${ts[@]+"${ts[@]}"}
