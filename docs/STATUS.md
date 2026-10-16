# STATUS — 执行状态

> 本文件随每次提交更新。只写**有证据**的事，没验证的明确标注。

记录说明：第 1–6 节保留早期 x86_64 验证历史，不作为当前 ARM64 阻塞清单。
当前已记录的 ARM64 设备结果与 GNU make 修正见第 9–10 节；本次 host 回归不新增设备兼容性结论。

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


## 7. LD_PRELOAD 的可达性边界（arm64 真机，2026-10）

**结论**：LD_PRELOAD 只能拦截**公开的、跨 PLT 的**函数。glibc 自己内部的调用
（`__open`、`__stat`、`__opendir`、`__execve`、`__mkstemp`……）不经过 PLT，任何预载都
拦不到；`GLIBC_PRIVATE` 符号更是被 glibc 主动拒绝外部满足（已用 `tests/helpers/privprobe.c`
证伪，见 D-010）。

**后果**：凡是 libc「自己」去读某个路径的地方，都会落到**宿主机**上。实测确认的每一类，
都在程序真正调用的公开 API 上补回来：

| libc 内部绕过 | 通过哪个公开 API 补回 |
|---|---|
| `/etc/resolv.conf`、`/etc/hosts` | `getaddrinfo`、`gethostbyname*`（用 guest 的配置自己发 DNS） |
| `/etc/passwd`、`/etc/group` | `getpwnam*`、`getpwuid*`、`getgrnam*`、`getgrgid*` |
| `system`/`popen` 用的 `/bin/sh` | `system`、`popen`、`pclose` |
| `mkstemp` 内部的 `open` | `mkstemp`/`mkostemp`/`mkstemps`/`mkostemps` 及其 `64` 拼写 |
| `dlopen` 绝对路径 | `dlopen`（语言运行时的扩展模块、PAM、NSS 插件） |
| `readlink("/proc/self/fd/N")` | 内部用物理路径，对外呈现 guest 路径 |

**最隐蔽的一个**：`readlinkat` 把 `/proc/self/fd/N` 的结果改写成 guest 路径后，
`bn_dir_base()` 会拿它当**物理**路径用，`bn_unmap()` 匹配不上就回落成 `/`，于是每一次
`..` 都被钳到 guest 根目录。症状是 `find` 在 966 个条目里只走 46 个就报
`fts_read failed: No such file or directory`，`rm -rf` 深目录直接失败。
strace 看不出来——它只显示 syscall 的返回值，而改写发生在用户态。
排查工具：`tests/helpers/ftsprobe.c`。

## 8. Android 平台限制（运行时内不可修复）

| 现象 | 根因 | 规避 |
|---|---|---|
| 创建硬链接一律 `EPERM` | 设备策略（连 App 自己的私有目录也一样） | `link`/`linkat` 回退为复制；dpkg 依赖此 |
| `mkfifo()` 返回 `EACCES` | SELinux | 默认 FIFO 受限；改用 `--jobserver-style=pipe`，见 §10.2 |
| `ldconfig` 写入只读的 `/etc` | 它是**静态链接**的，预载无法介入 | 脚本不安装 shim；集成方需显式处理依赖 ldconfig 的配置步骤 |
| 静态链接的程序完全不生效 | 无 `PT_INTERP`/无 `NEEDED` | 无法规避 |

## 9. 本轮 arm64 真机验证（vivo V2425A，Android 16 / SDK 36，SELinux enforcing）

| 项目 | 结果 |
|---|---|
| Debian rootfs | Debian 13 trixie，glibc 2.41，`HOST_ARCH=Aarch64` |
| DNS | `getent hosts deb.debian.org` → `146.75.114.132` |
| TLS 信任链 | `curl https://github.com` → `200`，不需要 `GIT_SSL_NO_VERIFY` |
| 包管理 | `apt-get update` 拉取 9.7 MB；`build-essential`、`git`、`ca-certificates`、`strace` 安装成功 |
| 工具链 | gcc 14.2.0、git 2.47.3、make 4.4.1 |
| 版本控制 | `git clone` / `status` / `log` 全新克隆通过（依赖 `mkstemp64` 与身份一致性两处修复） |
| 遍历 | `find` 走完 guest 的 `/etc`(557)、`/usr`(1655)、`/var`(916) 与克隆仓库(966) |
| Android 公有目录 | guest 写 `/sdcard/bn-visible.txt`，宿主可读 |
| Android 私有目录 | 以 App uid 运行、runtime 装在 `files/` 下时，guest 用**原生路径**读写该目录 |
| `cargo test` | 34 passed（WSL Linux） |
| `cargo fmt --check` / `cargo clippy` | 通过 |

**历史问题（已由 §10.1 更正）**：kernel（如 KernelSU 模块）级别的 `make` 递归构建。当配方或 `$(shell ...)`
里没有 shell 元字符时，GNU make 会**自己** exec 而不经过 `/bin/sh`；实测这条路径绕过了预载
（`BIONILUX_DEBUG=1` 下看不到对应的 `map:` 行），因此子 make 报
`make: /usr/bin/make: No such file or directory`。简单 Makefile 与所有走 shell 的命令不受影响。
这是下一步的头号问题。
## 10. 修正与补充（第二轮 arm64 真机验证）

### 10.1 GNU make 的直接执行路径已修复（`eaccess`）

之前记为"内核递归构建时 make 直接 exec 绕过预载"，根因找到了：GNU make 用
`eaccess()` 判断配方命令是否可执行，而 glibc 的 `euidaccess`/`eaccess` 是**用户态实现**
（不能用 `access(2)` 系统调用，那个测的是真实 uid），于是**自己内部 `stat()`** 路径。
这个内部调用绕过预载 → 落到宿主机 → `ENOENT` → make 直接报错并**放弃，不 fork**。

证据：strace 显示失败配方里**没有 clone/fork/execve**，而是恰好一次
`newfstatat(AT_FDCWD, "/usr/bin/make", ...) = -1 ENOENT`（未映射的 guest 路径）。
走 shell 的配方不受影响，所以只有直接执行路径坏——递归构建正是死在这里。

修复：钩 `eaccess`/`euidaccess` 做路径映射。修好后 make 直接执行路径恢复正常。
同时按符号扫描补齐：`execvpe`、`remove`、`lchmod`、`statfs64`、`scandir64`、`scandirat`、
`posix_spawn_file_actions_addopen`/`_addchdir_np`。扫描工具留在
`tests/helpers/unhooked-symbols.sh`。

### 10.2 并行 make 是可以的（此前结论有误）

第 8 节曾说 `mkfifo` 被 SELinux 拒绝、所以并行构建只能 `-j1`。**这是错的**：
GNU make 的 jobserver 还支持管道模式，`make -jN --jobserver-style=pipe` 完全可用，
已在 `-j8` 下验证（`Waiting for unfinished jobs` 说明确实并行）。先前只用了默认的
FIFO 模式才失败。

### 10.3 新 rootfs 必须先跑 `prepare-rootfs.sh`

重建 rootfs 后漏跑了这一步，症状是 `awk`、`which` 找不到：Debian rootfs 里是**绝对符号
链接**（`/usr/bin/awk -> /etc/alternatives/awk`），内核会拿它去**宿主机根**解析。
脚本把它们改写成 rootfs 绝对路径（本次改写 32 个链接，且可重复执行）。
注意它必须从**宿主侧**跑并传 `--rootfs <物理路径>`；在 guest 内部跑会扫错树。
（脚本由 .gitattributes 固定为 LF；推送到设备前仍应确认传输未转换行尾。）

### 10.4 内核模块构建（KernelSU）——环境已证明可用，剩两个上游问题

在 guest 里对 KernelSU（`tiann/KernelSU`，commit `200818c`）做了完整尝试：

| 阶段 | 结果 |
|---|---|
| `git clone` 源码 | 通过 |
| `apt` 装 `build-essential`/`git`/`linux-headers-arm64`/`strace` | 通过 |
| `apt` 装 `linux-source-6.12`（145 MB）并解包 | 通过 |
| `make defconfig` / `make modules_prepare -j8 --jobserver-style=pipe` | 通过 |
| 用真源码树编 KernelSU 模块 | 编过 12+ 个 `.o`（`core/init.o`、`feature/*`、`hook/*`、`hook/arm64/*`），随后失败 |

**剩下两个都不是运行时的问题**：

1. `infra/file_wrapper.c` 要 `security/selinux/include/objsec.h`，而它又 `#include "flask.h"`
   —— `flask.h` 是**构建时生成**的文件（由 `security/selinux` 子系统生成），所以需要一个
   已经构建过的内核树，不只是 `modules_prepare`。
2. `hook/syscall_hook_manager.c` 用的 `register_trace_sys_enter` 与新内核（6.12）的
   tracepoint 签名不兼容 —— 这是 KernelSU 与内核版本的源码兼容问题。

结论：容器能跑完整的内核构建流程（配置、prepare、并行编译、Kbuild 递归），
`.ko` 未产出是内核树/上游兼容性所致，与 bionilux 无关。
---

## 11. 外部 Linux 环境系统（插件、发布、更新）

本节记录本轮新增的**两个实验性内部插件**与独立发布链，只写有测试证据的部分。

### 11.1 交付物

| 组件 | 位置 | 状态 |
|------|------|------|
| 引导插件 | `packages/linux-bootstrap` | ✅ 包级测试通过（14 项） |
| 运行时插件 | `packages/linux-runtime` | ✅ 包级测试通过（16 项） |
| 发布流水线 | `.github/workflows/release.yml` | ✅ YAML 合法；本地复现清单双校验通过 |
| 清单双校验 | runtime + bootstrap 两个校验器 | ✅ 同一 canonical 清单两侧均接受 |
| LFS/二进制守卫 | `ci.yml` 与 `release.yml` | ✅ 本地运行通过（无跟踪二进制、无 LFS 指针） |
| 文档 | `docs/RELEASES.md`、两包 README、ADR-0001、D-013 | ✅ |

### 11.2 已验证行为（`node --test`）

* 引导插件：手动检查只报告不安装；`install/reinstall` 必须 `confirmed:true` 且 `activate:true`；
  自动更新默认关闭；仅在“已安装 + 仍被注入 + 开关开启 + 应用版本变化”时检查，且每个应用版本最多一次；
  用户手工移除插件后**永不复活**（持久化 `injectionActivated:false`，自动更新失败关闭）；
  摘要不符时在宿主激活前拒绝；路线处理器写操作要求 `confirmed:true`。
* 运行时管理器：安装先暂存后健康检查再原子切换，失败保留旧的 active 实例；
  共享 Node 以 `nodeAsset.sha256` 为键，同一 Node 归档在系统升级时**不重复下载**，
  不同归档各装一份；切换前中止在途命令、切换期间新命令排队；卸载只删自身实例与无引用 Node，
  保留用户工作区；guest 环境不继承宿主 `PREFIX`/`TERMUX_*`/`LD_*`/Node 变量且无静默回退；
  cwd 在 rootfs 内映射为 guest 路径、相对路径被拒。
* 本地修正的真实缺陷（均有失败用例→通过证据）：`rename` 覆盖已存在文件在 Windows 上 EPERM；
  `require('node:fs')` 在 ESM 中不可用；共享 Node 清理只删 `<key>/<arch>` 残留空壳目录；
  运行清单误把 `manifest.version` 钉死为插件包版本；`_resolveCwd` 只接受 POSIX 拼写。

### 11.3 未验证 / 已知缺口（不得当作已完成）

* **真机端到端安装未验收**：Android 宿主的 `linuxPluginHost.isInjected` 实现、注入目录布局、
  安全解包器与 DNS 转发均为集成方职责，本轮只在包级以注入 IO 验证。
* 只发布 arm64；x86_64 未构建、未验证。
* `linux_bash` 工具面（`defineTool` 注册）未在有 `@deepseek-ai/dsh-tools` 的宿主中实跑。
* PTY/长会话未验证。
* Debian rootfs 由 `debootstrap` 从主镜像构建，未固定镜像快照哈希。
