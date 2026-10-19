# EasyCharles 服务端部署说明

本文件随发布包一起分发，是**部署这个包的唯一依据**。架构与协议见仓库里的
`docs/architecture.md`、`docs/protocol.md`。

> 一句话定位：EasyCharles 是**联调期用的本地中转服务**（抓包记录 + Mock + 故障注入）。
> 把它放到内网服务器给小组共用是可行的，但它的安全模型是按「可信网络」设计的，
> 部署前请务必读「安全须知」。

---

## 1. 包里有什么

```
easy-charles-server-<版本>/
├── run.sh                          启动入口（Node 探测 + EC_* 环境变量翻译）
├── easy-charles.service            Linux：systemd unit 模板
├── local.easycharles.server.plist  macOS：launchd 用户级 agent 模板（由安装脚本填充）
├── 启动EasyCharles.command          macOS：双击前台启动（终端里看日志）
├── 安装后台服务.command              macOS：双击安装（开机自启 + 崩溃拉起）
├── 卸载后台服务.command              macOS：双击停止并取消自启
├── remote-deploy.sh                macOS：**服务器侧**那半（校验/解包/重装/健康检查/清理）；
│                                   正常由开发机的 scripts/deploy-to-lan.sh 经 stdin 喂给
│                                   远端 bash，放在包里是为了服务器侧也能离线自给
├── easy-charles.env.example        环境变量模板（Linux 复制到 /etc/easy-charles/，
│                                   macOS 复制成本目录的 easy-charles.env）
├── DEPLOY.md                       本文件
├── VERSION                         版本 + git 提交 + 构建时间
└── server/
    ├── src/                        服务端源码（TypeScript，直接运行，无需编译）
    ├── web/                        控制台页面（index / about / snapshot）
    ├── package.json
    ├── package-lock.json
    └── node_modules/ws/            运行时唯一依赖，已随包带上（无需 npm install）
```

发布包**不含**任何运行数据、口令或本机配置。首次启动会自动创建数据目录。

### 传输后先校验（跨机器必做）

打包时会在包旁边生成 `easy-charles-server-<版本>.tar.gz.sha256`。
两个文件一起传（AirDrop / scp / U 盘），目标机上核对：

```bash
shasum -a 256 -c easy-charles-server-0.1.0.tar.gz.sha256   # macOS
sha256sum -c easy-charles-server-0.1.0.tar.gz.sha256       # Linux
```

## 2. 目标机要求

| 项 | 要求 |
|---|---|
| Node.js | **22.6+（推荐 23.6+）**。服务端直接跑 `.ts`，靠 Node 原生类型剥离；22.6~22.x、23.0~23.5 需要 `--experimental-strip-types`，`run.sh` 会自动判断并加上 |
| 架构 | 纯 JS，无原生模块；x86_64 / arm64 均可（macOS 同样适用） |
| 依赖安装 | **不需要**。`ws` 已随包带上，目标机不需要 npm，也不需要外网 |
| 磁盘 | 代码约 1 MB；数据随抓包量增长（快照和规则落盘，记录本身在内存） |
| 端口 | 默认 `8899`（可用 `EC_PORT` / `--port` 改） |
| 服务管理 | Linux 用 systemd（`easy-charles.service`）；**macOS 没有 systemd**，用包内双击脚本 + launchd（见 3B） |

`run.sh` 会**实际跑一个 .ts 探测文件**来确认类型剥离可用，而不是只看版本号——
发行版裁剪或自编译的 Node 可能例外，这种情况会直接报错退出，不会跑到一半才炸。
`run.sh` 本身用 `/bin/bash` 执行，macOS 自带的 bash 3.2 已实测可用。

## 3. 部署（5 分钟）

以 `/opt/easy-charles` 为代码目录、`/var/lib/easycharles` 为数据目录、以非 root 用户
`easycharles` 运行为例：

```bash
# 1) 解包
sudo mkdir -p /opt && cd /opt
sudo tar xzf /tmp/easy-charles-server-0.1.0.tar.gz
sudo mv easy-charles-server-0.1.0 easy-charles
sudo chmod +x /opt/easy-charles/run.sh

# 2) 建运行用户（不需要登录 shell）
sudo useradd --system --no-create-home --shell /usr/sbin/nologin easycharles

# 3) 口令等敏感项放单独文件，不要写进 unit
sudo mkdir -p /etc/easy-charles
sudo cp /opt/easy-charles/easy-charles.env.example /etc/easy-charles/easy-charles.env
sudo vi /etc/easy-charles/easy-charles.env      # 至少改 EC_PASSWORD
sudo chmod 600 /etc/easy-charles/easy-charles.env
sudo chown root:root /etc/easy-charles/easy-charles.env

# 4) 装 systemd unit
sudo cp /opt/easy-charles/easy-charles.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now easy-charles

# 5) 看状态与日志
systemctl status easy-charles
journalctl -u easy-charles -n 50 --no-pager
```

**验证**：

```bash
# 控制台页面（未鉴权静态页，返回 200 且含 EasyCharles 字样）
curl -fsS http://127.0.0.1:8899/ | head -c 200

# 管理面必须登录（未登录返回 401 {"error":"EC_UNAUTHORIZED"} —— 这是正常的）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/__ec/api/info

# 从另一台机器确认端口可达（换成服务器真实 IP）
curl -fsS http://10.0.0.1:8899/ | head -c 80
```

浏览器打开 `http://<服务器IP>:8899/`，用**任意手机号 + 你设置的 `EC_PASSWORD`** 登录
（首次登录即注册该手机号空间）。

**客户端接入**：把 App/SDK 的 `baseUrl` 指向 `http://<服务器IP>:8899`，请求走
`/__ec/p/<原始 path>`。具体见仓库 `README.md` 的「Android 接入」与
`docs/protocol.md` §2。

## 3B. macOS 目标机（没有 systemd，用包内双击脚本）

macOS 上没有 systemd，`easy-charles.service` 用不了。包内提供三个双击脚本：

| 双击这个 | 做什么 |
|---|---|
| **启动EasyCharles.command** | 前台启动，终端窗口里能看到全部日志；关窗口 / `Ctrl-C` 即停止。**临时调试用这个** |
| **安装后台服务.command** | 装成 launchd 用户级 agent：开机自启 + 崩溃自动拉起；会问你要控制台口令 |
| **卸载后台服务.command** | 停止并取消自启（**数据与日志都保留**） |

准备一次本地配置（可选但推荐，否则每次都要输口令）：

```bash
cd <解包目录>
cp easy-charles.env.example easy-charles.env
vi easy-charles.env          # 至少改 EC_PASSWORD；EC_ADMIN 可填白名单
```

然后双击 **安装后台服务.command**，它会：

1. 读 `./easy-charles.env`（没有就用默认端口 8899、数据目录
   `~/Library/Application Support/EasyCharles/data`）；
   `EC_ARGS` 也会一起写进 plist（兼容层等参数就靠它，见 §4），安装完会把生效值打印出来；
2. **把 node 解析成绝对路径**写进 plist —— 必须这样：launchd 给 job 的 `PATH` 只有
   `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew / nvm 装的 node 不在里面，
   `run.sh` 里的 `command -v node` 会找不到；
3. 生成 `~/Library/LaunchAgents/local.easycharles.server.plist` 并装载，
   日志写到 `~/Library/Logs/EasyCharles/server.log`（错误另有一份 `server.err.log`）。

手工排查用的等价命令：

```bash
launchctl print gui/$(id -u)/local.easycharles.server      # 看状态
tail -50 ~/Library/Logs/EasyCharles/server.err.log         # 看报错
launchctl bootout gui/$(id -u)/local.easycharles.server    # 停掉（KeepAlive 会拉起进程，不能只 kill）
```

macOS 上的三个坑：

1. **需要目标 Mac 自己装 Node 22.6+**（推荐 23.6+）——包里不含 Node。用 Homebrew / nvm /
   官网安装包都行；若 `run.sh` 报「没找到 node」，在 `easy-charles.env` 里用
   `EC_NODE_BIN=/绝对路径/node` 指定。
   **launchd 的 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，看不到 Homebrew**，
   所以安装脚本会把解析到的 node 绝对路径写进 plist 的 `EnvironmentVariables.EC_NODE_BIN`，
   `run.sh` 优先用它 —— 因此在 plist 的 `ProgramArguments` 里**看不到 node 是正常的**
   （那里只有 `/bin/bash <版本目录>/run.sh --lan`）。想确认服务到底用的哪个 node：
   `ps -p $(lsof -nP -iTCP:8899 -sTCP:LISTEN -t) -o command=`。
2. **开了 macOS 防火墙**时第一次 `--lan` 会弹「是否允许 node 接受传入连接」，要选允许，
   否则手机/同网段机器连不上。
3. **经 AirDrop / 浏览器下载的包带隔离属性**，双击脚本可能被拦。任选其一：
   右键 → 打开；或在终端执行 `xattr -dr com.apple.quarantine <解包目录>`。

## 3C. 一条命令部署（开发机 → 局域网 macOS 目标机）

上面 §3 与 §3B 是**在目标机上手工做**的。如果目标是"我在这台 Mac 上改代码，另一台
局域网 Mac 只跑服务"，用开发机上的 `scripts/deploy-to-lan.sh` 把整套动作收成一条命令。
它**不在发布包里**，是开发机的工具（和 `build-server-bundle.sh` 同级）。

角色划分（这是这套流程的核心）：

| 角色 | 在哪 | 需要什么 |
|---|---|---|
| ① 开发机 | 你的 Mac | 编辑器、Node、git |
| ② 平台（构建 + 分发） | **同一台** Mac | 完整工具链（门禁、打包、scp） |
| ③ 服务器 | 局域网另一台 Mac | **只要 Node** + 一个解开的目录；不需要 git / npm / 工具链 |

```bash
# 首次（会提示设置控制台口令，不落命令行）
scripts/deploy-to-lan.sh mac-b --init

# 以后每次改完代码
scripts/deploy-to-lan.sh mac-b

# 回滚（脚本每次都会把这条命令打出来）
scripts/deploy-to-lan.sh mac-b --use easy-charles-0.1.0-20261011-105317
```

完整动作（8 步，全自动）：门禁 `tsc --noEmit` + `selftest`（**不过就不出包**）→ 打包 →
scp 产物与 `.sha256` → 远端 `sha256` 校验 → 解到**新的版本目录**（配置从上一版目录继承）→
重装 launchd 服务 → 健康检查（`GET /` 返回 200 且含 `EasyCharles`）→ 清理旧版本并打印回滚命令。

| 选项 | 作用 |
|---|---|
| `--dir DIR` | 远端基础目录（默认 `~/apps`），版本目录建在它下面 |
| `--port N` | 省略就用远端 `easy-charles.env` 里的 `EC_PORT`（推荐省略） |
| `--keep N` | 额外保留几个旧版本目录用于回滚（默认 3） |
| `--init` | 首次部署：交互设口令，生成远端 `easy-charles.env` |
| `--use DIR` | 回滚/重装已有版本目录（跳过构建与传输） |
| `--skip-checks` / `--skip-restart` / `--dry-run` | 跳门禁（会警告）/ 只放文件 / 只在本机构建并打印计划 |

**为什么换版本目录而不是原地覆盖**：产物不可变，回滚就是把服务切回旧目录（1 分钟），
不需要 `git reset` 或重装依赖。

**几件必须知道的事**：

1. **`easy-charles.env` 不在发布包里**（它在解包目录里，`.gitignore` 也排除它）。
   脚本按这个顺序找配置，找到即用：

   | 顺序 | 来源 | 什么时候用 |
   |---|---|---|
   | 1 | `--init` 新生成的那份 | 首次部署（交互设口令） |
   | 2 | **上一版目录**里那份 | 正常升级（推荐，什么都不用做） |
   | 3 | **`~/apps/easy-charles.env`**（基础目录里那份） | 手工先建好配置、还没有任何版本目录时 |
   | 4 | 最新的 `~/apps/easy-charles-<版本>/easy-charles.env` | 版本目录还在、但服务没装（plist 丢了） |

   第 3 条是给"先在服务器上手工备好配置"用的；**一旦有版本目录在跑，就以那份为准**
   （避免两个地方各有一份、改哪个才算数的歧义）。
   四份都没有就会中止并告诉你三种补法 —— 不会静默用默认口令 `123456`。
   丢配置的后果：`EC_PASSWORD` 没了（谁都能进控制台）、`EC_ARGS` 没了
   （症状是"手机连上了但接口全 404"，最难查的那种）。

   **改口令/改配置时最容易踩的一步**：一旦有版本目录在跑，顶层那份 `~/apps/easy-charles.env`
   就**不生效了** —— 生效的是"继承来源"那一份。部署脚本会比对两份的 `EC_PASSWORD`，
   不一致就明确警告"本次实际继承的是哪个文件、你改的那份不生效"
   （真机实测踩过：改了顶层那份、部署也成功，但口令纹丝不动）。
   要改就改**继承来源那一份**，或者反过来用顶层那份覆盖它再重跑。

   **同理，`EC_ARGS` 也必须一起带过去。** 手写 `easy-charles.env` 时只写
   `EC_PORT`/`EC_PASSWORD` 是很自然的做法，但走**兼容协议**的客户端（如接管了旧
   `/mock-proxy` 路由的 App）需要 `--compat-route /mock-proxy --compat-target-header …` 这一串。
   缺了它的症状极具迷惑性：**手机侧接口全 404、控制台一条请求都看不到**，而手机上的
   mock 地址、开关、Wi-Fi、SDK 全都是对的（真机踩过，就是这么查了一轮）。
   一条命令自查：
   ```bash
   curl -s -X POST http://<服务器>:8899/mock-proxy/xxx
   # EC_TARGET_MISSING = 路由已挂（正常）；{"error":"not found"} = 没带 EC_ARGS
   ```
   部署脚本在 `EC_ARGS` 为空时会主动警告并给出这条自查命令。
2. **配置自检不过就不动文件系统**：缺口令（防安装脚本静默退回默认 `123456`）、
   端口与 `--port` 不一致，都会在解包之前中止。
3. **发版会清空抓包记录**（记录只在内存），但**规则、设备绑定、快照不受影响**。
4. **重启期间手机不会报错**：SDK 是 fail-open 的，连不上就直连真实服务器。
5. **手机与 App 不用做任何改动**（地址、端口都没变）—— 这是集中托管的收益。
6. **别在目标机上直接改代码**：下次部署就被覆盖，而且绕过了本机门禁。
7. 远端需要**免密 SSH**（`ssh mac-b true` 能通；不通就先 `ssh-copy-id mac-b`）。
   确实要用密码登录：`EC_DEPLOY_SSH_OPTS='-o BatchMode=no' scripts/deploy-to-lan.sh ...`。
8. 本脚本目前**只支持 macOS 目标机**（launchd）。Linux 目标机用 §3 的 systemd 流程。
9. **继承来的配置里如果写着默认口令 `123456`，部署会警告但不会拦**（`--init` 那条路才会拒）。
   拦下来会让正在协作的一整组人突然部署失败，所以只喊不停；听到就顺手把
   `EC_PASSWORD` 改掉——那份配置是**本次实际继承的那个文件**（脚本会告诉你继承的是哪一份）。
10. **部署能成、CLI/浏览器却连不上 8899**：这不是服务端的问题（真机踩过：同机 `curl 127.0.0.1:8899`
    1.3 ms 就回，跨机 SYN 无应答，而 SSH 一直是通的）。原因是**开发机自己挂着代理/VPN**：
    TUN 网卡会按端口把局域网流量吞掉，22 通、8899 不通。两条兜底：
    ```bash
    NO_PROXY=<服务器地址> <你的命令>                              # ① 让这一条命令不走代理
    ssh -f -N -L 18899:127.0.0.1:8899 <服务器>                    # ② 走 SSH 隧道，访问 http://127.0.0.1:18899
    ```
    隧道那条对 mock CLI 同样好用，但要**单独建一个 project 并登录**（凭据按 host 分开存，
    不会把 `http://<服务器>:8899` 的 token 发给 `http://127.0.0.1:18899`）：
    ```bash
    node tools/mock-cli/mock.ts project add tunnel --base-url http://127.0.0.1:18899
    node tools/mock-cli/mock.ts login --project-id tunnel --phone 13800000000 --password-stdin
    ```

### 3D. 再包一层：`scripts/deploy.sh`（目标机固定在项目里 + 自带验收）

§3C 的 `deploy-to-lan.sh` 每次都要**手打目标机**、自己记住"部署完该看哪几个信号"。
`scripts/deploy.sh` 在它之上只补三件每次都靠人记的事，代价是**没有交互**（是给脚本/AI 用的）：

| 命令 | 做什么 |
|---|---|
| `bash scripts/deploy.sh` | 部署：守卫 → 远端现状 → 门禁 + 打包 + 推送 + 重启 → **验收** |
| `bash scripts/deploy.sh check` | 体检：本机能否出包（跑完整门禁并打印产物与 sha256）+ 远端现在跑哪版，**一个字节也不推** |
| `bash scripts/deploy.sh status` | 只看远端：版本目录、端口、`EC_ARGS`、首页状态码、err.log 行数 |
| `bash scripts/deploy.sh rollback [N]` | 回滚到第 N 个旧版本（默认 1 = 上一个），只用远端已有目录，不重新构建 |
| `bash scripts/deploy.sh logs` | 远端 `server.log` / `server.err.log` 末尾 |
| `--dry-run` / `--target X` / `--keep N` / `--allow-dirty` | 打印计划不推送 / 临时换目标机 / 保留几个旧版 / 放行脏工作区 |

三条它自己定的规矩：

1. **目标机写在 `scripts/deploy.conf`**（不进 git，模板 `scripts/deploy.conf.example`）。
   里面是内网地址，所以真实那份被 `.gitignore` 排除；口令**不放这里**，只放远端
   `easy-charles.env`。换机器改这一个文件，所有命令跟着变。
2. **工作区不干净就不出包**。远端跑的那份必须能对上 commit，否则线上出问题查不到是哪一版。
   真要试临时改动加 `--allow-dirty`（会照样警告一句"远端跑的是 X 之外的未提交改动"）。
3. **验收三条都过才算上线**：版本目录确实换了、无会话访问管理面仍 401（ADR-018 的鉴权边界
   不能退化）、`err.log` 行数没涨。任一不过就打印原因 + `bash scripts/deploy.sh rollback`。

首次部署仍要走 §3C 的 `deploy-to-lan.sh <远端> --init`（要交互设口令，本脚本刻意不提供
`--init`）；之后一律用 `deploy.sh`。远端跑的是 launchd，日志路径写死在
`~/Library/Logs/EasyCharles/`，Linux 目标机用 §3。

## 4. 参数与环境变量

优先级：**命令行 > `EC_*` 环境变量 > `EC_ARGS` > 默认值**（`run.sh` 只翻译它认识的那几个变量，
其余参数原样透传给服务端；服务端取**第一个**出现的 flag，所以这个顺序就是优先级本身）。

`EC_ARGS` 是给"没有 `EC_*` 对应变量"的参数留的透传通道，典型用法：

```bash
# 第三方 mock SDK 的兼容层（漏配的典型症状：手机连上了但接口全 404）
EC_ARGS="--compat-route /mock-proxy --compat-target-header x-mock-original-url --compat-device-id-header x-install-id --compat-user-id-header x-business-user --compat-device-header mock-display-name --app-id my-app"
# 共享给多人时压内存
EC_ARGS="--record-mode sample --sample 65536 --max-records 5000"
```

它**抢不过**任何显式的 `EC_*` / 命令行，所以可以放心写在 `EnvironmentFile` /
`easy-charles.env` 里当兜底。注意：`EC_ARGS="--lan"` 同样会触发 §5 的暴露警告。

环境变量从哪来：Linux 是 systemd 的 `EnvironmentFile=/etc/easy-charles/easy-charles.env`；
**macOS 是解包目录下的 `./easy-charles.env`**（两个 `*.command` 脚本会自己 source 并导出它）。

> 注意：`easy-charles.env` 里按普通赋值写（`EC_PASSWORD=xxx`，**不需要** `export`）。
> 但如果你是**直接在终端跑 `./run.sh`**，它不读这个文件 —— 要么自己导出：
> `set -a; . ./easy-charles.env; set +a; ./run.sh --lan`，要么用命令行参数。

| 环境变量 | 等价命令行参数 | 默认 |
|---|---|---|
| `EC_PORT` | `--port <n>` | `8899`（服务端也直接读 `EC_PORT`） |
| `EC_HOST` | `--host <addr>` | `127.0.0.1`；用 `0.0.0.0` 暴露到内网 |
| `EC_LAN=1` | `--lan` | 关（= `--host 0.0.0.0`） |
| `EC_PASSWORD` | `--password <s>` | `123456` ⚠ 共享网络必须改 |
| `EC_ADMIN` | `--admin <手机号,手机号>` | 无管理员 |
| `EC_DATA_DIR` | `--data-dir <绝对路径>` | `<解包目录>/data` |
| `EC_ARGS` | 原样透传（按空格切分） | 空；用于 `EC_*` 覆盖不到的 flag，如 `--compat-*` / `--app-id` / `--record-mode` |
| `EC_NODE_BIN` | —（仅 `run.sh` 用） | `PATH` 里的 `node` |

服务端自身还有这些参数（直接写在 `ExecStart=` 里即可）：

| 参数 | 作用 | 默认 |
|---|---|---|
| `--record-mode full\|meta` | `meta` 只记元信息不存 body，省内存，适合长时间挂机 | `full` |
| `--max-records <n>` | 内存里保留的记录条数（环形缓冲，**重启即丢**） | `2000` |
| `--max-buffer <字节>` | 单条响应缓冲上限 | `524288` |
| `--sample <字节>` | 大响应的采样长度 | `8192` |
| `--upstream-timeout <ms>` | 上游超时 | `30000` |
| `--snapshot-ttl <小时>` | 快照有效期，`0` = 永不过期 | `168` |
| `--snapshot-max <n>` | 快照条数上限 | `200` |
| `--compat-route /a,/b` | 第三方客户端兼容层改写路由（默认关闭） | 空 |
| `--compat-target-header` / `--compat-device-id-header` / `--compat-device-header` / `--compat-user-id-header` / `--compat-user-name-header` | 兼容层头名 | `x-compat-*` |
| `--app-id <s>` | 兼容层客户端在控制台显示的 appId | `external-client` |

> 兼容层是为「已改造过的第三方 mock SDK」准备的（改写路由 + 原始 URL 头）。
> 同一账号多台手机时，应给每台安装持久化不同的 ID，并通过 `--compat-device-id-header` 指定请求头；
> 不配时退化为「用户 ID + 设备名」，两者在多台手机上相同仍会合并。
> 用原生 EasyCharles SDK 接入时**不要**开这些参数。

## 5. 数据与备份

| 路径 | 内容 | 重启后 |
|---|---|---|
| `<数据目录>/rules.json` | Mock 规则与顺序序列（含每设备指针） | ✅ 保留 |
| `<数据目录>/store.json` | 用户、设备归属绑定 | ✅ 保留 |
| `<数据目录>/snapshots/*.json` | 现场快照（按 TTL 过期） | ✅ 保留 |
| 内存记录列表 | 抓包记录本体 | ❌ **丢弃**（P1 才落库） |

- 备份就是备份整个数据目录（`tar czf` 即可，无数据库、无锁）。
- 数据目录里含**手机号与设备归属**，按公司隐私要求保管，别提交到任何仓库。
- 移动数据目录要同时改 `EC_DATA_DIR` 与 unit 的 `ReadWritePaths=`。

## 6. 安全须知（部署前必读）

1. **数据面按设计不鉴权**（ADR-015）。`/__ec/p*` 和兼容层路由不校验任何凭据，
   任何能访问该端口的人都能把服务器当**开放中转代理**用（可被用于 SSRF / 流量中转）。
   这是**有意的取舍**（为了 `adb reverse` 零暴露的本地体验），不是漏洞——
   但在共享网络上就等于你把这台机器借给别人发请求。
2. **必须改口令**。默认 `123456` 只适合本机自用。口令只决定「能否进控制台」，
   用户之间的隔离靠手机号空间 + 设备绑定。
3. **用网络边界自保**：只在内网/VPN 开放 8899，用防火墙或安全组限制来源网段；
   不要把 8899 直接暴露到公网。
4. **快照链接是能力 URL**：`/s/<token>` 打开即读、**不需要登录**（ADR-017），
   拿到链接的人就能看到那条请求/响应全文。发出去的链接要当敏感信息对待。
5. **会话会落盘**（ADR-031）：`.data/store.json` 里的 `sessions` 让浏览器在 `--session-ttl`（默认 720 小时）
   内**跨重启自动登录**，代价是「能读该文件 = 等价拿到登录态」。
   因此 `--password` 改口令后**重启也踢不掉已登录的会话**（口令只挡新登录）——
   要让改动立即生效，必须**先停服务**（运行中的进程会在下次落盘时把内存里的会话又写回去），
   再清掉 `sessions` 段，然后重启：
   `node -e 'const fs=require("fs"),f=".data/store.json",s=JSON.parse(fs.readFileSync(f,"utf8"));s.sessions={};fs.writeFileSync(f,JSON.stringify(s,null,2))'`
   （在 `server/` 目录下执行）。日常则把 `.data/` 当凭据目录对待：不共享、不进 git。
6. 想更安全可以只监听回环，改用 SSH 隧道或 `adb reverse`——但这就回到单人使用了。

## 7. 已知限制

| 限制 | 说明 / 影响 |
|---|---|
| **HTTPS 反向代理** | 控制台的 WebSocket 地址（`wsUrl`）按请求 `Host` 头生成且恒为 `ws://`（ADR-014），快照链接也恒为 `http://`。若在 nginx/caddy 上做 TLS 终结，**https 页面里的控制台会因 mixed content 连不上 WS**。当前版本请走内网 `http://` 直连；要支持 HTTPS 反代需要改代码（从 `X-Forwarded-Proto` 推导 scheme）。 |
| **没有优雅停机** | 服务端未处理 `SIGTERM`，`systemctl stop` 即直接终止；进行中的转发会中断。落盘数据不受影响。 |
| **抓包记录不落库** | 内存环形缓冲，重启清空（`rules.json`/`store.json`/快照保留）。 |
| **健康检查** | 管理面全部需要登录（`/__ec/api/info` 未登录返回 401），所以**探活用 `GET /`**（免鉴权静态页 + 含 `EasyCharles` 字样），不要用 `/__ec/api/*`。 |
| **多实例不共享状态** | 想横向扩多个实例的话数据不互通（记录在各自内存，规则文件各自一份），不建议。 |

## 8. 升级与回滚

```bash
# 升级：数据在 /var/lib 下，换代码目录不影响数据
sudo systemctl stop easy-charles
sudo mv /opt/easy-charles /opt/easy-charles.bak
sudo tar xzf /tmp/easy-charles-server-<新版本>.tar.gz -C /opt
sudo mv /opt/easy-charles-server-<新版本> /opt/easy-charles
sudo chmod +x /opt/easy-charles/run.sh
sudo systemctl start easy-charles
journalctl -u easy-charles -n 30 --no-pager

# 回滚：换回旧目录即可（数据目录格式向后兼容）
sudo systemctl stop easy-charles
sudo rm -rf /opt/easy-charles && sudo mv /opt/easy-charles.bak /opt/easy-charles
sudo systemctl start easy-charles
```

跨版本升级前建议先备份数据目录（见上一节）。若新版本改了 unit 文件，
记得同步 `/etc/systemd/system/easy-charles.service` 并 `daemon-reload`。

**macOS**（数据在 `~/Library/Application Support/EasyCharles/data`，换代码目录不影响数据）：

```bash
# 升级
双击「卸载后台服务.command」                      # 停止并取消自启
mv <旧解包目录> <旧解包目录>.bak
tar xzf <新包>.tar.gz -C ~/apps/                  # 解到新目录
cp <旧解包目录>.bak/easy-charles.env <新目录>/     # 沿用本地配置（口令等）
双击「安装后台服务.command」                       # 重新装载自启

# 回滚：换回旧目录再装一次
双击「卸载后台服务.command」
rm -rf <新目录> && mv <旧解包目录>.bak <旧解包目录>
双击 <旧解包目录>/「安装后台服务.command」
```

> 注意：`launchctl` 里记的是**解包目录的绝对路径**，所以升级/回滚都要在新目录里
> 重新双击安装一次，不能只挪文件。

上面这套手工动作就是 §3C 那条命令做的事（而且不会忘掉 `cp easy-charles.env`）。
开发机在同一个局域网时，直接用：

```bash
scripts/deploy-to-lan.sh mac-b                  # 升级
scripts/deploy-to-lan.sh mac-b --use <旧目录名>  # 回滚（部署成功时它会打印这一行）
```

> **升级路径上的一个坑（已修）**：`launchctl bootout` 是**异步**的，紧接着 `bootstrap`
> 同一个 label 会因 launchd 还没摘干净而失败。手工双击之间有间隔所以看不出来，
> 脚本化（毫秒级连续）必然踩中，症状是"脚本说装好了、其实 node 没跑"。
> 现在安装脚本会先等 job 真的消失、`bootstrap` 失败重试 10 次，并在最终失败时把
> launchd 的原始报错打出来。

## 9. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `✖ 发布包不完整：缺 server/web/...` | 解包不完整，或把 `server/` 和 `run.sh` 拆开拷了。`web/*.html` 必须与 `server/src/` 同级保留 |
| `✖ Node 版本过低` / `类型剥离不可用` | 目标机 Node < 22.6；装新一点的 Node，或用 `EC_NODE_BIN` 指向新版本 |
| 控制台打开是空白 / 500 | 看 `journalctl`，多半是 `server/web/` 缺失 |
| 数据"不见了" | 默认数据目录在**解包目录下**的 `data/`；unit 里改成了 `/var/lib/easycharles`。确认 `EC_DATA_DIR`，别在两个目录间反复重启 |
| 手机/别的机器连不上 | 只在回环监听：需要 `--lan` 或 `EC_HOST=0.0.0.0`；再确认防火墙放通端口 |
| 部署成功、`ssh` 通，但访问 8899 一直超时（服务端在同机 `curl` 秒回） | 客户端那侧的**代理/VPN TUN 网卡按端口截走了局域网流量**（22 通、8899 不通）。用 `NO_PROXY=<服务器地址>` 或 `ssh -L 18899:127.0.0.1:8899 <服务器>` 建隧道（见 §3C 第 10 条） |
| 手机连上了但接口全断 | 用了第三方 mock SDK 却没开兼容层参数（`--compat-route` 等），请求落到 404 |
| 端口被占用 | 改 `EC_PORT`，或查 `ss -lntp \| grep 8899` |

macOS 专属：

| 现象 | 原因 / 处理 |
|---|---|
| 双击脚本没反应 / 提示没权限 | 忘了执行位或带隔离属性。`chmod +x *.command`，或 `xattr -dr com.apple.quarantine <解包目录>` |
| 后台服务装了但 `run.sh` 报「没找到 node」 | launchd 的 `PATH` 很窄，Homebrew/nvm 的 node 不在其中。用安装脚本装（它会写 `EC_NODE_BIN` 绝对路径），或在 `easy-charles.env` 里自己指定 |
| 双击「卸载」后进程又起来了 | 那是前台启动的实例，或没卸载干净。`launchctl print gui/$(id -u)/local.easycharles.server` 确认已卸载，再去前台窗口 `Ctrl-C` |
| 手机连不上，服务本机正常 | 防火墙拦了。首次 `--lan` 要在弹窗里选允许；或到「系统设置 → 网络 → 防火墙」放行 node |
| 想看日志 | `~/Library/Logs/EasyCharles/server.log` 与 `server.err.log` |
