# VPSWatch

自托管的多 VPS 监控管理系统,轻量探针 + 集中面板。除了监控,还记录每台 VPS 的日常信息:服务商、到期日、价格、标签、备注、日/月流量。零 npm 依赖,服务端单目录即部署,探针只要 bash + curl。

参考项目:[Nezha 哪吒](https://github.com/nezhahq/nezha)(告警思路)、[Beszel](https://github.com/henrygd/beszel)(卡片式面板)、[Komari](https://github.com/komari-monitor/komari)(轻量探针)、[ServerStatus](https://github.com/cppla/ServerStatus)(bash 轻客户端)。与它们相比,VPSWatch 补上了"日常管理"这一块:到期倒计时提醒、月费记录、跨重启的每日流量账本。

## 功能

- 监控:CPU / 内存(含 swap)/ 磁盘 / 网络速率与累计流量 / 负载 / TCP 连接数 / 进程数 / 运行时长;10 秒级上报,SSE 实时刷新;历史区间 1h / 6h / 24h / 7d / 30d(自动降采样)。
- 日常管理:每台服务器的服务商、地区、标签、月价格、到期日(≤7 天黄色提醒、过期红色)、备注;今日/本月上下行流量记录在 VPS 本地状态文件,探针和面板重启后依然准确。
- 告警:离线、CPU / 内存 / 磁盘超阈值、临近到期、月流量超额、拨测连续失败;事件入库(触发/恢复),支持通用 Webhook 与 Telegram,每规则有冷却,面板里可一键发送测试通知。
- 拨测与状态页:HTTP / TCP 拨测任务由 Hub 周期探测,延迟历史入图表,连续失败告警;首次启动自动种入常用拨测点,管理页可一键补齐。公开状态页 `/status` 免登录,显示服务器在线状态、24h 在线率和拨测延迟曲线,自动脱敏并内置限速与缓存。
- 外观:暗色 / 浅色 / 午夜蓝三主题 + 壁纸(内置渐变或自定义 URL,毛玻璃卡片),偏好保存在浏览器本地。
- 安全:scrypt 管理员密码 + HttpOnly 会话 Cookie;探针 per-server token(库存哈希、常数时间比较、可一键重置);登录失败限速、上报端点限速。

## 快速开始

要求:服务端 Node.js ≥ 22.13(仅内置模块,无需 `npm install`);探针任意 Linux(需 bash、curl)。

### 1. 安装服务端(在监控机上,仓库根目录)

```sh
sudo scripts/install-server.sh --port 3577
# 输出会打印一次性的管理员密码,立即保存
```

或者手动运行:

```sh
node server/main.js                # 默认 0.0.0.0:3577,数据在 ./data/
```

### 2. 添加服务器并安装探针

浏览器打开 `http://HOST:3577` 登录 →「添加服务器」→ 面板直接给出可复制的命令,在被监控的 VPS 上执行:

```sh
curl -fsSL http://HUB:3577/install-agent.sh | bash -s -- --server http://HUB:3577 --token <TOKEN>
```

有 systemd 会自动注册 `vpswatch-agent.service` 并开机自启(服务带 systemd 沙箱加固),没有则用 nohup 后备;`--user <用户>` 支持非 root 运行;卸载用 `scripts/uninstall-agent.sh`。探针上报以 Bearer token 鉴权,公网直连时 token 明文传输,生产环境务必走 TLS 反代。

### 3. 生产环境建议

用 Nginx/Caddy 反代加 TLS,Caddy 两行示例:

```
watch.example.com {
    reverse_proxy 127.0.0.1:3577
}
```

## 配置

优先级:CLI 参数 > 环境变量(`VPSWATCH_*`)> `config.json` > 默认值。

| 项 | 默认 | 说明 |
|---|---|---|
| `--port` / `VPSWATCH_PORT` | 3577 | 监听端口 |
| `--host` / `VPSWATCH_HOST` | 0.0.0.0 | 监听地址 |
| `--data-dir` / `--db-path` | ./data | SQLite 数据目录/文件 |
| `--retention-days` | 30 | 原始指标保留天数(每 6 小时清理一次) |
| `--session-ttl-days` / `VPSWATCH_SESSION_TTL_DAYS` | 7 | 管理会话有效期 |
| `--interval` | 10 | 默认上报间隔(秒,可在面板按服务器覆盖) |
| `--admin-password` | 随机生成 | 首次启动的管理员密码 |
| `--trust-proxy` / `VPSWATCH_TRUST_PROXY` | false | 置于 Nginx/Caddy 反代后时设为 true:限速按 X-Forwarded-For 最后一跳取客户端 IP,并自动为会话 Cookie 加 Secure |
| 面板「系统设置」 | — | 告警阈值、通知冷却、Webhook、保留天数(持久化,热生效) |

## 流量账本口径

每日/每月流量由探针按网卡累计计数器差分记账,状态存 `/var/lib/vpswatch/state`,跨日自动清零。计数器回退(通常是重启)时该周期记 0,不会产生天文数字;重启期间的流量不计。探针停采一段时间再恢复时,停采期间的流量会整体计入恢复后的第一个样本。服务端重启不影响账本。

## 备份与升级

数据库是 WAL 模式的 SQLite,对应 `vpswatch.db`、`vpswatch.db-wal`、`vpswatch.db-shm` 三个文件。备份请先停止服务,或三个文件一起拷贝;运行中只拷主文件可能得到损坏副本。升级重跑 `scripts/install-server.sh` 会整体替换程序目录,数据目录不动。

## 开发与测试

```sh
scripts/test.sh                  # node 单测 + agent 测试 + 安装脚本测试
scripts/integration-test.sh      # 端到端:真实 hub + fixture 探针(约 2 分钟)
node server/main.js --port 3577  # 本地起面板
```

架构、数据模型、接口、告警、安全与部署细节见 `docs/DESIGN.md`。

## 明确不做

Web 终端/SSH、定时任务、DDNS、Docker 容器统计、多用户与 RBAC、ICMP 拨测、邮件通知、Docker 镜像分发。
