# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循 [SemVer](https://semver.org/)。

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added
- 多 VPS 监控:CPU / 内存 / 磁盘 / 网络 / 负载 / TCP / 进程 / 运行时长,10 秒级上报,SSE 实时推送
- 历史曲线(1h–30d 自动降采样)与 24h 在线率统计
- 告警引擎:离线、CPU/内存/磁盘阈值、到期提醒、月流量超额、拨测失败;Webhook 与 Telegram 通知,冷却防轰炸
- HTTP/TCP 拨测任务,公开状态页 `/status`(可开关、脱敏、限速缓存)
- 日常管理:服务商 / 分组 / 到期日倒计时 / 月费 / 月流量配额 / 备注,跨重启的日·月流量账本
- 面板:暗色 / 浅色 / 午夜蓝主题、自定义壁纸、移动端适配
- 部署:服务端/探针一键安装脚本(systemd 沙箱单元)、旧库自动迁移、Docker 镜像
- 安全:scrypt 密码、token 哈希与一键重置、登录/上报/公开页限速、Origin 校验、WAL 持久化
- 测试:单元 + fixture 驱动 agent 用例 + 15 场景端到端集成 + 稳定性浸泡
