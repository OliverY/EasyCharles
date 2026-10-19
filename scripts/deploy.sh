#!/bin/bash
# 一条命令把当前代码部署到「项目里固定的那台机器」：
#
#   bash scripts/deploy.sh              # 部署（门禁 → 打包 → 推送 → 重启 → 验收）
#   bash scripts/deploy.sh check        # 只体检：本机能不能出包 + 远端现在跑的是哪版，不改动任何东西
#   bash scripts/deploy.sh rollback     # 回滚到上一个版本（rollback 2 = 上上个）；只用远端已有目录，不重新构建
#   bash scripts/deploy.sh logs         # 看远端启动日志与报错
#   bash scripts/deploy.sh --dry-run    # 走一遍守卫与门禁，打印计划，不碰远端
#   可加：--target <ssh目标> 覆盖 deploy.conf · --keep N · --allow-dirty
#
# 为什么在 deploy-to-lan.sh 之上再包一层：
#   deploy-to-lan.sh 管「怎么把包推上去」（构建、scp、launchd、健康检查），
#   本脚本管另外三件每次都靠人记的事：
#     ① 推到哪       —— 目标机写在 scripts/deploy.conf（不进 git）
#     ② 什么时候允许推 —— 工作区必须干净：远端跑的那份要能对上 commit
#     ③ 怎么算成功    —— 首页 200、无会话的管理面必须 401、本次启动没有新增报错行
#   这三条一旦靠口头约定，就会出现「在未提交的代码上出包」和「部署完没人验收」。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYER="$SCRIPT_DIR/deploy-to-lan.sh"
CONF="$SCRIPT_DIR/deploy.conf"

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

die() { printf '\n✖  %s\n' "$*" >&2; exit 1; }
step() { printf '\n▸  %s\n' "$*"; }
ok() { printf '   ✅ %s\n' "$*"; }
warn() { printf '   ⚠  %s\n' "$*" >&2; }

# ── 参数 ───────────────────────────────────────────────────────
ACTION="deploy"
DRY_RUN=0
ALLOW_DIRTY=0
KEEP_OVERRIDE=""
ROLLBACK_N=1
REMOTE_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    deploy | check | status | rollback | logs) ACTION="$1"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --keep) KEEP_OVERRIDE="${2:-}"; shift 2 ;;
    --target) REMOTE_OVERRIDE="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *)
      # rollback 后面可以跟一个数字：回滚到第 N 个旧版本（1 = 上一个，2 = 上上个）
      case "$1" in [0-9]*) ROLLBACK_N="$1"; shift ;; *) die "未知参数：$1（-h 看用法）" ;; esac
      ;;
  esac
done

[ -f "$DEPLOYER" ] || die "缺 $DEPLOYER"

# ── 目标机（不进 git，见 scripts/deploy.conf.example）───────────
[ -f "$CONF" ] || die "$(printf '%s\n' \
  "缺部署配置：$CONF" \
  "   复制一份再填目标机：cp scripts/deploy.conf.example scripts/deploy.conf" \
  "   要改的就是 EC_DEPLOY_TARGET=<这台机器的 ssh 目标>（内网 IP 或 mDNS 名）")"
# shellcheck disable=SC1090
source "$CONF"

TARGET="${REMOTE_OVERRIDE:-${EC_DEPLOY_TARGET:-}}"
[ -n "$TARGET" ] || die "scripts/deploy.conf 里没写 EC_DEPLOY_TARGET"
BASE="${EC_DEPLOY_DIR:-~/apps}"
KEEP="${KEEP_OVERRIDE:-${EC_DEPLOY_KEEP:-3}}"
PORT="${EC_DEPLOY_PORT:-8899}"
SSH_OPTS_STR="${EC_DEPLOY_SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}"
# shellcheck disable=SC2206
SSH_OPTS=($SSH_OPTS_STR)

rsh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
# 远端非交互 shell 的 PATH 很短（今天实测：curl 直接写命令名会 command not found），一律用绝对路径
RCURL=/usr/bin/curl

# ── 守卫：本机工作区 ────────────────────────────────────────────
guard_worktree() {
  step "守卫：本机工作区"
  local dirty branch commit
  dirty="$(git -C "$REPO_ROOT" status --porcelain)"
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  if [ -n "$dirty" ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
    printf '%s\n' "$dirty" | sed 's/^/     /' >&2
    die "$(printf '%s\n' \
      "工作区有未提交的改动（上面 $(( $(printf '%s\n' "$dirty" | wc -l) )) 个文件），不出包。" \
      "   远端跑的那份必须能对上 commit，否则线上出问题无法定位是哪一版。" \
      "   先 git commit，或确认这只是临时试验时加 --allow-dirty")"
  fi
  [ -n "$dirty" ] && warn "--allow-dirty：远端将跑 $branch@$commit 之外的未提交改动"
  ok "分支 ${branch}，commit ${commit}，工作区干净"
}

# ── 体检：远端现状（部署前留一份、部署后用来对比）───────────────
remote_state() {
  # 一条 ssh 问完：当前版本目录 / 端口 / 启动参数 / 首页状态码 / err.log 行数 / 是否默认口令
  rsh "
    cd $BASE 2>/dev/null || { echo NO_BASE; exit 0; }
    ls -1d easy-charles-* 2>/dev/null | sort | tail -1
    grep -h '^EC_PORT=' easy-charles.env 2>/dev/null | tail -1
    echo ARGS:\$(grep -h '^EC_ARGS=' easy-charles.env 2>/dev/null | tail -1)
    echo HTTP:\$($RCURL -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)
    echo ERR:\$(wc -l < ~/Library/Logs/EasyCharles/server.err.log 2>/dev/null || echo 0)
    { grep -q '^EC_PASSWORD=123456' easy-charles.env 2>/dev/null || grep -q -- '--password 123456' easy-charles.env 2>/dev/null; } && echo WEAK_PW:1 || echo WEAK_PW:0
  " 2>/dev/null || echo SSH_FAIL
}

show_state() {
  local raw cur http err weak pwline args
  raw="$(remote_state)"
  [ "$raw" = "SSH_FAIL" ] && die "连不上 ${TARGET}：先确认免密（ssh $TARGET true），或改 scripts/deploy.conf"
  [ "$(printf '%s' "$raw" | head -1)" = "NO_BASE" ] && { warn "远端没有 ${BASE}（还没首次部署过？）"; return 0; }
  cur="$(printf '%s\n' "$raw" | sed -n 1p)"
  pwline="$(printf '%s\n' "$raw" | sed -n 2p)"
  args="$(printf '%s\n' "$raw" | grep '^ARGS:' | cut -d: -f2-)"
  http="$(printf '%s\n' "$raw" | grep '^HTTP:' | cut -d: -f2)"
  err="$(printf '%s\n' "$raw" | grep '^ERR:' | cut -d: -f2 | tr -d ' ')"
  weak="$(printf '%s\n' "$raw" | grep '^WEAK_PW:' | cut -d: -f2)"
  printf '   远端       %s\n' "$TARGET"
  printf '   当前版本   %s\n' "${cur:-（无）}"
  [ -n "$pwline" ] && printf '   远端端口   %s\n' "${pwline#EC_PORT=}"
  printf '   启动参数   %s\n' "${args#EC_ARGS=}"
  printf '   首页       %s\n' "${http:-?}"
  printf '   err.log    %s 行\n' "${err:-?}"
  [ "${weak:-0}" = "1" ] && warn "远端用的还是默认口令 123456（开着 --lan 时同网段可直接读你的抓包数据）"
  REMOTE_ERR_BEFORE="${err:-0}"
  REMOTE_CUR="${cur:-}"
}

# ── 部署 ────────────────────────────────────────────────────────
do_deploy() {
  guard_worktree
  step "远端现状"
  show_state

  if [ "$DRY_RUN" -eq 1 ]; then
    step "dry-run：到这里为止，没有打包、没有碰远端"
    printf '   实际部署将是： bash scripts/deploy.sh\n'
    printf '   底层命令：     %s %s --dir %s --keep %s\n' "$DEPLOYER" "$TARGET" "$BASE" "$KEEP"
    exit 0
  fi

  step "部署（底层：deploy-to-lan.sh）"
  bash "$DEPLOYER" "$TARGET" --dir "$BASE" --keep "$KEEP" ${EC_DEPLOY_ARGS:-}

  step "验收"
  verify
}

# ── 验收：三个信号都对了才算上线 ────────────────────────────────
verify() {
  local new err_after code_info bad=0
  new="$(rsh "cd $BASE && ls -1d easy-charles-* 2>/dev/null | sort | tail -1")"
  [ -n "$new" ] || { warn "远端没找到版本目录"; bad=1; }

  code_info="$(rsh "$RCURL -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/__ec/api/info")"
  err_after="$(rsh "wc -l < ~/Library/Logs/EasyCharles/server.err.log 2>/dev/null || echo 0" | tr -d ' ')"

  if [ "${REMOTE_CUR:-}" = "$new" ]; then
    warn "版本目录没变（${new}）——部署可能没落地"
    bad=1
  else
    ok "版本目录 ${new}（上一个：${REMOTE_CUR:-无}）"
  fi
  # 首页由服务自己发 200；无会话的管理面必须 401，这一条是 ADR-018 的鉴权边界，不能退化
  [ "${code_info:-}" = "401" ] && ok "管理面无会话仍拒绝（/__ec/api/info → 401）" || { warn "/__ec/api/info 返回 ${code_info:-?}，期望 401"; bad=1; }

  if [ "${REMOTE_ERR_BEFORE:-0}" = "$err_after" ]; then
    ok "启动没有新增报错行（err.log 仍 ${err_after} 行）"
  else
    warn "err.log 从 ${REMOTE_ERR_BEFORE:-?} 行涨到 ${err_after} 行，最后几行："
    rsh "tail -5 ~/Library/Logs/EasyCharles/server.err.log" | sed 's/^/     /'
    bad=1
  fi

  [ "$bad" -eq 0 ] || die "验收没过（上面列了原因）。回滚： bash scripts/deploy.sh rollback"
  ok "上线成功：git $(git -C "$REPO_ROOT" rev-parse --short HEAD) → $new"
  printf '\n   控制台（远端本机）  http://127.0.0.1:%s/\n' "$PORT"
  printf '   回滚上一个版本      bash scripts/deploy.sh rollback\n'
}

# ── 回滚：只用远端已有的目录，不重新构建 ────────────────────────
do_rollback() {
  step "回滚：远端保留的版本目录（新 → 旧）"
  local list n pick before_err before_cur http
  list="$(rsh "cd $BASE && ls -1d easy-charles-* 2>/dev/null | sort | tail -r")"
  [ -n "$list" ] || die "远端 $BASE 下没有版本目录"
  n="$(printf '%s\n' "$list" | wc -l | tr -d ' ')"
  printf '%s\n' "$list" | sed 's/^/     /'
  # 第 1 行是「现在跑着的那版」，所以回滚目标永远是第 ROLLBACK_N+1 行
  pick="$(printf '%s\n' "$list" | sed -n "$((ROLLBACK_N + 1))p")"
  [ -n "$pick" ] || die "$BASE 下只有 $n 个版本目录，往前第 $ROLLBACK_N 个旧版不存在（--keep 太小，部署时加大）"
  # 先记下目录与报错行数：回滚后「目录换了」是预期，只比对 err.log 与首页
  before_err="$(rsh "wc -l < ~/Library/Logs/EasyCharles/server.err.log 2>/dev/null || echo 0" | tr -d ' ')"
  before_cur="$(printf '%s\n' "$list" | sed -n 1p)"
  step "用 $pick 重装（--use：跳过构建与传输）"
  bash "$DEPLOYER" "$TARGET" --dir "$BASE" --use "$pick"
  step "验收"
  http="$(rsh "$RCURL -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/")"
  [ "$http" = "200" ] || die "回滚后首页 ${http}，服务没起来"
  ok "首页 200（${pick}，上一个：${before_cur}）"
  local after_err
  after_err="$(rsh "wc -l < ~/Library/Logs/EasyCharles/server.err.log 2>/dev/null || echo 0" | tr -d ' ')"
  [ "$before_err" = "$after_err" ] && ok "启动没有新增报错行（err.log 仍 ${after_err} 行）" ||
    { warn "err.log 从 ${before_err} 行涨到 ${after_err} 行，最后几行："; rsh "tail -5 ~/Library/Logs/EasyCharles/server.err.log" | sed 's/^/     /'; }
  printf '\n   注意：远端现在跑的是旧代码，修好后要重新 bash scripts/deploy.sh 部署\n'
}

do_logs() {
  step "远端日志（${TARGET}）"
  printf '── server.log 末尾 ──\n'
  # 启动横幅会把 Web 登录口令打进日志（真机实测），而这条命令的输出会进终端/AI 会话
  rsh "tail -40 ~/Library/Logs/EasyCharles/server.log 2>/dev/null | grep -vE '登录口令|password'"
  printf '\n── server.err.log 末尾 ──\n'
  rsh "f=~/Library/Logs/EasyCharles/server.err.log; if [ -s \$f ]; then tail -15 \$f; else echo '（空）'; fi"
}

case "$ACTION" in
  deploy) do_deploy ;;
  check)
    guard_worktree
    step "远端现状"
    show_state
    # 走底层 --dry-run：跑完整门禁（tsc + selftest）并出包，但一个字节也不推
    step "试打包（门禁 + 出包，不碰远端）"
    bash "$DEPLOYER" "$TARGET" --dir "$BASE" --keep "$KEEP" --dry-run ${EC_DEPLOY_ARGS:-}
    ;;
  status) step "远端现状"; show_state ;;
  rollback) do_rollback ;;
  logs) do_logs ;;
esac
