# VPSWatch 与主流同类开源项目对比分析

> 数据采集日期:2026-10-03(GitHub API 实时数据)。对比对象:
> [Nezha/哪吒](https://github.com/nezhahq/nezha)(10.3k★)、[Beszel](https://github.com/henrygd/beszel)(26k★)、[Komari](https://github.com/komari-monitor/komari)(6.3k★)、[ServerStatus](https://github.com/cppla/ServerStatus)(4.7k★)。

## 1. 工程化与代码结构对比

| 维度 | Nezha | Beszel | Komari | ServerStatus | **VPSWatch(本仓库)** |
|---|---|---|---|---|---|
| 技术栈 | Go + Vue,agent↔hub 走 gRPC(proto) | Go + PocketBase + Svelte | Go + 前端内置 | Go 2.x + C++/Python 客户端 + jQuery 前端 | Node(内置模块) + bash agent + 原生 JS |
| 顶层结构 | `cmd/ service/ model/ pkg/ proto/ integration/` | `agent/ internal/` + 根入口 | `cmd/ internal/ pkg/ protocol/ web/` | `server/ clients/ web/ tests/` | `server/ agent/ scripts/ tests/ docs/` |
| Dockerfile / compose | ✅ / ✅ | ✅ / ✅(helm) | ✅ | ✅ / ✅ | ✅ / ✅(本批补齐) |
| 发布自动化 | goreleaser + tag | goreleaser + tag + 多注册表 | tag + 安装脚本 | 手工 | ✅ CI 构建(本批)/ 二进制打包待做 |
| CI | ✅ 多 workflow | ✅ | ✅ | ✅(playwright e2e) | ✅ test+integration+soak+docker(本批) |
| LICENSE | Apache-2.0 | MIT | MIT | MIT | ✅ MIT(本批) |
| SECURITY.md | ✅ | ✅ | ✅ | ❌ | ✅(本批) |
| CHANGELOG | ✅(自动) | ✅(自动) | ✅ | ❌ | ✅(本批,手工维护) |
| CONTRIBUTING | ✅ | ✅ | ❌ | ❌ | ✅(本批) |
| i18n | ✅ | ✅(i18n.yml,十几种语言) | ❌(中文界面) | ❌ | ❌ |
| e2e/UI 测试 | 部分集成 | hub 测试 + 前端构建校验 | ❌ | ✅ playwright | 无(有 API 集成 + soak) |

**结构性差异与评价**:

1. **agent↔hub 协议**:Nezha/Beszel/Komari 均为强类型协议(gRPC/protobuf 或自定义二进制),VPSWatch 用单端点 JSON。取舍:JSON+严格校验换来零依赖与可调试性,规模内(百台级)够用;若未来要 agent 下发指令(反向通道),需升级为长连接协议(见路线图)。
2. **构建产物**:三者都有 goreleaser 交叉编译 + Docker 多架构发布;VPSWatch 目前只有 Docker 与源码运行,缺多平台二进制与镜像自动发布。
3. **目录组织**:VPSWatch 的 `server/ agent/ web/ tests/ scripts/` 边界清晰、与三大项目同构;不足是服务端内部未再分层(可演进为 `server/{api,core}/`),当前规模尚可接受。
4. **零依赖是差异化优势**:同类均为 Go 多模块/前端工具链;VPSWatch 无 npm install、无编译,但也因此缺少 Go 生态的交叉编译便利(补齐 goreleaser 等价物或 Docker 多架构即可)。

## 2. 提交规范对比

| 项目 | 规范 |
|---|---|
| Nezha | Conventional Commits + **scope**(`fix(alerts):`),PR 合并,贡献者机器人 |
| Beszel | Conventional Commits + scope + **issue 编号**(`feat(agent): … (#2505)`),`release X.Y.Z` 提交 + 自动 CHANGELOG |
| Komari | 自由格式中文(`重写1下通知`),无规范 |
| ServerStatus | 混合(中英混杂,无规范) |
| VPSWatch | Conventional Commits,**无 scope、无 issue 引用**;历史经清理后全部合规 |

**差距与动作**:Nezha/Beszel 是标杆。VPSWatch 应:①提交带 scope(`fix(agent):`);②关联 issue(`(#123)`);③用 tag 触发 CHANGELOG 生成;④PR 模板 + issue 模板。本批已在 CONTRIBUTING.md 固化该规范并补齐 CHANGELOG。

## 3. 功能对比矩阵

| 功能 | Nezha | Beszel | Komari | ServerStatus | VPSWatch |
|---|---|---|---|---|---|
| 实时 CPU/内存/磁盘/网络 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 历史曲线 + 降采样 | ✅ | ✅ | ✅ | 部分 | ✅(1h–30d) |
| 在线率统计 | ✅ | ✅ | ✅ | ❌ | ✅(24h) |
| 拨测(HTTP/TCP) | ✅(服务监控) | ✅ | ✅ | ❌ | ✅ |
| 公开状态页 | ✅(主题) | ❌(登录制) | ✅ | ✅(即是) | ✅(可开关/脱敏) |
| 告警渠道 | 15+ 种 | 多种(含 webhook) | 数种 | ❌ | Webhook + Telegram |
| 到期日 / 月费 / 流量配额管理 | ✅ | 部分 | ✅ | ❌ | ✅(配额告警+账本) |
| Docker 容器统计 | ❌ | ✅ | ❌ | ❌ | ❌ → 路线图 |
| Web SSH / 远程命令 | ✅ | ❌ | ✅ | ❌ | ❌(YAGNI) |
| 定时任务 / DDNS | ✅ / ✅ | ❌ | ❌ | ❌ | ❌(YAGNI) |
| OIDC / 2FA / 多用户 | ✅ / ✅ / ✅ | OIDC / ❌ / 多用户 | ✅ / ❌ / ✅ | ❌ | ❌(单管理员) → 路线图 |
| 多语言 | ✅ | ✅ | 中文 | 中英 | 中文 → 路线图 |
| 主题 / 自定义背景 | ✅ 主题市场 | ❌ | ✅ | ❌ | ✅(3 主题+壁纸) |
| 备份 / 恢复 | ✅ | ✅ | ✅ | ❌ | ❌ → 路线图(P1) |
| Agent 自动更新 | ✅ | ✅ | ✅ | ❌ | ❌ → 路线图 |
| 部署门槛 | Docker/面板 | 单二进制 | 脚本 | 多组件 | **单命令,零依赖**(差异化) |

## 4. 界面与体验差异

1. **信息密度**:Nezha/Komari 默认主题为"表格+卡片混合、一行一台",扫视效率高;Beszel 为双栏+图表优先;VPSWatch 为纯卡片栅格——多台时纵向滚动较长。→ 改进:提供**紧凑表格视图**切换(记忆偏好)。
2. **图表交互**:Beszel 图表支持 hover 取值、时间范围拖动;VPSWatch 为静态 SVG 无 hover。→ 改进:SVG 上加 hover 读数与渐变填充(原生实现成本低)。
3. **移动端**:三者均适配;VPSWatch 已单列自适应但缺 PWA/桌面快捷方式。→ 改进:加 manifest + 基础 PWA。
4. **首次使用**:Beszel 加 agent 是"复制 docker 命令";Komari 是表单向导;VPSWatch 有一次性 token + 复制安装命令,已接近主流,可再加**安装命令分步向导**(选择发行版/systemd 有无)。
5. **排序/筛选**:Komari 记住排序(ServerStatus 也有"记住排序");VPSWatch 排序存内存不持久。→ 改进:排序/分组筛选持久化到 localStorage。

## 5. 优化与改进方案

### P0 · 规范性(本批已落地 ✅)
- ✅ LICENSE(MIT)、SECURITY.md、CONTRIBUTING.md(scope 规范)、CHANGELOG.md
- ✅ GitHub Actions CI(test / integration / soak / docker-on-tag)
- ✅ Dockerfile + docker-compose.yml + .dockerignore
- ✅ 语义化版本:tag `v0.1.0`,后续发版同步 CHANGELOG

### P1 · 体验与运维(建议下一批)
1. **表格视图切换** + 排序/筛选持久化(localStorage)——多机管理核心体验
2. **图表 hover 读数** + 渐变填充(纯 SVG 可实现)
3. **配置备份/恢复**:管理页导出/导入 `servers+settings+probes` JSON(对齐三者标配)
4. **i18n 脚手架**:抽离界面字符串为 `web/i18n/{zh-CN,en}.js`,语言随浏览器
5. **PWA manifest** + 安装到主屏
6. **PR/Issue 模板** + release 自动生成 CHANGELOG(GitHub release job)
7. goreleaser 等价:CI 产出 Linux amd64/arm64 单文件包(tar+systemd unit),替代"必须 Docker"

### P2 · 功能向(按需排期)
1. Docker 容器统计(agent 读 docker.sock,feature flag)
2. 传感器/温度(Beszel 有,读 `/sys/class/thermal`,低优先)
3. 多管理员 + 只读访客账户(状态页已具雏形)
4. TOTP 两步验证
5. agent 自动更新命令与协议版本握手
6. 若引入反向通道需求(Web SSH/远程命令),评估 WebSocket 协议升级;否则维持 SSE

### 明确保持的差异化(不向主流看齐的部分)
零 npm 依赖、bash 探针、单 SQLite 文件、流量日账本与到期/配额管理——这是 VPSWatch 区别于四个对标项目的核心价值,前两者请在改动时始终守护。
