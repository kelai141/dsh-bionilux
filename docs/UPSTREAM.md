# UPSTREAM — fork 基点与同步

## 1. fork 身份

| 项 | 值 |
|---|---|
| 上游 | `theonuverse/bionilux` |
| fork 基点 | `26b5a0b673fd1e01c868b2e2a53787bb3a25e907`（`Aktualisieren von README.md`，即 v0.4.2 之后一次 README 提交） |
| 上游版本 | v0.4.2 |
| 许可 | MIT（保留 `LICENSE` 全文与版权声明） |
| 本 fork 定位 | dsh-mobile-apk 的 Linux Runtime 后端；不承担与 DSH 的完整链接与内嵌 |

> 上游 `v0.4.2` 标签解析到 `d95af50`，其上还有 `26b5a0b`。本 fork 以 **`26b5a0b`** 为基点。

## 2. 本 fork 的改动范围（patch 清单）

按文件列出，便于日后 rebase 上游。

| 文件 | 改动性质 |
|---|---|
| `src/launcher/config.rs` | **新增**。全部路径/前缀/架构配置化 |
| `src/launcher/rootfs.rs` | **新增**。统一映射层 |
| `src/launcher/resolve.rs` | **重写**。去 `which`、guest PATH 搜索、loader 限 rootfs、同架构原生分支、`env -S` 的 `VAR=VAL` |
| `src/launcher/env.rs` | **重写**。guest 环境、泄漏剥离、`--print-config`、按次 `--library-path` |
| `src/launcher/exec.rs` | 改。`ExecSpec` + `--library-path` |
| `src/launcher/mod.rs` | 改。注册新模块 |
| `src/main.rs` | 重写。CLI 扩展、单一 trailing 位置参数（修 `-n` 被吞） |
| `src/preload/hooks.c` | **大幅扩展**。映射层、约 55 个入口、虚拟身份、`mkstemp`、`__*_chk` |
| `setup` | 改。去 Termux 硬编码，支持非 Termux 安装根 |
| `tests/smoke.sh` | 保留。上游端到端脚本，仍适用于 Termux 场景 |
| `tests/preload_paths.sh` | **新增**。hook 路径语义测试（无需设备） |
| `tests/acceptance.sh` | **新增**。阶段 A/B/C 验收 + PRoot 差分 + adb 传输 |
| `tests/bench.sh` | **新增**。端到端性能对比 |
| `scripts/prepare-rootfs.sh` | **新增**。rootfs 安装期处理 |
| `docs/**` | **新增**。本套文档 |
| `.gitattributes` | **新增**。强制脚本/源码 LF（CI 在 Linux 上跑） |

上游保持不变的对外行为（在未配置 `BIONILUX_ROOTFS` 时）**必须保持**：这是回归底线。

## 3. 兼容性约定

1. **不设 `BIONILUX_ROOTFS` 时行为等同上游**：host 用户空间即 guest，`/bin` → `$PREFIX/bin` 的
   legacy 重写保留，`tests/smoke.sh` 仍应通过。
2. 上游的环境变量（`BIONILUX_DEBUG`/`BIONILUX_PRELOAD`/`BIONILUX_CHDIR_TO_BINARY`）全部保留语义。
3. 上游 CLI 用法 `bionilux <binary> [args...]` 不变；新增选项都要求出现在命令之前。
4. 上游 `--print-config` 不存在，是本 fork 新增的健康检查入口。

## 4. 同步上游的流程

```bash
git remote add upstream https://github.com/theonuverse/bionilux
git fetch upstream
git log --oneline upstream/main ^HEAD          # 看有哪些新提交
git rebase upstream/main                       # 冲突集中在上面 patch 清单里的文件
cargo test && cargo clippy --all-targets -- -D warnings
bash tests/preload_paths.sh                    # 无需设备
bash tests/acceptance.sh --launcher ... --rootfs ... --stage all
bash tests/bench.sh --launcher ... --rootfs ...     # 记录性能是否漂移
```

**rebase 后必须重跑**：`preload_paths.sh`（hook 层）、`acceptance.sh` 阶段 A（映射语义）、
阶段 B（exec 链）。这三者是本 fork 与上游分歧最大的地方，也最容易在 rebase 中被悄悄改坏。

## 5. 需要长期跟踪的上游风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| glibc 内部符号可见性变化 | 某些入口从可拦截变为不可拦截 | `preload_paths.sh` 覆盖 `_FORTIFY_SOURCE`；`runtime.sh` 补充 hosts/group 等 API 回归，不代表完整 NSS 覆盖 |
| 上游 `/etc` 特例逻辑变化 | 与本 fork 的统一映射层语义冲突 | 本 fork 已删除该特例；rebase 时不要重新引入 |
| box64 行为变化 | 跨架构路径回归 | 本 fork 的同架构分支不依赖 box64；x86_64 宿主上不受影响 |
