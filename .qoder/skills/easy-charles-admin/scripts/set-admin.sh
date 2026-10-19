#!/usr/bin/env bash
# 设置/取消 EasyCharles 部署实例的管理员（EC_ADMIN）。
# 用法：set-admin.sh <手机号[,手机号…]> | --off | --status
# 目标机读 scripts/deploy.conf 的 EC_DEPLOY_TARGET；配置文件是目标机上
# 当前在跑版本目录的 easy-charles.env，改完重装 launchd 服务并登录验证。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../../../.." && pwd)"
DEPLOY_CONF="$REPO_ROOT/scripts/deploy.conf"

fail() { printf '失败：%s\n' "$1" >&2; exit 1; }

[ -f "$DEPLOY_CONF" ] || fail "没有 $DEPLOY_CONF（gitignored）。先确认这台机器配置过部署目标，跑 bash scripts/deploy.sh check 看看。"
# shellcheck disable=SC1090
source "$DEPLOY_CONF"
[ -n "${EC_DEPLOY_TARGET:-}" ] || fail "scripts/deploy.conf 里 EC_DEPLOY_TARGET 为空。"

ACTION="${1:-}"
case "$ACTION" in
  --status) MODE=status; NEWVAL="" ;;
  --off)    MODE=apply;   NEWVAL="" ;;
  "")       fail "用法：set-admin.sh <手机号[,手机号…]> | --off | --status" ;;
  *)
    MODE=apply
    NEWVAL="$(printf '%s' "$ACTION" | tr -d ' ')"
    printf '%s' "$NEWVAL" | grep -Eq '^[0-9]+(,[0-9]+)*$' ||
      fail "手机号只能是数字与逗号：「$NEWVAL」"
    ;;
esac

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

# ── 远端探测（只读）─────────────────────────────────────────────
PROBE='
PLIST="$HOME/Library/LaunchAgents/local.easycharles.server.plist"
[ -f "$PLIST" ] || { echo NO_SERVICE; exit 0; }
DIR="$(sed -n "s|.*<string>\(.*\)/run\.sh</string>.*|\1|p" "$PLIST" | head -1)"
[ -n "$DIR" ] || { echo NO_DIR; exit 0; }
ENVF="$DIR/easy-charles.env"
if [ ! -f "$ENVF" ]; then echo "NO_ENV=$ENVF"; exit 0; fi
echo "ENVF=$ENVF"
CUR="$(grep -E "^#?EC_ADMIN=" "$ENVF" | head -1 || true)"
echo "CUR=${CUR:-（未配置）}"
echo "PW=$(grep -E "^EC_PASSWORD=" "$ENVF" | head -1 | sed "s/^EC_PASSWORD=//" || true)"
echo "PORT=$(grep -E "^EC_PORT=" "$ENVF" | head -1 | cut -d= -f2 || true)"
'
RAW="$(ssh "${SSH_OPTS[@]}" "$EC_DEPLOY_TARGET" "$PROBE")" ||
  fail "ssh 连不上 $EC_DEPLOY_TARGET。先跑 bash scripts/deploy.sh check。"
case "$RAW" in
  NO_SERVICE) fail "目标机上没有 launchd 服务（还没部署过？）。" ;;
  NO_DIR*)    fail "plist 里解析不出运行目录，目标机状态异常，跑 bash scripts/deploy.sh status 看。" ;;
esac
ENVF="$(printf '%s\n' "$RAW" | sed -n 's/^ENVF=//p')"
[ -n "$ENVF" ] || fail "运行目录缺 easy-charles.env：$(printf '%s\n' "$RAW" | sed -n 's/^NO_ENV=//p')"
CUR="$(printf '%s\n' "$RAW" | sed -n 's/^CUR=//p')"
PW_QUOTED="$(printf '%s\n' "$RAW" | sed -n 's/^PW=//p')"
PORT="$(printf '%s\n' "$RAW" | sed -n 's/^PORT=//p')"
PORT="${PORT:-8899}"

if [ "$MODE" = status ]; then
  echo "目标机：$EC_DEPLOY_TARGET"
  echo "配置文件：$ENVF"
  echo "管理员：$CUR"
  exit 0
fi

echo "目标机：$EC_DEPLOY_TARGET"
echo "当前：$CUR"
if [ -n "$NEWVAL" ]; then echo "改为：EC_ADMIN=$NEWVAL"; else echo "改为：（取消，不配置任何管理员）"; fi

# 验证用的手机号：设置 = 新值第一个；取消 = 原配置里第一个（有的话）
VERIFY_PHONE="$NEWVAL"
[ -n "$VERIFY_PHONE" ] || VERIFY_PHONE="$(printf '%s' "$CUR" | sed -n 's/^EC_ADMIN=//p' | cut -d, -f1)"

# ── 远端：改配置 → 重装服务 → 健康检查 → 登录验证 ────────────────
# PW_QUOTED 是 env 文件里的原始赋值（含引号转义），与 run.sh 消费方式一致地 eval 还原；
# 只在带引号形态时 eval，且值只进远端自己的登录请求，不落日志。
OUT="$(ssh "${SSH_OPTS[@]}" "$EC_DEPLOY_TARGET" \
  "NEWVAL='$NEWVAL' ENVF='$ENVF' PWQ='$PW_QUOTED' PORT='$PORT' PHONE='$VERIFY_PHONE' bash -s" <<'REMOTE'
set -eu
grep -v -E '^#?EC_ADMIN=' "$ENVF" > "$ENVF.tmp" || true
if [ -n "$NEWVAL" ]; then printf 'EC_ADMIN=%s\n' "$NEWVAL" >> "$ENVF.tmp"; fi
mv "$ENVF.tmp" "$ENVF"
chmod 600 "$ENVF"
echo ENV_OK

cd "$(dirname "$ENVF")"
bash ./安装后台服务.command </dev/null

# 安装脚本不体现就绪与否，自己等健康检查（与 remote-deploy.sh 同口径：200 且含 EasyCharles）
OK=""
for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -q EasyCharles; then OK=1; break; fi
  sleep 0.5
done
[ -n "$OK" ] || { echo HEALTH_FAIL; exit 1; }
echo HEALTH_OK

# 登录验证：PWQ 是 env 里的 shell 赋值原样（'…' 带转义），eval 还原后进 JSON
PW=""
case "$PWQ" in "'"*) eval "PW=$PWQ" ;; esac
echo "LOGIN_CODE=0"
echo "ROLE=none"
if [ -n "$PW" ] && [ -n "$PHONE" ]; then
  BODY=$(mktemp)
  CODE=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 5 -X POST "http://127.0.0.1:${PORT}/__ec/api/login" \
    -H 'content-type: application/json' \
    -d "{\"phone\":\"$PHONE\",\"password\":\"$PW\"}" 2>/dev/null || echo 000)
  ROLE=$(sed -n 's/.*"role":"\([a-z]*\)".*/\1/p' "$BODY" 2>/dev/null || true)
  rm -f "$BODY"
  echo "LOGIN_CODE=${CODE:-000}"
  echo "ROLE=${ROLE:-none}"
fi
REMOTE
)" || fail "远端改配置或重启服务失败。看 bash scripts/deploy.sh logs"

grep_ok() { printf '%s\n' "$OUT" | grep -q "^$1\$"; }
grep_ok ENV_OK    || fail "远端写配置没有成功标记"
grep_ok HEALTH_OK || fail "服务重启后健康检查没过（120 次探测失败）。看 bash scripts/deploy.sh logs"

FINAL="$(ssh "${SSH_OPTS[@]}" "$EC_DEPLOY_TARGET" "grep -E '^EC_ADMIN=' '$ENVF' || echo （未配置）")"
echo "已生效：$FINAL"

CODE="$(printf '%s\n' "$OUT" | sed -n 's/^LOGIN_CODE=//p')"
ROLE="$(printf '%s\n' "$OUT" | sed -n 's/^ROLE=//p')"

if [ "$CODE" = "0" ] || [ "$CODE" = "000" ]; then
  echo "（没有口令或没有可验证的手机号，跳过登录验证；打开 http://<目标机>:$PORT/admin 确认）"
  exit 0
fi
if [ "$CODE" != "200" ]; then
  echo "（登录验证没做成：HTTP $CODE —— 口令不对或含特殊字符。配置已生效，请手动打开 /admin 确认）"
  exit 0
fi

if [ -n "$NEWVAL" ]; then
  [ "$ROLE" = admin ] || fail "验证不符：$VERIFY_PHONE 登录后 role=$ROLE（预期 admin）。看 bash scripts/deploy.sh logs"
  echo "验证通过：$VERIFY_PHONE 登录后 role=admin"
else
  [ "$ROLE" = admin ] && fail "验证不符：$VERIFY_PHONE 登录后仍是 admin。看 bash scripts/deploy.sh logs"
  echo "验证通过：$VERIFY_PHONE 登录后 role=${ROLE:-none}，管理员已取消"
fi
