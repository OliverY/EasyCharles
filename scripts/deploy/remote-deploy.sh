#!/bin/bash
# 在「服务器」这一侧执行：接收产物 → 校验 → 解到版本目录 → 沿用配置 → 重装服务
# → 健康检查 → 清理旧版本 → 报告（含回滚目录）
#
# 谁调用它：
#   ① 常规：开发机的 scripts/deploy-to-lan.sh 通过 stdin 把本文件喂给远端 bash：
#        ssh <远端> 'bash -s' -- <参数> < scripts/deploy/remote-deploy.sh
#      用 stdin 传脚本 ⇒ 不必先往远端拷文件；参数也不会拼成一条长命令行。
#   ② 手工：产物目录里带着本文件，可在服务器上直接跑（不依赖开发机）
#
# 只依赖 macOS 自带命令：bash / tar / shasum / curl / launchctl / sed / ls
#
# 三个刻意的设计：
#   · 「上一版装在哪」不猜：从 launchd 的 plist 里读出 run.sh 的绝对路径反推目录；
#   · 新目录先解到 .staging-$$，再原子 mv 就位 —— 中途失败不会留半成品，旧版本仍在跑；
#   · 配置（easy-charles.env）从上一版目录继承。它在解包目录里、不在产物里，
#     直接 rm -rf 再解包就会丢口令与 EC_ARGS（丢了 EC_ARGS 的症状是接口全 404）。
set -euo pipefail

LABEL="local.easycharles.server"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/EasyCharles"

step() { printf '\n▸  %s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die() {
  printf '\n✖  %s\n' "$*" >&2
  exit 1
}

BASE=""
PORT=""
KEEP=3
INCOMING=""
TARBALL=""
SHA=""
INIT_ENV=""
USE=""
SKIP_RESTART=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --incoming) INCOMING="${2:-}"; shift 2 ;;
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --init-env) INIT_ENV="${2:-}"; shift 2 ;;
    --use) USE="${2:-}"; shift 2 ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    *) die "未知参数：$1" ;;
  esac
done

[ -n "$BASE" ] || die "缺 --base"
case "$BASE" in
  "~") BASE="$HOME" ;;
  "~/"*) BASE="$HOME/${BASE#\~/}" ;;
esac
[ "$(uname -s)" = "Darwin" ] ||
  die "本脚本只支持 macOS（launchd）。Linux 请用包内 easy-charles.service，步骤见 DEPLOY.md §3。"

TMPBODY="$(mktemp)"
trap 'rm -f "$TMPBODY"' EXIT

# 当前正在跑的目录：plist 里 run.sh 的父目录
current_dir() {
  [ -f "$PLIST_DST" ] || return 1
  sed -n 's|.*<string>\(.*\)/run\.sh</string>.*|\1|p' "$PLIST_DST" | head -1
}

OLDDIR="$(current_dir 2>/dev/null || true)"
[ -n "$OLDDIR" ] && printf '▸  上一版目录：%s\n' "$OLDDIR" || printf '▸  上一版目录：无（看起来是首次部署）\n'

TARGET=""
NEW_VERSION=""
if [ -n "$USE" ]; then
  # ── 回滚 / 重装已有目录：不碰文件，只重装服务 ──────────────────
  case "$USE" in
    /*) TARGET="$USE" ;;
    *) TARGET="$BASE/$USE" ;;
  esac
  [ -d "$TARGET" ] || die "目录不存在：${TARGET}（用 ls -1dt \"$BASE\"/easy-charles-* 看看有哪些）"
  step "回滚到已有版本：$TARGET"
  # 回滚目标必须自带配置；早期手工解出来的目录可能没有，就从当前在跑的版本借一份
  ENV_FILE="$TARGET/easy-charles.env"
  if [ ! -f "$ENV_FILE" ] && [ -n "$OLDDIR" ] && [ -f "$OLDDIR/easy-charles.env" ]; then
    cp -p "$OLDDIR/easy-charles.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    printf '   目标目录缺配置，已从上一版目录补上\n'
  fi
else
  # ── 校验产物 ─────────────────────────────────────────────────
  [ -n "$INCOMING" ] && [ -n "$TARBALL" ] && [ -n "$SHA" ] ||
    die "缺 --incoming / --tarball / --sha"
  [ -f "$INCOMING/$TARBALL" ] || die "找不到产物：$INCOMING/$TARBALL"

  step "校验产物 sha256"
  ACT="$(shasum -a 256 "$INCOMING/$TARBALL" | awk '{print $1}')"
  [ "$ACT" = "$SHA" ] ||
    die "产物校验失败（期望 ${SHA}，实际 ${ACT}）。传输可能损坏，已中止；旧版本仍在运行。"
  printf '   %s  ✅\n' "$ACT"

  # ── 先定配置来源并自检，再动文件系统 ──────────────────────────
  # 顺序很关键：配置有问题（缺口令 / 端口对不上）时在**解包之前**就失败，
  # 否则会先留下一个跑不起来的版本目录（孤儿目录）。
  step "准备配置 easy-charles.env"
  ENV_SRC=""
  if [ -n "$INIT_ENV" ]; then
    [ -f "$INIT_ENV" ] || die "找不到 --init-env 指定的文件：$INIT_ENV"
    [ -z "$OLDDIR" ] || [ ! -f "$OLDDIR/easy-charles.env" ] ||
      die "远端已有配置（$OLDDIR/easy-charles.env）。--init 只用于首次部署；要改配置请直接编辑那个文件，或先删掉它。"
    ENV_SRC="$INIT_ENV"
    printf '   来源：--init（首次部署，新写入）\n'
  elif [ -n "$OLDDIR" ] && [ -f "$OLDDIR/easy-charles.env" ]; then
    ENV_SRC="$OLDDIR/easy-charles.env"
    printf '   来源：上一版目录\n'
  elif [ -f "$BASE/easy-charles.env" ]; then
    # 手工部署（DEPLOY.md §3B）常把配置放在基础目录里，也就是 ~/apps/easy-charles.env，
    # 而不是某个版本目录里。这里认它。
    # 只在"没有上一版目录"时采用：一旦有已经在跑的版本目录，就以那份为准，
    # 免得出现"改哪一份才算数"的歧义（两个地方各有一份时，跑的那份说了算）。
    ENV_SRC="$BASE/easy-charles.env"
    printf '   来源：%s\n' "$BASE/easy-charles.env"
  else
    ENV_SRC="$(ls -1t "$BASE"/easy-charles-*/easy-charles.env 2>/dev/null | head -1 || true)"
    [ -n "$ENV_SRC" ] && printf '   来源：最近修改过的历史版本\n'
  fi
  [ -n "$ENV_SRC" ] ||
    die "$(printf '%s\n' \
      "没有 easy-charles.env（口令与 EC_ARGS 都在里面），三种来源都没找到。" \
      "   任选一条：" \
      "     · 本机加 --init（会提示交互设口令）" \
      "     · 在服务器上放一份 $BASE/easy-charles.env（权限 600，推荐）" \
      "     · 或在 $BASE/easy-charles-<版本>/easy-charles.env 放一份")"
  ENV_FILE="$ENV_SRC"

  # 顶层那份（$BASE/easy-charles.env）在"已有版本目录"之后就不再是配置来源了，
  # 但人第一反应总是去改它 —— 实测踩过：改了顶层那份、部署正常、口令却纹丝不动。
  # 所以这里主动比对口令，不一致就明说"你改的那份不生效、该改哪个文件"。
  if [ -f "$BASE/easy-charles.env" ] && [ "$ENV_SRC" != "$BASE/easy-charles.env" ]; then
    P_TOP="$(. "$BASE/easy-charles.env" >/dev/null 2>&1; printf '%s' "${EC_PASSWORD:-}")"
    P_USE="$(. "$ENV_SRC" >/dev/null 2>&1; printf '%s' "${EC_PASSWORD:-}")"
    if [ "$P_TOP" != "$P_USE" ]; then
      warn "两份配置的口令不一致，而「顶层那份」不生效："
      warn "   本次实际继承：$ENV_SRC"
      warn "   顶层那份：    $BASE/easy-charles.env"
      warn "   要改口令请改上面那个继承的文件；或者反过来，用顶层那份覆盖它并重跑。"
    fi
  fi
fi

# ── 配置自检（两种模式都要过）──────────────────────────────────
[ -f "$ENV_FILE" ] || die "找不到配置：$ENV_FILE"
ENV_PW="$(. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${EC_PASSWORD:-}")"
ENV_PORT="$(. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${EC_PORT:-}")"

[ -n "$ENV_PW" ] || die "$(printf '%s\n' \
  "配置里没有 EC_PASSWORD：$ENV_FILE" \
  "   安装脚本在非交互环境下会**静默退回默认口令 123456**（共享内网下这是安全洞），" \
  "   所以这里直接中止。请在配置里写 EC_PASSWORD=<口令> 后重跑。")"

# 「口令是默认值」只有 --init 那条路会拦（首次部署）。继承已有配置时上面的检查只问
# 「有没有」不问「是不是 123456」，于是局域网服务可以带着默认口令一次次"部署成功"，
# 谁都看不出问题——共享内网下这等于没有鉴权（同一个洞，见 ADR-024 决策 4）。
# 这里**警告但不拦路**：硬拦会让正在协作的一整组人突然部署失败，那是替用户做决定。
if [ "$ENV_PW" = "123456" ]; then
  warn "控制台口令仍是默认值 123456 —— 局域网里任何人都能进控制台改规则、看别人的抓包记录。"
  warn "   改法：编辑本次继承的那份配置（${ENV_FILE}）里的 EC_PASSWORD，再重跑一次部署。"
fi

if [ -n "$ENV_PORT" ] && [ -n "$PORT" ] && [ "$ENV_PORT" != "$PORT" ]; then
  die "$(printf '%s\n' \
    "端口不一致：配置里 EC_PORT=${ENV_PORT}，命令行给的是 --port $PORT" \
    "   改一个再来（不一致会让健康检查查出假失败）。")"
fi
[ -n "$PORT" ] || PORT="${ENV_PORT:-8899}"
printf '▸  配置自检通过（端口 %s，口令已设置）\n' "$PORT"

# EC_ARGS 为空本身不是错误（SDK 协议 /__ec/p 不需要额外参数），但**兼容协议客户端会整片 404**，
# 症状极具迷惑性：手机连得上、控制台页面正常、就是一条请求都看不到。
# 真机踩过：手写 env 只写了 EC_PORT/EC_PASSWORD，把开发机 conf 里的 --compat-route 丢了。
#
# 读的是**本次继承的那份配置**里的 EC_ARGS，不是本脚本自己的环境变量。
# 这里原来写的是 `${EC_ARGS:-}`，而本脚本从没 source 过 env 文件（上面取口令/端口用的是
# 子 shell），于是条件恒真：明明配了兼容层参数、服务也带着 `--compat-route` 起来了，
# 每次部署仍打一整段「EC_ARGS 为空，去把参数带过来」。误报喊多了，真出事时没人看。
ENV_ARGS="$(. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${EC_ARGS:-}")"
if [ -z "$ENV_ARGS" ]; then
  warn "EC_ARGS 为空：服务端没有任何额外参数。"
  warn "   若客户端走兼容协议（如 /mock-proxy 路由），它会整片 404 {\"error\":\"not found\"}，"
  warn "   控制台看不到任何请求。自查：ssh 到本机执行"
  warn "     curl -X POST http://127.0.0.1:${PORT}/mock-proxy/xxx"
  warn "   回 EC_TARGET_MISSING = 路由已挂；回 not found = 要把开发机 easy-charles.conf 的"
  warn "   EC_ARGS 一起带到这份配置里（--compat-route / --compat-target-header 等）。"
fi

# ── 解包就位（自检通过后才动文件系统）──────────────────────────
if [ -z "$USE" ]; then
  step "解包到版本目录"
  mkdir -p "$BASE"
  STAGE="$BASE/.staging-$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  tar xzf "$INCOMING/$TARBALL" -C "$STAGE" --strip-components=1
  NEW_VERSION="$(sed -n 's/^version: //p' "$STAGE/VERSION" 2>/dev/null | head -1)"
  [ -n "$NEW_VERSION" ] || die "产物里读不到 VERSION（包不完整？）"
  [ -f "$STAGE/run.sh" ] || die "产物里没有 run.sh（包不完整？）"
  STAMP="$(date '+%Y%m%d-%H%M%S')"
  TARGET="$BASE/easy-charles-$NEW_VERSION-$STAMP"
  # 同一秒内连跑两次（脚本化/压测）会撞名；撞了就加 pid 后缀，别直接失败
  [ ! -e "$TARGET" ] || TARGET="$TARGET-$$"
  [ ! -e "$TARGET" ] || die "目录已存在：$TARGET"
  mv "$STAGE" "$TARGET"
  cp -p "$ENV_SRC" "$TARGET/easy-charles.env"
  chmod 600 "$TARGET/easy-charles.env"
  printf '   v%s → %s\n' "$NEW_VERSION" "$TARGET"
fi

GIT_SHA="$(sed -n 's/^git: //p' "$TARGET/VERSION" 2>/dev/null | head -1)"

# ── 重装服务 ───────────────────────────────────────────────────
if [ "$SKIP_RESTART" -eq 1 ]; then
  warn "--skip-restart：文件已就位，但没有重装服务。手工启动："
  warn "  cd \"$TARGET\" && bash ./安装后台服务.command"
else
  step "重装 launchd 服务"
  # </dev/null 是必须的：本脚本自己是从 stdin 读进来的（bash -s），
  # 子命令若也去读 stdin，会把还没执行的脚本正文吃掉。
  ( cd "$TARGET" && bash ./安装后台服务.command </dev/null ) || die "安装脚本返回非 0：$TARGET/安装后台服务.command"

  # 安装脚本自己只「等一下然后打印警告」，就绪与否不体现在退出码上，
  # 所以这里是唯一真正的门禁。
  # 等 60 秒而不是 20 秒：launchd 对刚失败过的 job 会按 ThrottleInterval=10 退避重启，
  # 偶发情况下第一轮 20 秒窗口会整个落在退避期内，被误报成失败（实测遇到过）。
  # 正常情况第一次探测就返回，等得久不花时间。
  step "健康检查（最多等 60 秒）"
  URL="http://127.0.0.1:$PORT/"
  OK=0
  for _ in $(seq 1 120); do
    if curl -fsS -o "$TMPBODY" "$URL" 2>/dev/null && grep -q "EasyCharles" "$TMPBODY"; then
      OK=1
      break
    fi
    sleep 0.5
  done
  if [ "$OK" -ne 1 ]; then
    # 失败时把现场打出来，省得再去翻日志猜
    printf '   launchctl 状态：\n'
    launchctl print "gui/$(id -u)/$LABEL" 2>&1 |
      grep -E '(state|pid|last exit code|runs) =' | head -5 | sed 's/^/     /' || true
    printf '   stderr 末尾：\n'
    tail -8 "$LOG_DIR/server.err.log" 2>/dev/null | sed 's/^/     /' || true
    die "$(printf '%s\n' \
      "服务已装载，但 $URL 在 60 秒内没通过健康检查（HTTP 200 且含 EasyCharles）。" \
      "   完整日志：tail -50 \"$LOG_DIR/server.err.log\"" \
      "   常见原因：端口被占、Node 版本低于 22.6、macOS 防火墙拦了 node")"
  fi
  printf '   %s → 200 ✅\n' "$URL"
fi

# ── 清理旧版本 ─────────────────────────────────────────────────
if [ "$KEEP" -gt 0 ]; then
  step "清理旧版本（额外保留 $KEEP 个用于回滚）"
  # 末尾的 `|| true` 不能省：没有旧版本可删时 grep 退出码是 1，在 set -e + pipefail
  # 下这个管道会被判为失败、脚本当场退出 —— 日志、报告、incoming 清理就全都不执行了
  # （首次部署必然触发，实测过）。同理给 ls 也加了 || true，避免无匹配时报警。
  { ls -1dt "$BASE"/easy-charles-* 2>/dev/null || true; } | grep -v -F -x "$TARGET" |
    tail -n +"$((KEEP + 1))" | while IFS= read -r d; do
    printf '   删除 %s\n' "$d"
    rm -rf "$d"
  done || true
fi

# ── 部署日志 + 报告 ────────────────────────────────────────────
printf '%s\tv%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "${NEW_VERSION:-?}" "${GIT_SHA:-?}" "$TARGET" \
  >>"$BASE/deploy.log" 2>/dev/null || true

if [ -n "$USE" ]; then
  printf '\n✅ 已回滚到 %s\n' "$TARGET"
else
  printf '\n✅ 部署完成\n'
  printf '   版本       v%s（git %s）\n' "$NEW_VERSION" "${GIT_SHA:-?}"
fi
printf '   版本目录   %s\n' "$TARGET"
printf '   端口       %s\n' "$PORT"
printf '   日志       %s/server.{log,err.log}\n' "$LOG_DIR"
printf '   部署日志   %s/deploy.log\n' "$BASE"
if [ -n "$OLDDIR" ] && [ "$OLDDIR" != "$TARGET" ]; then
  printf 'previous_dir: %s\n' "$(basename "$OLDDIR")"
fi
printf 'version_dir: %s\n' "$(basename "$TARGET")"

# 成功后才清掉传入的产物（失败时留着便于排查）
if [ -z "$USE" ] && [ -n "$INCOMING" ]; then
  rm -f "$INCOMING/$TARBALL" "$INCOMING/$TARBALL.sha256" "$INCOMING/easy-charles.env"
fi
