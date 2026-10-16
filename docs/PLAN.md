# PLAN — 分阶段实施计划

状态标记：✅ 完成且有验证证据 ／ 🟡 部分完成 ／ ⬜ 未开始
每个阶段结束时更新 [STATUS.md](STATUS.md)，决策追加到 [DECISIONS.md](DECISIONS.md)。

## 阶段 0 — Fork 基线固化 ✅

- [x] 固定上游基点 `26b5a0b`，保留 MIT 许可与版权（见 UPSTREAM.md）
- [x] 建立文档体系（本目录）
- [x] 记录 patch 清单，便于日后 rebase

## 阶段 1 — 去除 Termux 硬编码 ✅

- [x] `src/launcher/config.rs`：所有前缀/路径/架构从环境变量与 CLI 解析
- [x] `src/` 内不再出现 `com.termux` 字面量
- [x] `resolve.rs`：宿主 `PATH` 搜索改为 guest `PATH` 搜索；`which` 依赖移除
- [x] `env.rs`：CA 证书路径不再写死；宿主环境泄漏剥离
- [x] `hooks.c`：glibc 前缀不再写死
- [x] `setup`：支持非 Termux 安装根
- [x] **真机反证**：实际目标前缀是 `com.dsharnessmobile.shell`（非 `com.termux`），配置化后正常工作

## 阶段 2 — rootfs 路径语义层 ✅

- [x] `src/launcher/rootfs.rs`：单一映射规则（`physical`/`map_existing`/`unmap`/`passthrough`/`search`）
- [x] launcher 侧：目标解析、loader 查找、shebang 解释器全部走 rootfs
- [x] preload 侧：约 55 个入口统一走同一规则
- [x] `..` 在 guest 根截断，且相对路径按 guest cwd 逻辑解析（修复逃逸）
- [x] cwd 维护：`getcwd` 反映射、`chdir` 映射
- [x] 删除上游 `/etc/*` 特例，并入统一规则
- [x] 绝对符号链接：评估后判定**不能在运行时修**，改为安装期处理（D-006）

## 阶段 3 — 执行链与 guest 环境 ✅

- [x] `env.rs`：Debian 标准 guest 环境
- [x] shebang：`env -S` 与 `VAR=VAL`；解释器走 guest `PATH`
- [x] `exec.rs`：`--library-path` 按次传递（D-008）
- [x] preload：`execveat` 相对 dirfd 加固
- [x] CLI 修复：命令后的参数原样转发（`-n` 不再被吞）

## 阶段 4 — 设备验证 🟡（已有 ARM64 记录，非全设备覆盖）

- [x] 阶段 A 在 **x86_64 Android 15 真机**通过（23/23）
- [x] 阶段 B 在真机通过（16/16）
- [x] ARM64 设备记录 DNS、HTTPS 和 APT 成功；早期 x86_64 DNS 阻塞为历史记录（STATUS.md §9）
- [x] aarch64 真机验证记录：vivo V2425A（STATUS.md §9–10）
- [ ] 集成方按目标设备重跑干净 rootfs 的阶段 A–C，不假设必须使用 DNS 转发

## 阶段 5 — 工具链与性能 🟡

- [x] 端到端性能对比（`tests/bench.sh`），结果见 [PERF.md](PERF.md)
- [ ] 阶段 D 工具链场景（Git / CMake / Go / Rust）**未验证**
- [ ] 「父进程内 reroute」优化，压低 3.74 ms/次 的 spawn 成本

## 阶段 6 — 与 DSH 的接口冻结 🟡

- [x] 冻结 CLI 与环境变量清单（见 [HARDCODING.md](HARDCODING.md)）
- [x] 冻结健康检查约定（`--print-config` 的 `ROOTFS_ENABLED` / `ROOTFS_LOADER`）
- [ ] PTY 下的行为未单独验证

## 阶段 7 — 外部插件与独立发布 🟡

- [x] 引导插件 `packages/linux-bootstrap`：清单发现/校验、安装事务、更新策略（包级测试通过）
- [x] 运行时插件 `packages/linux-runtime`：安装/健康检查/卸载、`linux_bash`、共享 glibc Node
- [x] 独立发布流水线 `.github/workflows/release.yml` + 清单双校验（见 [RELEASES.md](RELEASES.md)）
- [x] LFS/二进制守卫进入 CI 与发布流程
- [ ] Android 宿主适配器（`linuxPluginHost`）与真机端到端安装验收（集成方）
- [ ] x86_64 构建与验证

## 决策点

| # | 决策点 | 触发条件 | 结论 |
|---|--------|----------|------|
| DP-1 | 是否继续独立维护 fork | 阶段 A/C 需要大量 syscall 特例 | **未触发**：A/B 与 C 的包管理机制已通过（D-004） |
| DP-2 | 是否采用 `openat2(RESOLVE_IN_ROOT)` | 内核支持且行为正确 | **暂缓**（D-003） |
| DP-3 | 默认后端是 PRoot 还是 bionilux | 阶段 A–D 通过且性能收益可重复 | **待定**：A–C 已通过，D 未做；性能收益已实测（PERF.md） |
