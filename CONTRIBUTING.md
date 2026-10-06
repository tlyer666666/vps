# 贡献指南

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/),并带**作用域(scope)**:

```
<type>(<scope>): <简短描述>

[可选正文]
```

| type | 用途 |
| --- | --- |
| feat | 新功能 |
| fix | 缺陷修复 |
| perf | 性能优化 |
| refactor | 重构(不改变行为) |
| docs | 文档 |
| test | 测试补充/调整 |
| chore | 构建、脚本、依赖等杂项 |
| ci | CI 配置 |

scope 取值:`hub`(服务端)、`agent`(探针)、`web`(面板)、`install`(安装脚本)、`docs`、`tests`、`ci`。
示例:

```
feat(hub): 拨测任务支持自定义超时
fix(agent): 修复 net/dev 统计遗漏 vlan 子接口
```

- 一个提交只做一件事;正文说明**为什么**(代码已经说明了是什么)。
- 提交前:`bash scripts/test.sh` 必须全绿。
- 行为变更请同步补测试(服务端 node --test,agent 用 fixture 用例)。

## 开发环境

- Node.js ≥ 22.13(仅内置模块,无 npm install)
- 本地运行:`node server/main.js`
- 测试:`bash scripts/test.sh`;端到端:`bash scripts/integration-test.sh`;稳定性:`bash scripts/soak-test.sh`

## 版本与发布

- 版本号遵循 [SemVer](https://semver.org/),以 `vX.Y.Z` tag 触发发布
- 变更记录维护在 [CHANGELOG.md](CHANGELOG.md)(Keep a Changelog 格式)
