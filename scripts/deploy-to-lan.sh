#!/bin/bash
# 一条命令：本机构建 → 传到局域网里的服务器 → 远端校验/解包/重装/健康检查
#
# 角色分工（本脚本的定位）：
#   ① 开发机 + ② 平台 = **本机**：门禁、构建、分发都在这里（工具链本来就齐全）
#   ③ 服务器        = **远端**：只跑服务，不需要 git / npm / 完整工具链
#
# 用法：
#   scripts/deploy-to-lan.sh <远端> [选项]
#
#   <远端>            任何 ssh 目标：mac-b / user@<内网IP>（脚本里不写死任何主机）
#
# 选项：
#   --dir DIR         远端基础目录（默认 ~/apps），版本目录建在它下面
#   --port N          端口。省略 = 用远端配置里的 EC_PORT（推荐省略）
#   --keep N          额外保留几个旧版本目录用于回滚（默认 3）
#   --init            首次部署：提示设置控制台口令，并在远端生成 easy-charles.env
#   --use DIR         回滚/重装：直接用远端已有的版本目录（跳过构建与传输）
#   --skip-checks     跳过本地门禁（tsc + selftest）——**会大声警告**
#   --skip-restart    只放文件，不重装服务
#   --dry-run         只跑门禁与打包，打印计划，不碰远端
#   --ssh-opts "..."  覆盖 ssh 选项（默认 -o BatchMode=yes，即要求免密）
#
# 例：
#   scripts/deploy-to-lan.sh mac-b
#   scripts/deploy-to-lan.sh mac-b --init
#   scripts/deploy-to-lan.sh user@<内网IP> --dir '~/apps' --keep 5
#   scripts/deploy-to-lan.sh mac-b --use easy-charles-0.1.0-20261011-101530   # 回滚
#
# 服务器上被执行的逻辑在 scripts/deploy/remote-deploy.sh（通过 stdin 喂给远端 bash）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_SCRIPT="$SCRIPT_DIR/deploy/remote-deploy.sh"
BUILDER="$SCRIPT_DIR/build-server-bundle.sh"
SERVER_DIR="$REPO_ROOT/server"

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

die() {
  printf '\n✖  %s\n' "$*" >&2
  exit 1
}
step() { printf '\n▸  %s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }

REMOTE=""
BASE="${EC_DEPLOY_DIR:-~/apps}"
PORT=""
KEEP=3
INIT=0
USE=""
SKIP_CHECKS=0
SKIP_RESTART=0
DRY_RUN=0
SSH_OPTS_STR="${EC_DEPLOY_SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) BASE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --init) INIT=1; shift ;;
    --use) USE="${2:-}"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --ssh-opts) SSH_OPTS_STR="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "未知参数：$1（用 -h 看用法）" ;;
    *)
      [ -z "$REMOTE" ] || die "只接受一个远端参数，多给了：$1"
      REMOTE="$1"
      shift
      ;;
  esac
done

[ -n "$REMOTE" ] || { usage; die "缺远端参数（例：scripts/deploy-to-lan.sh mac-b）"; }
[ -f "$REMOTE_SCRIPT" ] || die "缺 $REMOTE_SCRIPT"
[ -f "$BUILDER" ] || die "缺 $BUILDER"
[ "$INIT" -eq 0 ] || [ -z "$USE" ] || die "--init 与 --use 不能同时用"

# shellcheck disable=SC2206  # 故意按空白分词：让用户能传 "-o A=1 -o B=2"
SSH_OPTS=($SSH_OPTS_STR)

for c in ssh scp shasum awk; do
  command -v "$c" >/dev/null 2>&1 || die "本机缺命令：$c"
done

# --init 要交互输入口令。这里放在最前面判断，避免非交互场景先白跑一次门禁+打包
# 才发现没有终端可用。
if [ "$INIT" -eq 1 ] && [ ! -t 0 ]; then
  die "$(printf '%s\n' \
    "--init 需要交互终端来设置口令（当前没有）。" \
    "   要么在有终端的地方跑，要么先在服务器上手工创建 easy-charles.env 再重跑（别用默认口令 123456）。")"
fi

# ── 0) 预检远端 ────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
  step "预检远端 $REMOTE"
  # 一次 ssh 同时问两件事（省一个来回）：系统是不是 Darwin、非交互 SSH 里能不能找到 node。
  if ! ssh "${SSH_OPTS[@]}" "$REMOTE" 'uname -s; node -v 2>/dev/null || echo NO_NODE' >/tmp/.ec-deploy-pre.$$ 2>&1; then
    rm -f "/tmp/.ec-deploy-pre.$$"
    die "$(printf '%s\n' \
      "连不上远端：$REMOTE" \
      "   先手工确认一次免密登录： ssh $REMOTE true" \
      "   需要配公钥： ssh-copy-id $REMOTE" \
      "   确实要用密码登录： EC_DEPLOY_SSH_OPTS='-o BatchMode=no' $0 $REMOTE ...")"
  fi
  R_OS="$(sed -n 1p "/tmp/.ec-deploy-pre.$$" | tr -d '\r')"
  R_NODE="$(sed -n 2p "/tmp/.ec-deploy-pre.$$" | tr -d '\r')"
  rm -f "/tmp/.ec-deploy-pre.$$"
  [ "$R_OS" = "Darwin" ] ||
    die "远端是 ${R_OS}，本脚本目前只支持 macOS 目标机（launchd）。Linux 见 scripts/deploy/DEPLOY.md §3（systemd）。"
  printf '   远端系统 %s ✅\n' "$R_OS"
  # 只警告不拦：node 可能由 nvm/fnm/asdf 装在交互式环境里、非交互 SSH 看不见它，
  # 那种情况下安装脚本自己能按绝对路径找到 —— 拦下来会误杀。
  if [ "$R_NODE" = "NO_NODE" ] || [ -z "$R_NODE" ]; then
    warn "$(printf '%s\n' \
      "非交互 SSH 里没找到 node（可能是 nvm/fnm 装的，也可能真没装）。" \
      "   若确实没装：先在 $REMOTE 上装 Node 22.6+（brew install node），再重跑本命令。")"
  else
    printf '   远端 node %s ✅\n' "$R_NODE"
  fi
fi

# ── 1) 本机门禁 + 打包 ─────────────────────────────────────────
step "本机门禁与打包（tsc + selftest）"
if [ "$SKIP_CHECKS" -eq 1 ]; then
  warn "已跳过门禁（--skip-checks）：产物可能来自红着的代码"
  bash "$BUILDER" --skip-checks
else
  bash "$BUILDER"
fi

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SERVER_DIR/package.json" | head -1)"
[ -n "$VERSION" ] || die "读不到 server/package.json 的 version"
TARBALL_NAME="easy-charles-server-$VERSION.tar.gz"
TARBALL="$REPO_ROOT/build/$TARBALL_NAME"
SHA_FILE="$TARBALL.sha256"
[ -f "$TARBALL" ] || die "打包后没找到产物：$TARBALL"
[ -f "$SHA_FILE" ] || die "打包后没找到校验文件：$SHA_FILE"
SHA="$(awk '{print $1}' "$SHA_FILE")"
[ -n "$SHA" ] || die "校验文件是空的：$SHA_FILE"
printf '   产物 %s（%s）\n' "$TARBALL_NAME" "$(du -h "$TARBALL" | awk '{print $1}')"

if [ "$DRY_RUN" -eq 1 ]; then
  step "dry-run：以下动作没有执行"
  printf '   远端       %s\n' "$REMOTE"
  printf '   基础目录   %s\n' "$BASE"
  printf '   端口       %s\n' "${PORT:-（用远端 EC_PORT）}"
  printf '   保留旧版本 %s 个\n' "$KEEP"
  printf '   产物       %s\n' "$TARBALL_NAME"
  printf '   sha256     %s\n' "$SHA"
  [ -n "$USE" ] && printf '   模式       回滚到 %s\n' "$USE"
  exit 0
fi

# ── 2) 首次部署：本地生成配置 ──────────────────────────────────
INIT_ENV_REMOTE=""
TMP_ENV=""
cleanup() {
  [ -n "$TMP_ENV" ] && rm -f "$TMP_ENV"
  return 0
}
trap cleanup EXIT

if [ "$INIT" -eq 1 ]; then
  step "首次部署：设置控制台口令"
  printf '   控制台口令是全局单一口令，默认值 123456 在共享内网下等于没有。\n'
  printf '   请输入口令（不回显）: '
  read -r -s PW1
  printf '\n   再输一次确认: '
  read -r -s PW2
  printf '\n'
  [ "$PW1" = "$PW2" ] || die "两次输入不一致"
  [ -n "$PW1" ] || die "口令不能为空"
  [ "$PW1" != "123456" ] || die "拒绝使用默认口令 123456 —— 局域网里任何人都能进控制台。"

  TMP_ENV="$(mktemp)"
  chmod 600 "$TMP_ENV"
  ESC_PW="$(printf '%s' "$PW1" | sed "s/'/'\\\\''/g")"
  {
    printf '# 由 scripts/deploy-to-lan.sh --init 生成（%s）\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf '# 改完这个文件后重跑一次部署即生效（远端会从上一版目录继承它）。\n'
    printf '# 需要兼容层参数 / 自定义数据目录 / 记录模式时，打开下面几行：\n'
    printf '#EC_ARGS="--compat-route /mock-proxy --app-id my-app"\n'
    printf '#EC_DATA_DIR="$HOME/Library/Application Support/EasyCharles/data"\n'
    printf '#EC_ADMIN=13800000000\n'
    printf 'EC_PORT=%s\n' "${PORT:-8899}"
    printf "EC_PASSWORD='%s'\n" "$ESC_PW"
  } >"$TMP_ENV"
  printf '   已生成远端配置（口令不回显、不落命令行）\n'
fi

# ── 3) 传输 ────────────────────────────────────────────────────
if [ -z "$USE" ]; then
  step "传输产物到 $REMOTE:$BASE/.incoming/"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p $BASE/.incoming" ||
    die "远端建目录失败：$BASE/.incoming"
  scp "${SSH_OPTS[@]}" "$TARBALL" "$SHA_FILE" "$REMOTE:$BASE/.incoming/" ||
    die "传输失败（检查远端磁盘空间与目录权限）"
  if [ -n "$TMP_ENV" ]; then
    scp "${SSH_OPTS[@]}" "$TMP_ENV" "$REMOTE:$BASE/.incoming/easy-charles.env" ||
      die "配置文件传输失败"
    INIT_ENV_REMOTE="$BASE/.incoming/easy-charles.env"
  fi
fi

# ── 4) 远端执行 ────────────────────────────────────────────────
rargs=(--base "$BASE" --keep "$KEEP")
[ -n "$PORT" ] && rargs+=(--port "$PORT")
if [ -n "$USE" ]; then
  rargs+=(--use "$USE")
else
  rargs+=(--incoming "$BASE/.incoming" --tarball "$TARBALL_NAME" --sha "$SHA")
  [ -n "$INIT_ENV_REMOTE" ] && rargs+=(--init-env "$INIT_ENV_REMOTE")
fi
[ "$SKIP_RESTART" -eq 1 ] && rargs+=(--skip-restart)

# 逐个 %q：这些参数会被远端 shell 重新解析，路径里的空格/中文都得顶住
qargs=()
for a in "${rargs[@]}"; do qargs+=("$(printf '%q' "$a")"); done

step "远端执行（校验 → 解包 → 重装 → 健康检查）"
TMP_OUT="$(mktemp)"
trap 'cleanup; rm -f "$TMP_OUT"' EXIT
set +e
ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "${qargs[@]}" <"$REMOTE_SCRIPT" | tee "$TMP_OUT"
RC=${PIPESTATUS[0]}
set -e

RB="$(sed -n 's/^previous_dir: //p' "$TMP_OUT" | tail -1)"
VD="$(sed -n 's/^version_dir: //p' "$TMP_OUT" | tail -1)"
if [ -z "$PORT" ]; then
  RB_CMD="$0 $REMOTE --dir '$BASE' --use"
else
  RB_CMD="$0 $REMOTE --dir '$BASE' --port $PORT --use"
fi

echo ""
if [ "$RC" -ne 0 ]; then
  echo "✖  部署未完成（远端退出码 ${RC}）—— 旧版本仍在跑，服务没有中断。"
  if [ -n "$RB" ]; then echo "   回滚/复位： $RB_CMD $RB"; fi
  echo "   看日志：    ssh $REMOTE 'tail -50 ~/Library/Logs/EasyCharles/server.err.log'"
  exit 1
fi

echo "✅  上线成功${VD:+（版本目录 ${VD}）}"
echo "   · 手机和 App 不需要任何改动（地址与端口都没变）"
echo "   · 抓包记录会重新开始（记录只在内存），规则/绑定/快照不受影响"
# 注意别写成 `[ -n "$RB" ] && echo ...`：首次部署时 RB 为空，那样整个脚本
# 会以退出码 1 结束，明明是成功却告诉调用者失败。
if [ -n "$RB" ]; then
  echo "   · 回滚： $RB_CMD $RB"
fi
