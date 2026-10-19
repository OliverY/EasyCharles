---
name: easy-charles-admin
description: 设置/取消 EasyCharles 部署实例的管理员。当用户说「把 <手机号> 设为管理员」「取消管理员」「谁是管理员」等涉及 --admin / EC_ADMIN / 管理员账号的事时使用。修改部署目标机上的 EC_ADMIN 并重启服务后验证。
argument-hint: <手机号> | --off | --status
---

# EasyCharles 管理员设置

管理员由部署目标机 `easy-charles.env` 里的 `EC_ADMIN` 决定（ADR-018：不落盘到服务端数据、不运行时授予，改配置必须重启服务生效）。本技能的脚本把「改配置 → 重启 → 验证」一次做完。

## 用法

先定位仓库根（脚本在 `<repo>/.qoder/skills/easy-charles-admin/scripts/`，仓库根是它的上三级）。

```bash
# 查询当前管理员（只读，不重启）
bash <skill>/scripts/set-admin.sh --status

# 设置管理员（支持多个，逗号分隔）
bash <skill>/scripts/set-admin.sh 13800138000
bash <skill>/scripts/set-admin.sh 13800138000,13900139000

# 取消所有管理员
bash <skill>/scripts/set-admin.sh --off
```

脚本从 gitignored 的 `scripts/deploy.conf` 读 `EC_DEPLOY_TARGET`（ssh 目标）。没有该文件或连不上目标时会明确报错——此时告诉用户先跑 `bash scripts/deploy.sh check` 确认部署通道，不要猜目标机。

## 行为说明

- **会重启远端服务**：`安装后台服务.command` 重装 launchd job 并做健康检查，抓包中的设备会瞬断重连。设置/取消前如果用户没意识到这点，提一句。
- **配置随部署继承**：脚本只改当前在跑版本目录的 `easy-charles.env`；后续部署会从该目录继承配置，改动不会丢。
- **验证口径**：重启完成后脚本用远端 env 里的 `EC_PASSWORD` 登录 API，检查返回的 `user.role` 是否符合预期（`admin` / 非 `admin`），并把结果原样打印。验证失败 ≠ 设置失败，可能是启动慢，先看 `bash scripts/deploy.sh logs`。
- 手机号只是登录名，格式宽松校验（数字+逗号）；写错的号最多是「登录不出 admin」，不会破坏服务。
- 本地开发实例（`npm start` 起的）不归本技能管：直接在启动命令里改 `--admin` 重启即可。
