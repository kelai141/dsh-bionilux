# RISK — 历史稳定性风险清单（2026-11-11）

> 本文保留交接时的历史调查，**不代表 0.10.0 当前状态**。其中旧健康检查、旧二进制、16 KB 对齐以及 getifaddrs 释放协议等描述已被后续源码审查或验证修正。当前发布结论和未验证边界见 [移动端兼容条件](MOBILE_COMPATIBILITY.md)；不要把历史推断当作已确认漏洞或当前设备状态。

本文件只记录**有证据**的风险。证据分三类：
- **[实测]**：本轮在 emulator-5584（Android 15，x86_64 应用 ABI，SELinux Enforcing）上直接复现；
- **[源码]**：逐行读代码确认，未运行；
- **[文档]**：引用 Android 官方/AOSP 文档，未在本机复现。

复现命令见每节末尾。设备代号 `emulator-5584`（AVD `dsh-api29`）。

## TL;DR — 一句话结论

**当前设备上的 Linux 环境是坏的，但系统认为它健康。** 已安装的 backend 二进制比修复提交旧 4 天，
导致 guest 里只有 bash 内建命令能跑、**任何外部命令 100% 失败**，而
`manager.status().healthy === true`、`linux_bash` 照常注册。

这不是「还没做完」，而是**假通过已经发生并留在了设备上**——和 `docs/DECISIONS.md` D-009
记录过的 `apt-get update` 假通过是同一类问题，只是这次在更上层（健康检查本身）。

| 级别 | 数量 | 最关键的一条 |
|---|---|---|
| P0 | 2 | 资产比源码旧 + 健康检查从不真跑 → 装了也用不了 |
| P1 | 7 | 崩溃后无磁盘回收、Node 删除无保护、输出无上限、DNS 最坏阻塞数分钟、路径溢出静默回退 |
| P2 | 3 | 16 KB 页设备上二进制**加载不了**、Android 12+ phantom process 上限、SELinux 限制 |
| P3 | 15 | 见文末表格 |

---


## P0-1 已安装的 backend 资产比源码旧，健康检查仍然报 healthy（假通过）

**[实测]** 这是本轮发现的头号问题，且**已经在本机环境里发生**。

```
$ node -e "…new LinuxRuntimeManager({dataDir}).status()"
status healthy= true  instance= debian-minimal-x64-mw23vl6a-…

$ m.execute({command:'echo builtin-ok'})   → exit 0, "builtin-ok"
$ m.execute({command:'id -u'})             → exit 1, stderr: error: expected absolute path: "--argv0"
$ m.execute({command:'uname -m'})          → exit 1, 同上
$ m.execute({command:'ls / | head -3'})    → exit 1, 同上（两条）
```

即：**所有 bash 内建命令正常，所有外部命令 100% 失败**，而 `status().healthy === true`。

根因链：

1. 设备上的 `backend/bin/bionilux` 时间戳 `2026-11-04 10:24`，SHA-256
   `885a8713…8b798d`，与本仓 `target/independent-linux/assets/bionilux-backend-x86_64.tar.xz`
   内的二进制**逐字节相同**。
2. 修复提交 `f8a6031 fix(launcher): start guest ELF through the system linker on Android`
   的日期是 **2026-11-08**，比资产晚 4 天。也就是说：**资产里没有这个修复**。
3. 旧二进制没有 `launcher_identity()`（现行 `src/main.rs:175-194` 才引入），
   于是 `/proc/self/exe` 名字是 `linker64` 时把 `BIONILUX_BINARY_PATH` 导成了
   `/apex/com.android.runtime/bin/linker64`。**实测**：
   ```
   $ linker64 backend/bin/bionilux /bin/sh -c 'echo $BIONILUX_BINARY_PATH'
   /apex/com.android.runtime/bin/linker64      ← 应该是 …/backend/bin/bionilux
   $ backend/bin/bionilux /bin/sh -c 'echo $BIONILUX_BINARY_PATH'
   …/backend/bin/bionilux                      ← 直接 exec 时才对
   ```
4. preload 的子进程 reroute 因此把 "launcher" 认成了 Bionic linker：
   `run_rerouted()` 拼出 `[linker64, "--argv0", "/bin/sh", "--", "/usr/bin/id", …]`，
   Bionic linker 把 `--argv0` 当成要加载的程序名，报
   `error: expected absolute path: "--argv0"`（该字符串确认存在于 `/system/bin/linker64`）。
5. 手动把 `BIONILUX_BINARY_PATH` 改回真实路径后，症状**立刻变化**为
   `/bin/sh: 1: id: not found`——reroute 回到了 launcher，只是 guest PATH 没配置。
   这反证了根因。

**为什么健康检查没拦住**：`manager._healthForRecord()` 只检查「文件存在 + 可执行位 +
ELF e_machine + rootfs 必需文件存在 + loader 存在」，**一次都不执行**。它无法发现
「二进制与 rootfs/manifest 代际不匹配」这类问题，而这类问题恰恰是最常见的。

**后果**：插件注册 `linux_bash`、UI 显示「已安装/已启用/健康」，Agent 第一条真实命令就失败，
且失败信息（`expected absolute path: "--argv0"`）与真实原因毫无关系。

**修复（按优先级）**
1. **健康检查加一次真实冒烟执行**：`launcher /bin/sh -c 'exit 0'` 或 `/bin/true`，2–3 s 超时，
   结果短时缓存。失败即 unhealthy，并把 stderr 摘要带进 `reason`。这一条能直接消灭本类问题。
2. **建立资产-源码一致性门禁**：CI 里在打 release 资产时记录 `git describe --dirty` 与二进制
   SHA-256，运行时把二进制 SHA-256 与清单比对；不一致就拒绝激活（现在只比归档摘要，
   归档对得上，但归档本身是旧的）。
3. **发布前强制重建**：`bionilux`、`libbionilux_preload.so` 必须由当次提交重新编译，
   禁止复用更早构建产物（本轮就是因为复用了 11-04 的产物）。

**复现**：见本节命令；或 `scripts/start-independent-linux.ps1 -Serial emulator-5584`
（安装本身会成功，随后任何外部命令失败）。

**本轮未能验证的部分（必须说清）**：现行源码 `src/main.rs:175-194` 的 `launcher_identity()`
看起来正是为修这个问题而加的（它把 `argv[1]` 里那个 `bionilux` 路径当作要导出的身份）。
但**我无法在本机重新编译验证**：Windows 宿主缺 `link.exe`、bash、cc，
配了 `CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER` 后仍因 build script 需要 MSVC 链接器而失败；
而唯一能编译的独立 Debian 环境，正是被 P0-1 弄坏的那一个。
所以「新源码能修好」目前是**代码推断，不是实测结论**。下一步的验证顺序见文末。

---

## P0-2 全新安装会因为验收脚本的持久会话断言而失败（环境可用但被判失败）

**[实测]** `start-independent-linux.ps1` 在 emulator-5584 上以
`Linux installation failed: The input did not match the regular expression /reused:persisted/. Input: ''`
结束。同一会话在 `createRuntime` 里先跑
`export BN_ACCEPTANCE_VALUE=persisted; printf "opened:%s\n" "$PWD"`（exit 0），
再跑 `printf "reused:%s\n" "$BN_ACCEPTANCE_VALUE"` 得到 **空 stdout**。

在 P0-1 的背景下这不奇怪（外部命令全废），但它暴露一个设计问题：
**安装脚本把「验收套件通过」当成「安装成功」的判据**，两者不是一回事。安装成功、
健康检查通过，只要验收脚本某条断言失败，启动脚本就 throw，且**不回滚也不保留可用状态**，
下一次运行还会因为同一断言再次失败。

**修复**
1. 启动脚本区分 `install` 与 `acceptance`：安装成功即 `exit 0`，验收失败只告警并打印日志路径。
2. 验收断言失败时打印**该条断言的上游上下文**（stdout/stderr/exitCode），而不是只打印正则不匹配。

---

## P1-1 健康检查不是可用性证明（与 P0-1 同源，但影响面更广）

**[源码]** `packages/linux-runtime/modules/manager.js:872-953`。可放过的故障包括：
ld.so 缺依赖、preload `.so` 的 NEEDED 缺失、rootfs bash 损坏、backend 与 rootfs 代际不匹配、
install 后 DNS 失效、SELinux 拒绝 exec。`status().healthy` 为 true 会直接触发
`lib/index.js:356` 注册 `linux_bash`。

**修复**：同 P0-1 第 1 条。

## P1-2 进程被 kill 时没有启动期磁盘状态回收（孤儿实例 + 残留 staging）

**[源码]** `manager.js:1326-1405`。**进程内**的失败回滚是有的、而且写得不错：
`catch` 里对已 promote 的实例做 `removeTree(finalInstance)`（1395-1400），
`finally` 里 `removeTree(staging)`（1403）。

缺的是**跨进程**的部分：
- 进程被 `am force-stop`/`SIGKILL`/`OOM` 杀掉时，`finally` 不执行，
  `<dataDir>/.staging/<instanceId>/` 会留下解包了一半的 rootfs（数百 MB）。
- `fs.rename(stagedInstance, finalInstance)`（1375）之后、`_writeActive()`（1383）之前死亡
  → `instances/<id>/` 存在但 `active.json` 没写；该实例的 `metadata.json` 会把共享 Node
  钉住（`_nodeReferencedByAnyInstance` 认为仍被引用），Node 永远删不掉。
- `uninstall` 的 `.deleting/`（1421-1424）同理：`removeTree(tombstone)` 失败后没人再清。

本轮设备上 `data/staging/` 确实存在一个目录。

**修复**：构造/首次 install 时做一次 reconcile：扫 `.staging/*`、`instances/*`、`.deleting/*`，
对「不在 `active.json` 且无 in-flight journal 记录」的目录回收。
或写 in-flight journal，启动时按 journal 回滚。

## P1-3 共享 Node 删除无引用保护，且是 delete-then-download

**[源码]** `manager.js:1229-1244`：`_nodeIsHealthy` 只查 `bin/node` 与
`lib/node_modules/npm`；不健康就 `_stopChildren()` → `removeTree(node)` → 再下载（1233-1242）。
下载/解包失败时旧 Node 已删、`active.json` 仍指向它 → 已安装环境立刻不可用，
而 `status()` 仍报 healthy（因为健康检查不执行任何东西，见 P0-1）。

引用计数也有洞：`_removePreviousInstance()`（1278-1288）是**先 `removeTree(instance)`
再问** `_nodeReferencedByAnyInstance()`，旧实例已不在，答案必然是 false。

**修复**：引用计数（扫 `instances/*/metadata.json` + 内存活跃会话）；改为
下载到 `staging/node` 验证通过后 rename 覆盖，失败保留旧目录。

## P1-4 一次性 execute 的 guest 输出无上限 → 撑爆 harness 进程

**[源码]** `manager.js:499-504`：`child.stdout.on('data', c => stdout += c)`，无界字符串。
session 路径有 `appendBounded` 上限（1 MB），一次性路径没有。
在 `linux_bash` 跑 `apt`/`gradle`/编译时可能直接 OOM 掉整个 Node 进程（不是抛错，是进程死）。

**修复**：复用字节上限缓冲，输出 `stdoutTruncated` 标志。

## P1-5 单次 DNS 查询最坏可阻塞分钟级

**[源码]** `hooks.c:2449-2452`（`timeout` 上限 30 s、`attempts` 上限 5）、
`2715-2735`（attempts × server_count 循环）、`2742-2770`（search list 再乘一遍）。
最坏 = 5 × 4 台 × 30 s ≈ 600 s/名，再乘 search 域。文件头注释写的是「不能无限挂住」，
但实际界是分钟级。触发条件很现实：飞行模式、内网 DNS 全失效时 `apt`/`curl` 首次解析即卡死，
SIGINT 也打断不了（在 C 库里 poll 轮询）。

**修复**：给整次 `getaddrinfo` 一个总预算（10–15 s，`CLOCK_MONOTONIC` 贯穿 query 与
search），超出返回 `EAI_AGAIN`；`attempts` 上限压到 2。

## P1-6 路径映射溢出时静默回退到宿主路径（违反核心不变量）

**[源码]** `hooks.c:334-335`：`if (written <= 0 || written >= size) return path;`
——返回的是**未映射的 guest 路径**。当 `rootfs 前缀 + 深层路径` 超过 `PATH_MAX` 时，
`/etc/shadow` 这类绝对路径会落到宿主同名文件上，正是 `docs/CONTEXT.md` §3 承诺
「绝不发生」的失败模式，而且**静默**（成功返回、内容不同）。

**修复**：溢出时 `errno = ENAMETOOLONG` 让调用方失败，绝不返回未映射路径。

## P1-7 `getifaddrs` 回退实现与 glibc `freeifaddrs` 的释放协议可能不匹配（**上一轮的静态推断，本轮未能复现，暂缓**）

> **本轮结论**：这条来自静态审读，置信度 ~85%，但本轮**没有复现**——模拟器上 netlink 可用，
> 回退分支根本不会走。而且现有 `tests/helpers/netprobe.c` 只在 Linux 宿主跑过。
> 在拿到设备侧证据（反汇编 `freeifaddrs` 或 ≥2 网卡环境复现）之前，**不建议据此大改代码**。
> 下面保留原始分析供排查参考。


**[源码]** `hooks.c:2237-2287`：回退把整张链表放在一个 `calloc` 块里，
`arr[k-1].ifa.ifa_next = &e->ifa`。glibc 的 `freeifaddrs` 按节点 `free()`；
第 k≥1 个节点是块内指针，`free()` 会 abort。**未 hook `freeifaddrs`**（全仓无该符号）。
影响面：Android 上 netlink `RTM_GETLINK` 被 SELinux 拒，回退是**唯一**路径，
任何调用 `getifaddrs` 后正常 `freeifaddrs` 的程序（WebRTC/ICE、`ifconfig`、网络探测）
在多网卡时崩溃。模拟器 netlink 可用，所以现有测试覆盖不到。

**置信度**：~85%。确认方法：在目标 glibc 上反汇编 `freeifaddrs`，或用
`tests/helpers/netprobe.c` 在 ≥2 个 UP 网卡环境复现。

**修复**：每个节点单独 `malloc`；并同时 hook `freeifaddrs` 保证协议一致。

---

## P2 平台级（Android 侧，运行时改不了）

## P2-1 16 KB 页设备上本项目的二进制**加载不了**

**[实测]** 解析资产内 ELF 程序头：

```
bionilux              e_machine=0x3e  PT_LOAD aligns= 4096  ok16k=false
libbionilux_preload.so e_machine=0x3e  PT_LOAD aligns= 4096  ok16k=false
```

**[文档]** Google 自 2025-11-01 起要求面向 Android 15+ 的新应用与更新支持 16 KB 页；
16 KB 页设备上 `p_align < 16384` 的原生库无法加载
（https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html ）。
本项目两个二进制都是 4 KB 对齐。

**修复**：Rust 侧加 `-C link-arg=-Wl,-z,max-page-size=16384`（或 NDK r28 默认），
preload 的 C 编译同样加 `-Wl,-z,max-page-size=16384`；然后在 16 KB 页设备/镜像上实测。
**未在 16 KB 设备上验证过**，这属于「发布前必须补的一项」。

## P2-2 Android 12+ 的 phantom process 限制会杀 `make -j` 一类负载

**[文档]** AOSP 自 Android 12 起对 app fork 出的子进程设有上限（默认 32），超限被杀并留下
`signal 9`。多阶段并行构建（`make -j8`、CMake+Ninja、cargo）很容易触碰。
参考 AOSP `PhantomProcessList` 与 agnostic-apollo/Android-Docs 的整理。

**缓解**：工具侧限制并发、对 `signal 9` 给出可读诊断（而不是「命令神秘消失」）；
文档里写明这是设备级限制，需要用户侧处理（开发者选项里的「停用子进程限制」等）。

## P2-3 SELinux/平台限制（已在 `docs/STATUS.md` §8 记录，此处只列影响）

| 现象 | 影响 | 现有规避 |
|---|---|---|
| 硬链接一律 `EPERM` | dpkg 依赖 link | 回退为复制（inode 语义不同） |
| `mkfifo` `EACCES` | make jobserver 默认 FIFO 不可用 | manager 设 `MAKEFLAGS=--jobserver-style=pipe` |
| 静态链接程序预载完全无效 | `ldconfig`、静态 Go/Rust 产物 | 无法规避；`ldconfig` 用 dpkg diversion |
| 应用私有目录不可 execve | 启动链必须过 `linker64` | `launchArgv()`（但 P0-1 说明这条链曾断） |

---

## P3 值得排期但不会立刻炸

| # | 问题 | 位置 | 证据 |
|---|---|---|---|
| P3-1 | session 超时关闭丢弃全部已产生输出 | `session.js:676-697` 直接 `stdout: ''` | [源码] |
| P3-2 | session 排队无上限、close 后逐个失败且报错语义丢失 | `session.js:653-654` | [源码] |
| P3-3 | `_jobsInternal` 失败分支泄漏；`_pruneJobs` off-by-one 会多删刚完成的 job | `session.js:794-798, 823-827` | [源码] |
| P3-4 | uninstall 时 `removeTree` 失败留下 tombstone 但 active 已删 | `manager.js:1421-1424` | [源码] |
| P3-5 | 并发 install 只有进程内 gate，跨进程无锁 | `manager.js:77-99`（注释自认不覆盖 Worker/独立进程） | [源码] |
| P3-6 | `--argv0` 要求 glibc ≥ 2.33，老 rootfs 的 loader 会直接退出 | `exec.rs:46-62` | [源码]。本机 Debian 13 支持（实测 `--help` 有该选项） |
| P3-7 | shebang 脚本 `argv[1]` 泄漏宿主物理路径 | `resolve.rs:516` | [源码] |
| P3-8 | `/etc/passwd`、`/etc/group` 单次 read、不处理 EINTR/短读，16 KB 缓冲 | `hooks.c:2379-2398` | [源码] |
| P3-9 | `bn_copy_file` 64 KB 栈帧 + `bn_resolve` 每次 ~20 KB 栈 | `hooks.c:1583, 402-432` | [源码]。小栈线程里可能溢出 |
| P3-10 | `popen` 的 fd 注册表在 `fclose()` 后不清理 | `hooks.c:3157-3160` | [源码] |
| P3-11 | 无 nameserver 时对任何名字返回 `EAI_AGAIN`（而非 `EAI_NONAME`） | `hooks.c:2848-2849, 2891` | [源码]。会诱发指数退避重试 |
| P3-12 | `env.rs` 的 `bn_context` 缺 `BIONILUX_NATIVE_LIB_DIR`，最小环境子进程会丢 | `hooks.c:83-95` vs `env.rs:170-179` | [源码] |
| P3-13 | `execve(p, av, NULL)` 时仍注入 BIONILUX 配置变量，破坏空环境语义 | `hooks.c:470, 511-521` | [源码] |
| P3-14 | `dlsym` 初始化失败时汇编兜底会 `jmp *NULL` | `hooks.c:1131-1154` | [源码]。进程 SIGSEGV 且无诊断 |
| P3-15 | `measureUnpackedBytes` 死代码；runtime 侧 install 不校验 unpackedSize | `manager.js:691-710` | [源码] |

---

## 建议的修复排序（按「让系统稳定跑起来」的收益）

1. **健康检查加真实冒烟 + 资产/源码一致性门禁**（P0-1、P1-1）。这两条能把「装上了但用不了」
   变成「装不上并说清原因」，是所有后续工作的前提。
2. **重出 backend 资产**：用当前源码重编 `bionilux` 与 `preload.so`，确认
   `BIONILUX_BINARY_PATH` 在 `linker64` 下正确指向 launcher，再跑一遍
   `echo/id/uname/ls` 四连。**这是当前环境从「不可用」回到「可用」的最小动作。**
3. **启动脚本把 install 与 acceptance 分开**（P0-2）。
4. **磁盘状态回收**（P1-2、P1-3）：崩溃后能自愈，否则用户会反复踩残留目录。
5. **输出上限 + DNS 总预算**（P1-4、P1-5）：消灭「卡死」和「OOM 掉引擎」两类最难排查的故障。
6. **路径溢出 fail-closed**（P1-6）：这是正确性底线，改动很小。
7. **16 KB 页对齐 + 16 KB 设备实测**（P2-1）：发布硬门槛。
8. **getifaddrs 释放协议**（P1-7）：先反汇编确认，再决定是否本轮修。

---

## 下一步的验证顺序（建议照此执行，避免又踩「假通过」）

1. 在**能编译的环境**里重编 `bionilux` 与 `libbionilux_preload.so`（首选修好后的独立 Debian
   环境；也可用 WSL 等其它 Linux 宿主，只要 Rust 的 NDK 交叉编译链可用）。
2. 静态确认：`linker64 <new bionilux> /bin/sh -c 'echo $BIONILUX_BINARY_PATH'`
   必须输出 launcher 自己的路径。
3. 动态确认四连（这是最小可用性判据，任何一条失败就不算装好）：
   `echo hi` / `id -u`（应为 0）/ `uname -m` / `ls /`。
4. 用新二进制重出 `bionilux-backend-x86_64.tar.xz`，更新清单里的 `sha256`/`size`/
   `unpackedSize`，重跑 `start-independent-linux.ps1`。
5. 把第 3 步的四连**加进健康检查**（P0-1 修复项 1），否则同类问题还会以别的形式复发。
6. 再补 16 KB 页对齐并找一台 16 KB 页设备/镜像实测（P2-1）。

## 本轮验证记录

| 项 | 结果 |
|---|---|
| `node --test packages/linux-runtime/test/*.test.mjs` | 88 passed / 0 failed / 16 skipped（5 类 `# SKIP` 均为 POSIX/进程域条件项） |
| `start-independent-linux.ps1 -Serial emulator-5584` | 安装与激活成功，随后被 P0-2 断言判为失败 |
| `manager.status()` | `healthy=true`，但外部命令 100% 失败（P0-1） |
| `bionilux --print-config` 直跑 | 正常；`ROOTFS_ENABLED=1` 时 `/bin/sh -c 'echo hello; id -u'` 在**直接 exec** 下成功，在 **linker64 启动**下失败 |
| 资产 ELF 对齐 | `p_align=4096`，不符合 16 KB 页要求 |
| 交叉编译（Windows 宿主） | 失败：无 `link.exe`/无 bash/cc；设了 NDK linker 后仍在 build script 阶段要 MSVC。**必须走独立 Linux 环境**，而该环境当前正是坏的 |
