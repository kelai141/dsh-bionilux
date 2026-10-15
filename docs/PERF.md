# PERF — 实测性能

本文件只记录**实测**数据。没有实测的推断一律标注为推断，不作为结论。

## 1. 测量条件

| 项 | 值 |
|---|---|
| 机器 | WSL2 Ubuntu (x86_64)，宿主 Windows |
| 内核 | 6.18.33.2-microsoft-standard-WSL2 |
| bionilux | 本仓库 release 构建（`--release`），完整链路：launcher + loader + preload + guest |
| PRoot | Ubuntu 发行版包 `proot`（默认，未额外调优） |
| rootfs | 同一份 Debian 13 (trixie) minimal（`debootstrap --variant=minbase`），已用 `scripts/prepare-rootfs.sh` 处理 |
| 命令 | 两个后端跑**完全相同**的 guest 命令 |
| 环境 | 两侧都用同一份 `env -i`（PATH/HOME/TMPDIR/TERM/LANG），避免 host 环境差异污染结果 |
| 采样 | 每例 1 次预热丢弃 + 5 次采样，报**中位数**与**极差** |
| 复现 | `tests/bench.sh --launcher ... --rootfs ... --runs 5` |

> 数据来自 WSL2，不是手机。Android 上的绝对数字会不同；比值受 CPU、内核、文件系统影响。
> 本机 x86_64 是原生执行；被测的 Android 模拟器走 native bridge，**不能**用于性能结论。

## 2. 结果（中位数）

| 用例 | bionilux | PRoot | 比值 |
|---|---|---|---|
| cold_start（`/bin/true`） | 11 ms | 78 ms | 7.1x |
| shell_start（bash 启动） | 7 ms | 95 ms | 13.6x |
| spawn_1（启动一个外部程序） | 10 ms | 126 ms | 12.6x |
| spawn_20（连续 20 个） | 81 ms | 459 ms | 5.7x |
| open_200_inproc（同进程 200 次 open） | 13 ms | 439 ms | 33.8x |
| stat_200_inproc（同进程 200 次 stat） | 11 ms | 104 ms | 9.5x |
| relative_200_inproc（相对路径） | 10 ms | 105 ms | 10.5x |
| dotdot_100_inproc（含 `..` 的遍历） | 9 ms | 79 ms | 8.8x |
| pipe_pipeline（管道） | 10 ms | 83 ms | 8.3x |

## 3. 分解后的单次成本（更有意义）

由 `spawn_1` 与 `spawn_20` 的差、`open_200_inproc` 与 `shell_start` 的差反推：

| 指标 | bionilux | PRoot | 比值 |
|---|---|---|---|
| **每多一次进程创建** | **3.74 ms** | 17.53 ms | 4.7x |
| **每次 open（同进程内）** | **0.030 ms** | 1.720 ms | 57x |

## 4. 关键结论

1. **路径语义本身几乎不花钱。** 同进程内每次 open 约 0.03 ms。这是因为映射只是一次字符串前缀拼接，
   没有 ptrace 往返。PRoot 的 1.72 ms 基本就是每 syscall 一次的 ptrace 代价。

2. **进程创建才是主要开销。** bionilux 每次 spawn 约 3.7 ms。原因是当前设计里，guest 每次 exec 都会
   **再起一次 launcher 进程**（hook → `execve(bionilux)` → launcher 重新读 ELF → 再 exec loader）。
   也就是说一个 guest 子进程 = 2 次 exec + 一次完整动态链接。

3. **什么样的负载受益最大。**
   - 路径密集、进程少（读配置、解析文件、包管理内部）：收益最大，且 bionilux 侧开销可忽略。
   - 进程密集（构建系统大量 fork/exec）：仍然快 4–5 倍，但绝对值上 3.7 ms/次 会累积 ——
     10,000 次 exec ≈ 37 s（PRoot 约 175 s）。**这是 bionilux 侧最值得优化的点。**

4. **方差更小。** PRoot 的极差可达中位数的 44%（spawn_20：200/459 ms），bionilux 约 17%。
   对交互式 Agent 场景，可预测性本身有价值。

## 5. 已知的优化空间（尚未实施）

- **父进程内直接 reroute**：preload 已经具备映射层，也有 rootfs；它可以自己读 ELF 判定架构、
  定位 rootfs 内的 loader、直接 `execve(loader, ...)`，从而**完全跳过一次 launcher 进程**。
  预计能把 3.7 ms 的 spawn 成本显著压低。风险是改动所有 exec 路径，必须先有回归测试兜底
  （`tests/acceptance.sh` 全绿 + 真机 A/B 全绿）再开。
- **`openat2(RESOLVE_IN_ROOT)`**：见 [DECISIONS.md](DECISIONS.md) D-003。可让内核直接做 rootfs
  内解析，省掉用户态映射，但需要设备内核支持。

## 6. 不做的结论

- ❌ 不把本机数字当作 Android 性能结论。
- ❌ 不使用"只挂少量 hook 的微基准"作为完整运行时性能（那是上游报告已指出的陷阱）。
- ❌ 不在兼容性未通过前用性能理由把 bionilux 设为默认后端。
