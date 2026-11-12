# bionilux fork — 文档索引

本仓库是 [theonuverse/bionilux](https://github.com/theonuverse/bionilux) 的 fork，
用作 **dsh-mobile-apk** 的内置组件：为 DSH Mobile 提供一个**完全独立于 dsh 的 Node.js 运行时**
的 Debian Linux 容器运行时。

> 一句话：不让 Agent 跑在 Linux 容器里，而是让 Agent 能**按需使用**一个 Linux 环境。

## 文档地图

| 文档 | 作用 | 稳定性 |
|------|------|--------|
| [CONTEXT.md](CONTEXT.md) | 领域模型：术语、边界、不变量 | 长期 |
| [GOALS.md](GOALS.md) | 项目目标、范围、明确不做的事、验收门槛 | 长期 |
| [STATUS.md](STATUS.md) | 当前执行状态：已完成 / 未解决 / 验证记录 | **每次提交更新** |
| [PLAN.md](PLAN.md) | 分阶段实施计划与决策点 | 中期 |
| [ROOTFS.md](ROOTFS.md) | rootfs 路径语义层设计（本 fork 的核心） | 中期 |
| [HARDCODING.md](HARDCODING.md) | 运行契约：环境变量、CLI、健康检查、安装流程 | 长期 |
| [DECISIONS.md](DECISIONS.md) | 决策记录与理由（追加式） | 追加式 |
| [PERF.md](PERF.md) | 实测性能数据与分解 | 数据更新 |
| [UPSTREAM.md](UPSTREAM.md) | fork 基点、patch 清单、上游同步流程 | 中期 |
| [adr/0001-independent-mobile-linux-runtime.md](adr/0001-independent-mobile-linux-runtime.md) | 独立发布、共享 glibc Node 与默认禁用边界 | 长期 |
| [RELEASES.md](RELEASES.md) | 发布物清单、清单格式、完整性校验与更新策略 | 长期 |

## 本 fork 与上游的边界

**本 fork 负责：**

- 去掉所有硬编码的 Termux 包名/路径，改为可配置的环境契约。
- 实现 Debian rootfs 的**路径语义层**（绝对路径、相对路径、`*at()` dirfd、符号链接）。
- 让 guest `PATH` / cwd / exec 链完全走 rootfs，不落回 Termux。
- 提供可被消费方应用（acp-agent-ui）作为子进程调用的稳定 CLI + 环境变量契约。

**本 fork 不负责（属于 dsh-mobile-apk 侧）：**

- 与 dsh-mobile-apk 的完整链接、内嵌、打包、发布。
- Cordis 插件本体、`linux_bash` 工具的注册与 Guard 权限模型。
- rootfs 下载/校验/安装的 UI。
- PTY 会话管理器（host 回归与 Android PTY 验收应分别记录，不推断设备兼容性）。

**本 fork 现在额外提供（发布资产）：**

- `.github/workflows/release.yml` + [RELEASES.md](RELEASES.md)：版本化 Release 资产与清单，不使用 Git LFS。
- `linux-release.json`：双 ABI 的 backend / rootfs / Node 资产清单，由消费方（acp-agent-ui 的 Rust 安装器）读取。

> 原 DSH/Cordis 插件层（`packages/linux-bootstrap`、`packages/linux-runtime`）已移除：
> 安装、校验、解包与执行统一由消费方应用承担，避免两套安装器规则漂移。

## 快速开始

```bash
# 本机（Linux/macOS）跑单元测试，不需要 Android
cargo test
cargo clippy --all-targets -- -D warnings

# 设备上运行
export BIONILUX_ROOTFS=/path/to/debian-minimal-rootfs
sh scripts/prepare-rootfs.sh --rootfs "$BIONILUX_ROOTFS" --verify
bionilux /bin/bash -c 'echo $PATH; pwd'
```

全部可配置项见 [HARDCODING.md](HARDCODING.md)。
