# GOALS — 目标与范围

## 1. 一句话目标

把一个具备标准包管理生态、可由 Agent 自主维护的 **Debian Minimal Linux 用户空间**，
以**低集成成本**接入 Android 原生 DSH Mobile，且不改变 Harness 自身的运行方式。

## 2. 本 fork 的验收目标（Definition of Done）

按依赖顺序，前置未完成则后继不算通过。

| # | 目标 | 通过条件 |
|---|------|----------|
| G1 | **无 Termux 硬编码** | 仓库内 `grep -rn "com.termux" src/` 只允许出现在默认值常量与文档；运行时全部可被环境变量覆盖 |
| G2 | **rootfs 路径语义层** | 绝对路径、相对路径、`*at()` dirfd、符号链接按 guest `/` 解析；不存在时按 guest 语义失败，不落回 host |
| G3 | **guest 环境** | `PATH`/`HOME`/`PWD`/`TMPDIR`/`LD_LIBRARY_PATH` 全部由 rootfs 与配置推导，不继承 Termux 值 |
| G4 | **执行链完整** | shell 脚本、`env -S`、`execve`/`execvp`/`execveat`/`fexecve`/`posix_spawn*` 的多层子进程都在 guest 内 |
| G5 | **Debian 最小环境可用** | 干净 rootfs 可完成 `apt update` + 通过 APT 安装/运行/删除包 |
| G6 | **cwd 正确** | guest 内 `pwd` / `getcwd()` 返回 guest 逻辑路径，不是 host 物理路径 |
| G7 | **可被 DSH 插件调用** | 单一稳定 CLI + 环境契约；stdout/stderr/退出码/超时语义明确（PTY 下亦然） |

## 3. 明确不做的事

- ❌ 把 DSH Core、Cordis 或 Node.js 迁移到 Debian。
- ❌ 修改原有 Agent 执行架构。
- ❌ 强制用户安装 Linux。
- ❌ 预装大规模开发工具链（GCC/Python）；Debian rootfs 不携带 Node.js。按需安装的 glibc Node 作为应用级共享工具包单独发布，由多个 rootfs 复用。
- ❌ 维护独立的 Linux 软件仓库。
- ❌ 要求 Root。
- ❌ 混用 Bionic 与 glibc 的编译链。
- ❌ 以跨架构模拟为目标。
- ❌ 为 Linux 重新发明工具注入和权限系统。
- ❌ 以完整 Linux 桌面或系统服务为目标。
- ❌ 本仓库不承担与 dsh-mobile-apk 的完整链接与内嵌。

## 4. 验收阶段门槛（对齐上游分析报告）

| 阶段 | 必测项目 | 通过条件 |
|------|----------|----------|
| A：路径基础 | guest pwd/PATH/`command -v`；绝对/相对路径；cwd 与 dirfd；`openat`/`stat`/符号链接/`..`/`readlink`/目录增删 | 与 PRoot 一致；不存在时按 guest 语义失败；`/etc`、`/usr/share`、`/var` 都不落到宿主同名路径 |
| B：执行链 | shell 脚本、`env -S`、`execve`、`execvp`、`execveat`、`fexecve`、`posix_spawn*`、多层子进程 | 子进程仍在 guest 内；参数、cwd、环境、输出、信号、退出码符合预期 |
| C：Debian 最小环境 | `apt update`；APT 安装/运行/删除；dpkg 解包/配置/触发器/维护脚本；DNS/HTTPS | 干净 rootfs 可完成包管理；宿主路径与用户数据未被误写 |
| D：工具链场景 | Git HTTPS clone；CMake+Ninja；Go module；Rust Cargo | 每项都在 guest 内完成；产物路径与 PRoot 对照一致；工具经 APT 安装，不进基础镜像 |
| E：目标设备 | ARM64 Termux 真机；x86_64 真机 | 逐架构通过 A–D；未覆盖的设备/内核列为**未支持**，不推断兼容 |
| F：性能与数据 | 冷启动、重复启动、进程创建、路径密集操作、APT 安装、构建耗时 | 同设备同输入下报告中位数与离散度 |

> **go/no-go**：若阶段 A 或 C 必须转向完整 syscall 仿真才能通过，
> 应把 PRoot 保持为默认后端，bionilux 仅作为受限可选后端（见 DECISIONS.md D-004）。

## 5. 当前状态

见 [STATUS.md](STATUS.md)。本文件只描述"要达成什么"，不描述"做到哪了"。
