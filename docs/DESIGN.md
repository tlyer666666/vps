# VPSWatch 设计文档(v1.2)

自托管的多 VPS 监控与日常管理系统:轻量探针 + 集中面板。参考 [Nezha](https://github.com/nezhahq/nezha)、[Beszel](https://github.com/henrygd/beszel)、[Komari](https://github.com/komari-monitor/komari)、[ServerStatus](https://github.com/cppla/ServerStatus) 的设计取舍。

## 1. 架构

```
Agent (bash)  ──HTTP POST /api/agent/report (Bearer token)──▶  Hub (Node.js ≥22.13)
读 /proc,10s 上报                                              node:http + node:sqlite,零 npm 依赖
                                                                    ├─ 校验/入库(WAL)
                                                                    ├─ 告警引擎 + Webhook/Telegram
                                                                    └─ SPA 面板(原生 JS)+ SSE 实时推送 + 公开状态页
```

推模型:agent 主动上报,穿透 NAT;“在线”定义为最近上报在 `max(3×interval, 60s)` 内。全链路零第三方依赖(服务端仅 Node 内置模块,agent 仅 bash+curl,前端无外部资源)。

## 2. 数据模型(SQLite,单文件,自动迁移旧库)

| 表 | 用途 |
|---|---|
| servers | 名称/标签/分组/服务商/地区/月费/到期日/备注/月流量配额/上报间隔 + token 哈希 |
| metrics | 逐次采样:CPU/内存/swap/磁盘/负载/网络计数与速率/日·月流量/TCP/进程/uptime;索引 (server_id, ts) |
| probes / probe_results | 拨测任务定义与延迟结果(降采样查询) |
| events | 告警事件(open→resolve 生命周期) |
| sessions / settings | 会话与持久化设置(阈值、Webhook、Telegram、公开开关等) |

## 3. 接口

- `POST /api/agent/report`(Bearer token,限速,64KB 上限,严格校验:数值范围、根盘、hostname 白名单;非法即 400 丢弃)
- 面板:`GET /api/overview`(含 24h 在线率)、`/api/servers/:id/history?range=1h..30d`(超 400 点 SQL 分桶)、`/api/events`、`GET /api/stream`(SSE,2s 节流)
- 管理:服务器/拨测 CRUD、`/api/admin/settings`(校验+热生效)、`/api/admin/notify-test`、改密码(销毁全部会话)
- 公开:`GET /api/public/overview`(`public_status` 开关控制,脱敏+45s 缓存+5 req/s 限速)

## 4. 告警

离线(超窗未上报)、CPU/内存(连续 N 次超标)、磁盘/拨测(单样本)、月流量超额、临近到期;事件带冷却(默认 10 分钟,到期 24h)防轰炸,经 Webhook 与 Telegram 并行分发,分发器永不抛出。

## 5. Agent(bash)

`/proc/stat`(差分算 CPU%)、`meminfo`(MemAvailable 回退)、`loadavg`、`net/dev`(非 lo 求和)、`net/tcp{,6}`(ESTABLISHED)、进程计数、`df -kP`;流量日账本存本地 `/var/lib/vpswatch/state`(跨重启累计、跨日清零、计数器回退记 0);token 经 `curl -K -` stdin 配置传递,不暴露在进程命令行;所有内核路径/命令可环境变量覆盖(fixture 驱动测试)。

## 6. 安全

scrypt 管理员密码(改密即销毁全部会话);agent token 仅存 sha256、常数时间比较、一键重置;会话 Cookie HttpOnly/SameSite=Lax(HTTPS 自动 Secure)+ 登录失败限速;变更接口 Origin 校验(CSRF 纵深);静态服务路径穿越防护;systemd 沙箱(NoNewPrivileges/ProtectSystem/私有 tmp 等)。

## 7. 部署

`scripts/install-server.sh`(拷贝程序树+package.json、预创建数据目录、node ≥22.13 与 ProtectHome 预检、hub.env、systemd 单元、升级时 restart);agent 一行命令安装(Hub 自身下发安装脚本与 agent,管道安全);`uninstall-agent.sh` / `uninstall-server.sh [--purge-data]`。

## 8. 测试

- `scripts/test.sh`:node --test 单测、agent fixture 测试(假 /proc/假 curl/假 date)、安装脚本测试
- `scripts/integration-test.sh`:15 个端到端场景(上报→概览→SSE→告警+Webhook→离线→重启持久化→公开页→拨测→保留清理)
- `scripts/soak-test.sh`:高频多 agent + 抖动拨测 + 匿名压测的稳定性浸泡,断言存活/内存有界/无未处理拒绝
