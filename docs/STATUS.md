# STATUS — 执行状态

> 本文件随每次提交更新。只写**有证据**的事，没验证的明确标注。

最后更新基线：本轮工作结束时的工作区状态。

## 1. 总体

| 目标 | 状态 | 证据 |
|---|---|---|
| G1 无 Termux 硬编码 | ✅ | `src/` 内无 `com.termux` 字面量；全部经环境变量/CLI 解析。真机实测前缀为 `files/usr`（非 `com.termux`）仍正常工作 |
| G2 rootfs 路径语义层 | ✅ | `tests/preload_paths.sh` 46 断言全过；`tests/acceptance.sh` 阶段 A 全过 |
| G3 guest 环境 | ✅ | 阶段 A：`PATH`/`HOME`/`TMPDIR`/`PWD` 全部为 Debian 值 |
| G4 执行链完整 | ✅ | 阶段 B 全过（16 例，含 `env -S`、深链、`grep -n` 参数透传） |
| G5 Debian 最小环境可用 | 🟡 | **Linux 主机**：全过（真 `apt update` + `install`/`run`/`remove` + `dpkg`）。**Android 真机**：包管理机制通过，但 guest **DNS 不可用**，网络相关用例被如实标记为 skipped |
| G6 cwd 正确 | ✅ | `getcwd` 返回 guest 逻辑路径；`cd / && cd ..` 被截断在 `/` |
| G7 可被 DSH 插件调用 | 🟡 | CLI 与环境契约已冻结（见 HARDCODING.md）；`--print-config` 提供健康检查输出。PTY 下的行为未单独验证 |

## 2. 已完成的实现

- `src/launcher/config.rs`：配置解析（前缀/rootfs/runtime/box64/preload/loader/guest PATH/HOME/TMP/cwd/fake-root/lenient/架构）
- `src/launcher/rootfs.rs`：单一映射规则（`map_existing`/`physical`/`unmap`/`passthrough`/`search`）
- `src/launcher/resolve.rs`：目标解析、guest PATH 搜索、loader 定位（loader 必须来自 rootfs）、同架构原生分支、shebang/`env -S`/`VAR=VAL`
- `src/launcher/env.rs`：guest 环境生成、host 泄漏剥离、`--print-config` 健康检查
- `src/launcher/exec.rs`：以 `--library-path` 传物理库路径，不污染 `LD_LIBRARY_PATH`
- `src/main.rs`：CLI（`--rootfs`/`--guest-cwd`/`--guest-path`/`--print-config`），修复 `-n` 参数被吞
- `src/preload/hooks.c`：约 55 个 libc 入口 + 映射层 + 虚拟身份 + `mkstemp` + `_FORTIFY_SOURCE` 变体
- `scripts/prepare-rootfs.sh`：绝对符号链接重写 + `resolv.conf` + 必要目录，带 `--verify`/`--dry-run`
- `tests/preload_paths.sh`、`tests/acceptance.sh`、`tests/bench.sh`

## 3. 本轮发现并修复的真实缺陷

每条都有复现证据，不是推测。

| 缺陷 | 证据 | 状态 |
|---|---|---|
| 相对 `..` 逃出 rootfs，读到 rootfs 外的 host 文件 | `cat ../escape-target` 打印了 host 内容 | ✅ 已修（`bn_resolve` 按 guest cwd 逻辑解析并截断） |
| `bionilux prog -n` 的 `-n` 被 launcher 自己吞掉 | `echo -n x` 变成换行；`grep -n` 会坏（上游潜在缺陷） | ✅ 已修（改成单一 trailing 位置参数） |
| 缺 `statx`/`fchmodat` hook，coreutils 绕过映射 | `ls`/`chmod` 报 ENOENT | ✅ 已修 |
| glibc `mkstemp` 走内部 `openat`，不可拦截 | apt 缓存被写到 host `/var/cache/apt` | ✅ 已修（自行实现 mkstemp 系列） |
| apt 报 "Could not switch group" | strace 显示无凭据 syscall，是 apt 事后校验 `getgid()` 失败 | ✅ 已修（虚拟身份：`setgid` 后 `getgid` 如实回报） |
| rootfs 内 49 个绝对符号链接泄漏到 host | `/etc/localtime` 读到 host 内容（HOST-ZONE） | ✅ 已修（`prepare-rootfs.sh`）；真机从 49 → 0 |
| `apt-get update` 在 DNS 失败时仍返回 0 | apt 把索引下载失败当 warning | ✅ 测试已改为断言失败标记，不再假通过 |

## 4. 未解决 / 已知限制

### 4.1 guest DNS 在 Android 上不可用（阻塞 G5 的真机部分）

- **现象**：guest 内 `getent hosts deb.debian.org` 失败；`apt-get update` 报
  `Temporary failure resolving`（但返回 0）。
- **已排除**：不是 rootfs 权限问题（`dpkg --audit` 通过）；不是 nsswitch 配置问题（`hosts: files dns`）。
  设备自身 DNS 为 `198.18.0.2, 116.228.111.118, 180.168.255.18`，从 guest 内全部不可达。
- **推断原因**（未在设备侧证实到 syscall 级别）：Android 不提供 `/etc/resolv.conf`，
  且不允许应用直接使用裸 DNS；解析必须经 netd 的 DNS 代理，而 glibc 的 resolver 不会说这个协议。
- **需要 DSH 插件补**（不属于本仓库范围）：在 Android 侧提供一个 loopback DNS 转发
  （用 Bionic 的 `getaddrinfo` 解析，回填 guest 的 UDP 查询），guest 的 `/etc/resolv.conf`
  指向 `127.0.0.1`。`prepare-rootfs.sh --dns` 已为这条路径留好接口。

### 4.2 LD_PRELOAD 的覆盖边界（设计取舍）

覆盖应用经 PLT 调用的 libc 入口（含 `_FORTIFY_SOURCE` 的 `__*_chk`）。**不覆盖**：
静态二进制、直接 syscall、secure-exec（setuid）。这些场景 PRoot 可用而 bionilux 不可用。
详见 [ROOTFS.md](ROOTFS.md) §7。

### 4.3 其他

- `/dev` 整体直通 host（`/dev/shm` 除外），未做虚拟化。
- `execveat(dirfd, relative)` 已加固，但 `..` 逃逸防护对**符号链接**无效（链接目标由内核解析）。
- 无 PTY 专项验证；本仓库不实现会话管理。
- 真机 `uname -m` 返回 `aarch64` 而用户态 ABI 是 `x86_64`（该模拟器有 native bridge）。
  guest 内读 `uname -m` 会看到 `aarch64`，**可能误导 guest 的构建脚本**。需在插件侧处理。

## 5. 验证记录（可复现）

| 套件 | 环境 | 结果 |
|---|---|---|
| `cargo test` | WSL Linux | 32 passed |
| `cargo clippy --all-targets -D warnings` | WSL Linux | 通过 |
| `tests/preload_paths.sh` | WSL Linux | 46/46（含 fortify 构建一致性） |
| `tests/acceptance.sh` 全阶段 | WSL Linux | 46/46（含真 `apt update`/`install`/`remove`） |
| `tests/acceptance.sh` 阶段 A | **Android 15 真机 x86_64** | 23/23 |
| `tests/acceptance.sh` 阶段 B | **Android 15 真机 x86_64** | 16/16 |
| `tests/acceptance.sh` 阶段 C | **Android 15 真机 x86_64** | `c01` 失败（DNS），`c06` 通过，网络用例 skipped |
| `tests/acceptance.sh` vs PRoot | WSL Linux | bionilux 22/22+16/16；PRoot 21/22+15/16 |
| `tests/bench.sh` | WSL Linux | 见 [PERF.md](PERF.md) |

## 6. 下一步

1. 插件侧 DNS 转发落地后，重跑真机阶段 C 的网络用例。
2. aarch64 真机验证（本仓库只验证过 x86_64 设备）。
3. 「父进程内 reroute」优化（见 PERF.md §5），先把 spawn 成本压下来。
4. 与上游同步：见 [UPSTREAM.md](UPSTREAM.md)。
