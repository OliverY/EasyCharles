#!/bin/bash
# 构建 EasyCharles 服务端发布包（tar.gz），供内网服务器部署。
#
# 用法：scripts/build-server-bundle.sh [--skip-checks]
# 产物：build/easy-charles-server-<版本>.tar.gz
# 部署说明：scripts/deploy/DEPLOY.md（会被一起打进包）
#
# 三条设计原则：
#   1. **白名单收集**：只拷 src / web / package*.json / node_modules/ws 和 4 个模板，
#      不用 git archive、更不用 cp -r 整个仓库 —— 从根上排除 .data/、easy-charles.env、
#      .git、android-sdk/。发布包是要交给别人机器的，不能靠"记得排除"。
#   2. **打包前跑门禁**：tsc --noEmit + selftest 全绿 + web 三件套齐全 +
#      ws 版本与 lockfile 一致。红着的代码不许出门。
#   3. **打包后校验产物**：必需条目必须在、禁忌条目必须不在，并打印 sha256。
#
# 注意：产物里带的是 node_modules/ws（运行时唯一依赖），所以目标机不需要 npm 和外网。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER="$ROOT/server"
DEPLOY="$SCRIPT_DIR/deploy"
OUT_DIR="$ROOT/build"

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

SKIP_CHECKS=0
for a in "$@"; do
  case "$a" in
  --skip-checks) SKIP_CHECKS=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    printf '✖  未知参数：%s（可用：--skip-checks）\n' "$a" >&2
    exit 2
    ;;
  esac
done

fail() { printf '✖  %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
step() { printf '▸  %s\n' "$*"; }

# ── 0) 前提 ────────────────────────────────────────────────────
[ -f "$SERVER/src/index.ts" ] || fail "构建位置不对：没找到 $SERVER/src/index.ts"
[ -d "$SERVER/node_modules/ws" ] || fail "缺 server/node_modules/ws，请先在 server/ 下执行 npm install"
command -v node >/dev/null 2>&1 || fail "没找到 node"

# 服务端真正会读的控制台页面，从源码里推导（readFileSync(join(__dirname,'..','web',X))）。
# 不手工维护清单：① 加了新页面忘改打包脚本，只会在运行时 500；
# ② server/web 下的 demo / 草稿页（如 style-demo*.html）服务端根本不读，
#    带进发布包纯属白送体积和隐私面 —— 见下面「只允许源码引用的页面」校验。
WEB_PAGES="$(grep -oE "'web', *'[^']+'" "$SERVER/src/index.ts" | sed "s/.*'\([^']*\)'$/\1/" | sort -u)"
[ -n "$WEB_PAGES" ] || fail "没能从 src/index.ts 推导出控制台页面清单（grep 模式可能过时了）"

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SERVER/package.json" | head -1)"
[ -n "$VERSION" ] || fail "无法从 server/package.json 读到 version"

if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    GIT_DIRTY="yes"
  else
    GIT_DIRTY="no"
  fi
else
  GIT_SHA="unknown"
  GIT_DIRTY="unknown"
fi

step "版本 v${VERSION}（git ${GIT_SHA}，工作区有未提交改动：${GIT_DIRTY}）"

# ── 1) 门禁 ────────────────────────────────────────────────────
if [ "$SKIP_CHECKS" -eq 1 ]; then
  printf '⚠  已跳过门禁（--skip-checks）：产物可能来自红着的代码，别发出去\n' >&2
else
  step "门禁 1/4：类型检查（tsc --noEmit）"
  TSC="$SERVER/node_modules/.bin/tsc"
  [ -x "$TSC" ] || fail "找不到 ${TSC}，请先在 server/ 下执行 npm install"
  (cd "$SERVER" && "$TSC" --noEmit) || fail "类型检查未通过，发布包不构建"
  log "    通过"

  step "门禁 2/4：自测（node tools/selftest.ts）"
  set +e
  ST_OUT="$(cd "$SERVER" && node tools/selftest.ts 2>&1)"
  ST_CODE=$?
  set -e
  if [ "$ST_CODE" -ne 0 ]; then
    printf '%s\n' "$ST_OUT" | tail -20 >&2
    fail "selftest 退出码为 ${ST_CODE}，发布包不构建"
  fi
  case "$ST_OUT" in
  *"0 失败"*) ;;
  *)
    printf '%s\n' "$ST_OUT" | tail -20 >&2
    fail "selftest 未全绿（输出里没有「0 失败」），发布包不构建"
    ;;
  esac
  log "    $(printf '%s\n' "$ST_OUT" | grep -E '结果：' | tail -1)"

  step "门禁 3/4：控制台页面齐全（清单由 src/index.ts 推导）"
  for f in $WEB_PAGES; do
    [ -f "$SERVER/web/$f" ] || fail "缺 server/web/${f}（源码会读它，缺了控制台会 500）"
  done
  log "    $(printf '%s' "$WEB_PAGES" | tr '\n' ' ')"

  step "门禁 4/4：ws 版本与 lockfile 一致"
  WS_INSTALLED="$(node -p "require('$SERVER/node_modules/ws/package.json').version")"
  WS_LOCKED="$(node -p "require('$SERVER/package-lock.json').packages['node_modules/ws'].version")"
  [ "$WS_INSTALLED" = "$WS_LOCKED" ] ||
    fail "ws 版本不一致：已安装 ${WS_INSTALLED}，lockfile 记的是 ${WS_LOCKED}（先在 server/ 下 npm ci）"
  log "    ws $WS_INSTALLED"
fi

# ── 2) 白名单收集 ──────────────────────────────────────────────
STAGE="$(mktemp -d)"
CHECK_DIR=""
# 校验阶段会把包**解到** CHECK_DIR（见 §4 为什么要解而不是列清单），退出时一起清掉
trap 'rm -rf "$STAGE" ${CHECK_DIR:+"$CHECK_DIR"}' EXIT
NAME="easy-charles-server-$VERSION"
PKG="$STAGE/$NAME"

step "收集文件（白名单）"
mkdir -p "$PKG/server/src" "$PKG/server/web" "$PKG/server/node_modules"

cp -R "$SERVER/src/." "$PKG/server/src/"
# 只带源码真正会读的页面：server/web 下的 demo / 草稿页既不可访问也无用途
for f in $WEB_PAGES; do
  cp "$SERVER/web/$f" "$PKG/server/web/$f"
done
cp "$SERVER/package.json" "$SERVER/package-lock.json" "$PKG/server/"
cp -R "$SERVER/node_modules/ws" "$PKG/server/node_modules/ws"

cp "$DEPLOY/run.sh" "$DEPLOY/easy-charles.service" \
  "$DEPLOY/easy-charles.env.example" "$DEPLOY/DEPLOY.md" "$PKG/"

# macOS 目标机（没有 systemd）：双击脚本 + launchd 用户级 agent 模板
# remote-deploy.sh 也放进去：它是「服务器侧」那半（校验/解包/重装/健康检查），
# 开发机是通过 stdin 把它喂给远端 bash 的；放进包里就等于服务器侧也能离线自给。
cp "$DEPLOY/local.easycharles.server.plist" \
  "$DEPLOY/启动EasyCharles.command" \
  "$DEPLOY/安装后台服务.command" \
  "$DEPLOY/卸载后台服务.command" \
  "$DEPLOY/remote-deploy.sh" "$PKG/"
chmod 755 "$PKG/run.sh"

# macOS 的目录里常有 .DS_Store，进发布包只会让人困惑
find "$PKG" -name '.DS_Store' -delete 2>/dev/null || true

# ── 统一权限位（必须做，不是洁癖）──────────────────────────────
# 仓库里有文件的 mode 是 600（如 server/web/about.html），cp 会原样带出去。
# 发布包一般由 root 解到 /opt，systemd 里服务以普通用户（easycharles）运行，
# 600 的文件那个用户读不到 —— 表现为 /about 页 500、控制台首页却正常，极难查。
# 所以这里强制统一：目录 755、文件 644；然后**在统一之后**把该可执行的挑回来
# （.command 少了执行位在 macOS 上就双击不动）。
find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod 644 {} +
chmod 755 "$PKG/run.sh" "$PKG/启动EasyCharles.command" \
  "$PKG/安装后台服务.command" "$PKG/卸载后台服务.command" "$PKG/remote-deploy.sh"

{
  echo "name: $NAME"
  echo "version: $VERSION"
  echo "git: $GIT_SHA"
  echo "git_dirty: $GIT_DIRTY"
  echo "built_at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "built_on: $(uname -srm) / node $(node -v)"
} >"$PKG/VERSION"

# ── 3) 打包 ────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/$NAME.tar.gz"
rm -f "$TARBALL"
(cd "$STAGE" && tar czf "$TARBALL" "$NAME")

# ── 4) 校验产物 ────────────────────────────────────────────────
step "校验产物"
# 先**真的解一份出来**，再按解包后的目录核对条目名，而不是 grep `tar -tzf` 的输出：
# bsdtar 在非 UTF-8 locale 下（agent / CI / LANG 未设置的终端，实测 LC_CTYPE=C）会把
# 中文条目名转义成 \345\256\211… 这样的八进制串，于是「启动EasyCharles.command」这类
# 必需条目永远匹配不上——包是对的，门禁却报「缺必需条目」。解出来核对与本地 locale 无关，
# 顺带还证明了「这个包真解得开」，比只列清单更贴近目标机上会发生的事。
CHECK_DIR="$(mktemp -d)"
tar xzf "$TARBALL" -C "$CHECK_DIR" || fail "产物解不开：$TARBALL"
LIST="$(cd "$CHECK_DIR" && find "$NAME" | sed 's|^\./||')"

REQUIRED="
$NAME/run.sh
$NAME/easy-charles.service
$NAME/easy-charles.env.example
$NAME/DEPLOY.md
$NAME/VERSION
$NAME/local.easycharles.server.plist
$NAME/启动EasyCharles.command
$NAME/安装后台服务.command
$NAME/卸载后台服务.command
$NAME/remote-deploy.sh
$NAME/server/package.json
$NAME/server/package-lock.json
$NAME/server/src/index.ts
$NAME/server/src/config.ts
$NAME/server/src/data-plane.ts
$NAME/server/src/control-plane.ts
$NAME/server/src/rules.ts
$NAME/server/src/snapshots.ts
$NAME/server/src/store.ts
$NAME/server/src/types.ts
$NAME/server/web/index.html
$NAME/server/web/about.html
$NAME/server/web/snapshot.html
$NAME/server/node_modules/ws/package.json
"
# 用 here-doc 逐行读而不是 `for need in $REQUIRED`：① 按空白分词会把带空格的
# 文件名拆散；② 放进管道会让 fail 在子 shell 里 exit（脚本继续跑，校验形同虚设）。
while IFS= read -r need; do
  [ -n "$need" ] || continue
  printf '%s\n' "$LIST" | grep -qxF "$need" || fail "产物缺必需条目：$need"
done <<EOF
$REQUIRED
EOF

# 双击脚本必须有执行位（2026 上 .command 没有 +x，macOS 双击会报没权限）
# 同样按**解出来的文件**判断，不看 `tar -tvzf` 的名称列（中文名会被转义，grep 不到
# 就会误报「缺执行位」）；tar 解包保留权限位，所以 [-x] 就是包里的那个位。
for c in run.sh 启动EasyCharles.command 安装后台服务.command 卸载后台服务.command remote-deploy.sh; do
  ENTRY="$CHECK_DIR/$NAME/$c"
  [ -f "$ENTRY" ] || fail "产物里没有：$c"
  [ -x "$ENTRY" ] ||
    fail "双击脚本/入口缺执行位：${c}（解出来是 $(ls -l "$ENTRY" | awk '{print $1}')）"
done

# 源码引用的页面必须都在（万一以后加了第 4 个页面，这里会拦住漏带）
for f in $WEB_PAGES; do
  printf '%s\n' "$LIST" | grep -qxF "$NAME/server/web/$f" ||
    fail "产物缺源码引用的控制台页面：server/web/$f"
done

# 反向：server/web 下只允许出现源码真正读取的页面。
# demo / 草稿页（style-demo*.html 之类）服务端既不可访问也无用途，
# 白送体积之外还可能带进示例数据（曾发现里面有示例昵称，与开发机用户名一致）。
EXTRA_WEB=""
for entry in $(printf '%s\n' "$LIST" | grep -E "^$NAME/server/web/[^/]+$"); do
  base="${entry##*/}"
  printf '%s\n' "$WEB_PAGES" | grep -qxF "$base" || EXTRA_WEB="$EXTRA_WEB $base"
done
if [ -n "$EXTRA_WEB" ]; then
  fail "产物带了源码不读取的页面：${EXTRA_WEB} （demo/草稿页不该进发布包）"
fi

# 正面白名单之外再兜一层：这些一旦进包就是隐私事故
FORBIDDEN_PAT='(^|/)(\.data|\.data-selftest|\.git|\.workbuddy|\.workbuddy-ai)(/|$)|(^|/)easy-charles\.conf$|(^|/)\.env$|(^|/)crypto/(settings|profiles|routes)\.json$|(^|/)crypto-settings\.json$|\.pem$|\.key$|\.p12$|\.jks$|\.keystore$|\.log$|\.DS_Store$'
BAD="$(printf '%s\n' "$LIST" | grep -E "$FORBIDDEN_PAT" || true)"
if [ -n "$BAD" ]; then
  printf '%s\n' "$BAD" | head -10 >&2
  fail "产物含禁忌条目（隐私 / 运行时数据 / 本机配置）"
fi

# 权限位校验：发布包会被 root 解到 /opt 而以普通用户运行，出现 600/640 就是隐患
BADMODE="$(tar -tvzf "$TARBALL" | awk '{print $1}' | grep -vE '^(-rw-r--r--|drwxr-xr-x|-rwxr-xr-x)$' || true)"
if [ -n "$BADMODE" ]; then
  printf '%s\n' "$BADMODE" | sort -u | tr '\n' ' ' >&2
  printf '\n' >&2
  fail "产物里有非 644/755 权限的条目：服务以普通用户运行时可能读不到（如 /about 页 500）"
fi

# 发布包里不应该出现任何真实口令：模板里只允许占位符写法
PWMARK="your-password"
if ! tar -xzOf "$TARBALL" "$NAME/easy-charles.env.example" 2>/dev/null | grep -qF "$PWMARK"; then
  fail "easy-charles.env.example 里的口令占位符（${PWMARK}）不见了，确认没有把真实口令写进模板"
fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
else
  SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
fi

# 随包给一个校验文件：跨机器传输（AirDrop / scp / U 盘）后能一行核对有没有传坏
SHA_FILE="$TARBALL.sha256"
printf '%s  %s\n' "$SHA" "$(basename "$TARBALL")" >"$SHA_FILE"

echo ""
echo "✅ 发布包已生成"
printf '   %s\n' "$TARBALL"
printf '   大小      %s\n' "$(du -h "$TARBALL" | cut -f1)"
printf '   sha256    %s\n' "$SHA"
printf '   校验文件  %s\n' "$SHA_FILE"
printf '   条目数    %s\n' "$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"
echo ""
echo "   目标机校验（把两个文件一起传过去）："
printf '     shasum -a 256 -c %s      # macOS\n' "$(basename "$SHA_FILE")"
printf '     sha256sum -c %s          # Linux\n' "$(basename "$SHA_FILE")"
echo ""
echo "   部署（详见包内 DEPLOY.md）："
echo "     macOS 一条命令（含传输/校验/解包/重装/健康检查/回滚命令）："
echo "       scripts/deploy-to-lan.sh <ssh 远端>            # 首次加 --init"
echo "     Linux：tar xzf <包> -C /opt → 配 /etc/easy-charles/easy-charles.env → systemctl enable --now easy-charles"
echo "     macOS 手工：解包后双击「安装后台服务.command」（或「启动EasyCharles.command」前台跑）"
echo ""
