# 安全策略

## 支持版本

| 版本 | 支持 |
| --- | --- |
| 最新 main 分支 | ✅ |
| 更早的 tag / 提交 | ❌ |

## 报告漏洞

请**不要**通过公开 Issue 报告安全漏洞。使用 GitHub 的
[Private vulnerability reporting](https://github.com/tlyer666666/vps/security/advisories/new)
私密报告,或通过仓库所有者的个人页面联系方式联系。

我们会在 72 小时内确认收到,并在修复发布前与你同步时间表。

## 已知的安全设计

- 管理员密码 scrypt 加盐哈希;修改密码会立即注销全部会话
- Agent token 仅存 SHA-256,常数时间比较,支持一键重置
- 所有管理变更需会话 Cookie + Origin 校验;登录/上报/公开页各自限速
- systemd 部署单元默认带沙箱(NoNewPrivileges、ProtectSystem 等)

## 自查建议

- 生产环境务必置于 TLS 反代之后(探针 token 在 HTTP 下明文传输)
- 定期升级:升级 = 重跑 `scripts/install-server.sh`(数据目录不动)
