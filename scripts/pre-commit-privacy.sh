#!/usr/bin/env bash
# pre-commit：拦下可能含隐私 / 密钥的内容
#
# 设计原则：**宁可漏，不可误报**。
# 文档里写 127.0.0.1、example.com、13800000000 这类占位符是正常需要，
# 所以只对「明显是真值」的特征报警，命中行会打印出来供人工确认。
#
# 安装：ln -sf ../../scripts/pre-commit-privacy.sh .git/hooks/pre-commit
# 或直接执行 bash scripts/pre-commit-privacy.sh（手动检查暂存区）

set -uo pipefail

FAIL=0
TMP=$(mktemp)
TMP2="${TMP}.hits"
: >"$TMP2"
# 暂存区文件清单，NUL 分隔。
# **必须**用 `-z` 配下面的 `read -r -d ''` 遍历，不能用 `for f in $(git diff --name-only)`：
#   ① git 默认按 core.quotePath 把非 ASCII 路径转义成 "...\345\220..."；
#   ② `for f in $STAGED` 会按空白分词，把含空格的路径拆散。
# 两者都会让 `[ -f "$f" ]` 判为不存在而 continue，也就是**静默漏检**——本文件曾经就是这样，
# 实测同内容的两份假密钥：ASCII 文件名被拦下、中文文件名被放行。
# NUL 分隔同时解决空格、中文、以及文件名里带换行的情况。
STAGED_FILE=$(mktemp)
trap 'rm -f "$TMP" "$TMP2" "$STAGED_FILE"' EXIT

# 只检查暂存区新增/修改的文件；--cached 拿 diff，--diff-filter 过滤状态
git diff --cached --name-only -z --diff-filter=ACMR >"$STAGED_FILE"
if [ ! -s "$STAGED_FILE" ]; then
  exit 0
fi

check() {
  local label="$1" pattern="$2" msg="$3" file="$4"
  # 匹配并写入结果文件，加行号便于定位
  if grep -nE "$pattern" "$file" >>"$TMP" 2>/dev/null; then
    if ! grep -q "^=== " "$TMP"; then :; fi
    {
      echo "=== $label :: $file"
      grep -nE "$pattern" "$file" | head -5
    } >>"$TMP.2" 2>/dev/null
    return 1
  fi
  return 0
}

# ── 1. 私钥与凭证文件（文件级，最硬的信号）──────────────────────
while IFS= read -r -d '' f; do
  case "$f" in
    *.pem|*.key|*.p12|*.pfx|*.jks|*.keystore|*.asc)
      echo "" >>"$TMP2"; echo "=== 私钥/证书文件 :: $f" >>"$TMP2"
      FAIL=1 ;;
    *id_rsa*|*id_dsa*|*id_ecdsa*|*id_ed25519*)
      echo "" >>"$TMP2"; echo "=== SSH 私钥文件 :: $f" >>"$TMP2"
      FAIL=1 ;;
    */.env|*/.env.*|*.env.local)
      # .env.example / .env.template 放行
      case "$f" in *.example|*.template|*.sample) ;; *)
        echo "" >>"$TMP2"; echo "=== 环境变量文件 :: ${f}（只应提交 .example）" >>"$TMP2"
        FAIL=1 ;;
      esac ;;
  esac
done <"$STAGED_FILE"

# ── 2. 私钥内容块 ────────────────────────────────────────────
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  if grep -qE "BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY" "$f" 2>/dev/null; then
    echo "" >>"$TMP2"; echo "=== 私钥内容 :: $f" >>"$TMP2"
    FAIL=1
  fi
done <"$STAGED_FILE"

# ── 3. 疑似真实 token / key（常见前缀 + 高熵串）────────────────
# 放行明显的占位符：xxx / your- / <...> / *** / ${...} / test / example / 123456
TOKEN_PAT='(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'
# 赋值形式：password/secret/token/api_key = "..."
ASSIGN_PAT='(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|app[_-]?secret)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+=-]{8,}'
# 右侧是「函数调用 / 成员访问」的赋值是代码，不是硬编码口令：
#   const token = randomUUID().replace(...)   /   token = decodeURIComponent(raw)
# 只放行「标识符紧跟左括号」这一种形态，检测面不缩小——`.env` / YAML 里的
# 裸字面量（`API_KEY=xxx`、`password: xxx`）仍会被 ASSIGN_PAT 拦下。
CODE_RHS_PAT='[[:space:]][:=][[:space:]]*["'"'"']?[A-Za-z_$][A-Za-z0-9_$.]*\('

while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  # 二进制跳过
  if file "$f" 2>/dev/null | grep -q "text"; then :; else continue; fi

  HITS=$(grep -nE "$TOKEN_PAT" "$f" 2>/dev/null | grep -vE "xxx|XXX|your-|<[A-Za-z_-]+>|\*\*\*|\$\{|example|placeholder|redact|假值|占位")
  [ -n "$HITS" ] && { echo "" >>"$TMP2"; echo "=== 疑似 token/key :: $f" >>"$TMP2"; echo "$HITS" | head -5 >>"$TMP2"; FAIL=1; }

  # 赋值型：排除明显的弱值与占位，以及「右侧是代码」的形态
  HITS2=$(grep -niE "$ASSIGN_PAT" "$f" 2>/dev/null | grep -vE "xxx|your-|<[A-Za-z_-]+>|\*\*\*|\$\{|example|placeholder|redact|changeme|123456|password\"\)|格式|口令|脱敏" | grep -vE "$CODE_RHS_PAT")
  [ -n "$HITS2" ] && { echo "" >>"$TMP2"; echo "=== 疑似明文口令赋值 :: $f" >>"$TMP2"; echo "$HITS2" | head -5 >>"$TMP2"; FAIL=1; }
done <"$STAGED_FILE"

# ── 4. 内网 IP（放行回环、0.0.0.0、Android 模拟器标准 10.0.2.2）────
# 只拦 RFC1918 段中「不像文档占位」的地址
# 放行：0.0.0.0 / 127.x / 10.0.2.2（模拟器标准）/ 10.0.0.1 与 10.0.0.11（AGENTS.md
# 登记的示例假值）/ 255.255.255.0，以及带 <内网 / example / 占位 等关键词的行
# 注意：grep -E 不支持 (?!...) 负向断言，放行逻辑放到管道里用 grep -v 做
LAN_PAT='(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})'
# 必须放行的白名单地址
# 10.0.0.1 是 AGENTS.md 明确登记的示例值，放行它是**有意的取舍**：
# 代价是"真实内网恰好是 10.0.0.1"这种（常见网关地址）不会被拦下。
LAN_ALLOW='(127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|0\.0\.0\.0|10\.0\.2\.2|10\.0\.0\.1|10\.0\.0\.11|255\.255\.255\.0)'

while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  file "$f" 2>/dev/null | grep -q "text" || continue
  # .md / docs 下多为说明性文字，默认放行；代码与配置严格查
  case "$f" in
    *.md) continue ;;
  esac
  HITS=$(grep -nE "$LAN_PAT" "$f" 2>/dev/null | grep -vE "$LAN_ALLOW" | grep -vE "<内网|<电脑|xxx|example|占位|你的|your|127\.0\.0\.1")
  [ -n "$HITS" ] && { echo "" >>"$TMP2"; echo "=== 内网 IP :: $f" >>"$TMP2"; echo "$HITS" | head -5 >>"$TMP2"; FAIL=1; }
done <"$STAGED_FILE"

# ── 5. .gitignore 是否覆盖了会被提交的敏感文件 ─────────────────
while IFS= read -r -d '' f; do
  case "$f" in
    server/.data/*|easy-charles.env|scripts/deploy.conf|*.keystore|*.jks|local.properties)
      echo "" >>"$TMP2"; echo "=== 本应被 .gitignore 忽略 :: $f" >>"$TMP2"
      FAIL=1 ;;
  esac
done <"$STAGED_FILE"

# ── 5.5 加解密密钥档（ADR-039）────────────────────────────────
# 密钥档的正规位置是 server/.data/crypto/settings.json（已被第 5 节拦住）。
# 这一节防的是「换了个地方存」：有人把配置挪到 server/crypto/、或顺手贴进某个
# 专项 json 里，gitignore 就不再保护它。**example 模板例外**（模板里全是占位值）。
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  case "$f" in
    *.example|*.example.json|*example*.json) continue ;;
    *.md) continue ;;
  esac

  # a) 路径像加解密配置 → 一律拦（宁可误报一次，也不要密钥进历史）
  case "$f" in
    *crypto*/settings.json|*crypto*/profiles.json|*crypto*/routes.json|*crypto-settings.json)
      echo "" >>"$TMP2"; echo "=== 加解密密钥档不在 .data/ 下 :: $f" >>"$TMP2"
      FAIL=1
      continue ;;
  esac

  # b) 内容同时出现「算法」与「非占位 key」→ 拦。只查配置/代码类扩展名，
  #    docs 与 .example 已在上面放行，避免把说明文字当成密钥。
  #    不用 `file | grep text` 判断：.json 的 file 输出是 "JSON data"（不含 text），
  #    那样会把最该查的配置文件全部跳过。
  case "$f" in
    *.json|*.ts|*.js|*.mjs|*.cjs|*.kt|*.java|*.yaml|*.yml|*.env|*.properties|*.xml) ;;
    *) continue ;;
  esac
  HAS_ALG=$(grep -cE '"(alg|algorithm)"[[:space:]]*:[[:space:]]*"(aes|des|sm4)-' "$f" 2>/dev/null || true)
  HAS_KEY=$(grep -cE '"(key|iv|secret)"[[:space:]]*:[[:space:]]*"[^"<]{6,}"' "$f" 2>/dev/null || true)
  if [ "${HAS_ALG:-0}" -gt 0 ] && [ "${HAS_KEY:-0}" -gt 0 ]; then
    echo "" >>"$TMP2"
    echo "=== 疑似硬编码加解密密钥 :: $f" >>"$TMP2"
    grep -nE '"(key|iv|secret)"[[:space:]]*:' "$f" | head -3 >>"$TMP2" 2>/dev/null
    FAIL=1
  fi
done <"$STAGED_FILE"

# ── 5.6 硬编码密钥常量（5.5 覆盖不到、却最容易发生的泄露形态）────────
# 5.5 认的是「alg 与 key 成对出现在同一个 JSON 里」。但实际被顺手提交的往往是
# 代码常量与 env 赋值：`const AES_KEY = "dE_z..."`、`val key = "..."`、`AES_KEY=...`。
# 它们没有 alg 字段，5.5 的 b) 分支一条都拦不住（实测：临时加进去钩子退出码仍是 0）。
#
# 判据：同一行里「标识符像密钥」+「32 字符以上的 base64/hex 字面量」+「值含数字或大写」。
#   · 含数字或大写：base64/hex 密钥几乎必然满足；而 'api/example/im/msg/detail'
#     这类全小写路径常量会被排除，不给日常提交制造噪音；
#   · 前后半完全相同的值视为构造出来的测试值（0123456789abcdef ×2），放行。
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  case "$f" in
    *.json | *.ts | *.js | *.mjs | *.cjs | *.kt | *.java | *.yaml | *.yml | *.xml | *.properties | *.env | *.sh | *.py | *.html | *.md) ;;
    *) continue ;;
  esac
  HITS=$(awk '
    # 一个「像密钥」的字面量：够长、整串都是 base64/hex 字符、含数字或大写、不是构造值。
    # 必须整串判断——只按「连续 32 位」匹配会把 ~/Library/Logs/EasyCharles/server 这种
    # 路径片段也算进来（实测 scripts/deploy.sh 就误报过一次）。
    function iskey(s,   n, h) {
      if (length(s) < 32) return 0
      if (s !~ /^[A-Za-z0-9+\/=_-]+$/) return 0
      if (s !~ /[0-9]/ && s !~ /[A-Z]/) return 0
      n = length(s)
      if (n % 2 == 0) {
        h = int(n / 2)
        if (substr(s, 1, h) == substr(s, h + 1)) return 0
      }
      return 1
    }
    {
      line = $0
      low = tolower(line)
      # ① 这一行得在说密钥/凭证，否则 32 位 base64 到处都是（hash、uuid、示例）
      #    `iv` 单独用词边界匹配：delivery / driver 里的 iv 不算，IV_SEED / _iv 才算
      if (low !~ /key|secret|salt|passw|pwd|cipher|token|credential/ && low !~ /(^|[^a-z])iv([^a-z]|$)/) next
      # ② 占位写法放行：example / placeholder / 0123456789 / abcdefgh ...
      if (low ~ /xxx|your[-_]|example|placeholder|changeme|dummy|fake|redact|123456|0123456789|abcdefgh/) next
      # ③ 引号包裹的字面量：const AES_KEY = "dE_z..." / val key = "..."（两种引号都要）
      sq = sprintf("%c", 39)
      qpat = "\"[^\"]*\"|" sq "[^" sq "]*" sq
      found = ""
      rest = line
      while (match(rest, qpat)) {
        s = substr(rest, RSTART + 1, RLENGTH - 2)
        rest = substr(rest, RSTART + RLENGTH)
        if (iskey(s)) { found = s; break }
      }
      # ④ 裸赋值：AES_KEY=xxxx / aes_key: xxxx（.env / yaml / properties 没有引号）
      #    `:` 也收——否则 yaml 里的 `key: dE_z...` 正好绕过去；冒号/等号后允许空格，
      #    否则 `key: xxx`（yaml 的常规写法）这一整类都漏。URL 里的 `://` 会被
      #    iskey 的「纯 base64 字符集」挡掉（`.` `:` 都不在集合内）。
      if (found == "") {
        rest = line
        while (match(rest, /[=:][[:space:]]*[A-Za-z0-9+\/=_-]+/)) {
          s = substr(rest, RSTART, RLENGTH)
          sub(/^[=:][[:space:]]*/, "", s)
          rest = substr(rest, RSTART + RLENGTH)
          if (iskey(s)) { found = s; break }
        }
      }
      if (found != "") print NR": "line
    }
  ' "$f" 2>/dev/null)
  if [ -n "$HITS" ]; then
    echo "" >>"$TMP2"
    echo "=== 疑似硬编码密钥常量 :: $f" >>"$TMP2"
    printf '%s\n' "$HITS" | head -5 >>"$TMP2"
    FAIL=1
  fi
done <"$STAGED_FILE"

# ── 5.7 私有加解密插件（ADR-040）──────────────────────────────
# 插件的正规位置是 <dataDir>/plugins/（已被 .gitignore 与发布包白名单排除）。
# 这一节防的是「图省事把插件放进源码树」——一旦进来，公开导出与发布包会把它一起带出去，
# 而插件里往往直接写着业务变形与密钥派生逻辑。
#
# 只认 server/ 下的 plugins 目录：示例模板放在 server/examples/<name>/，不在此列。
# 用 `*/plugins/*` 而不是精确路径，是为了覆盖 server/src/plugins、server/examples/plugins
# 这些「看起来更像个正经位置」的变体。
while IFS= read -r -d '' f; do
  case "$f" in
    server/plugins/*|server/*/plugins/*)
      case "$f" in
        *.mjs|*.cjs|*/manifest.json)
          echo "" >>"$TMP2"
          echo "=== 私有插件出现在源码树 :: $f" >>"$TMP2"
          echo "    插件应放在 <dataDir>/plugins/ 下（不进 git、不进发布包）" >>"$TMP2"
          FAIL=1 ;;
      esac ;;
  esac
done <"$STAGED_FILE"

# ── 5.8 真实业务标识（§5.5–5.7 管密钥，这一节管「设计图」）──────────
# 代码与「使用」是分开的：真实密钥档、规则、快照、业务脚本全在 <dataDir>，不进库。
# 但文档、示例、自测里很容易顺手写下真实的接口路径与字段名——这些不含密钥，
# 却把内部 API 面貌与加密布局摊开了。仓库一旦 public，伤害是不可逆的（fork/缓存），
# 所以按「业务标识」拦，判据是「换个团队还用不用得上」：用得上的是通用示例，
# 只对自己接口成立的是业务标识。
#
# 特征词写成变量集中一处，避免散落在各处漏改。
IDENT_PAT='(wireless-api|/user/app/signature|cipherparam|\bjobmd\b)'
if [ "${EC_ALLOW_REAL_IDENT:-0}" != "1" ]; then
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    # 规则自己必须写出特征词才能匹配，跳过；二进制同样跳过
    case "$f" in scripts/pre-commit-privacy.sh) continue ;; esac
    file "$f" 2>/dev/null | grep -q "text" || continue
    if grep -qE "$IDENT_PAT" "$f" 2>/dev/null; then
      echo "" >>"$TMP2"
      echo "=== 真实业务标识 :: $f" >>"$TMP2"
      grep -nE "$IDENT_PAT" "$f" | head -5 | sed 's/^/    /' >>"$TMP2"
      echo "    改成占位口径：/api/example/... · myapp · payload" >>"$TMP2"
      FAIL=1
    fi
  done <"$STAGED_FILE"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  提交被拦截：检测到可能含隐私 / 密钥的内容                ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  cat "$TMP2"
  echo ""
  echo "处理方式："
  echo "  · 确认是假值 → 在 AGENTS.md 第 2 节登记，或改用占位符写法"
  echo "  · 确实是真值 → 从暂存区移除：git rm --cached <文件>"
  echo "  · 确认误报    → git commit --no-verify（请先想清楚）"
  echo ""
  exit 1
fi

exit 0
