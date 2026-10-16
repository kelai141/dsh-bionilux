# DECISIONS — 决策记录

追加式。每条写清：决策、理由、被否掉的方案。

---

## D-001 缺失的 guest 路径一律按 guest 语义失败，不回退宿主

**决策**：配置了 rootfs 时，`/x` 只解析为 `<rootfs>/x`。不存在就是不存在，绝不回退到宿主的 `/x`。
`BIONILUX_LENIENT=1` 可临时恢复回退行为，仅供差分调试。

**理由**：回退是**静默的错误答案**——比报错更危险。上游对 `/etc/*` 的处理就是"目标存在才改写"，
落到 guest 上会让 `/usr/share`、`/var` 悄悄读到宿主文件。实测中 `/etc/localtime` 因此
读到了宿主内容。

**否掉**：与上游一致的"存在才映射"（会泄漏宿主）；彻底改为拒绝 rootfs 模式（等于放弃目标）。

---

## D-002 只做 libc 层拦截，不做 syscall 仿真

**决策**：保持 LD_PRELOAD 路线，覆盖应用经 PLT 调用的入口（含 `_FORTIFY_SOURCE` 的 `__*_chk`）。
静态二进制、直接 syscall、secure-exec 不在覆盖范围内，明确记录为限制。

**理由**：ptrace/syscall 仿真的维护成本是 PRoot 已经在付的代价（见 PERF.md：每 syscall 约 1.7 ms）。
本 fork 的价值恰恰是"不付这笔钱"。而且实测发现，**glibc 内部调用并非全都不可拦截**——
NSS 模块是独立 DSO，它调 libc 走 PLT，所以 `getent`/`apt` 的用户名解析能被正确映射。

**否掉**：自建 syscall 仿真（重复 PRoot）；放宽要求假装覆盖完整（会误导集成方）。

**补充**：真正不可拦截的是 libc **自身内部**的调用（locale、timezone、gconv）。这些用环境变量
（`LOCPATH`/`TZDIR`/`GCONV_PATH`）绕开，而不是扩大 hook 面。

---

## D-003 暂不采用 `openat2(RESOLVE_IN_ROOT)`

**决策**：保留为后续选项，当前不实现。

**理由**：需要设备内核 ≥ 5.6 且行为一致；改错会破坏已验证的语义。当前用户态映射已在
真机与 Linux 上全部通过，没有必要为了省一次字符串拼接引入内核差异。

**触发条件**：符号链接逃逸成为实际阻塞，或映射开销被证明可测地影响目标负载时再评估。

---

## D-004 不做完整 syscall 仿真；必要时把 PRoot 保留为默认后端

**决策**：若关键验收（阶段 A/C）必须依赖大量 syscall 特例才能通过，则 PRoot 保持默认，
bionilux 作为受限可选后端。

**理由**：这是上游分析报告给出的 go/no-go 判据，且与本 fork 的维护成本假设直接相关。

**当前状态**：阶段 A、B 与阶段 C 的**本地/包管理机制**均已通过，不需要 syscall 仿真；
因此暂不触发本决策。**但如果 DNS 这类问题持续需要在内核层绕过，需要重新评估。**

---

## D-005 后端可替换，接口不绑定后端

**决策**：`linux_bash` 的接口与快照格式不绑定具体后端；插件负责选择 bionilux 或 PRoot。

**理由**：见 CONTEXT.md 架构不变量。上游报告也要求"Bionilux 健康检查失败时不注册工具、
不破坏已有 PRoot 环境"。

---

## D-006 绝对符号链接由安装期处理，不在运行时补救

**决策**：写 `scripts/prepare-rootfs.sh` 在安装期把 rootfs 内的绝对符号链接改写为指向 rootfs 内；
运行时不试图拦截符号链接解析。

**理由**：链接目标由**内核**解析，用户态 hook 看不到 `open("/usr/lib/os-release")` 之后
内核去读 `/etc/os-release` 这一步。运行时补救不可能；安装期改写是唯一干净的解。

**代价**：rootfs 不再可随意搬移（链接里含绝对路径）。因此提供 `--relative-links` 改为相对链接，
牺牲"guest 看到绝对目标"换取可搬移。默认取绝对，以保真 guest 语义。

**证据**：真机 rootfs 49 个绝对链接 → 处理后 0；`/etc/localtime` 从读到宿主内容变为读到 guest 内容。

---

## D-007 虚拟身份（fake root）默认开启

**决策**：配置 rootfs 时默认 `BIONILUX_FAKE_ROOT=1`：`getuid/getgid` 返回 0，
`setuid/setgid` 记录到虚拟身份并返回成功，`chown`/`setgroups` 变 no-op。

**理由**：`apt` 与 `dpkg` 会先检查身份再工作；Android 应用的 uid 不可能是 0。实测中
apt 的 http 方法会因为"切换组后 `getgid()` 不是期望值"而报 `Could not switch group`，
因此必须让 setgid 之后的 getgid 如实反映请求值——单纯恒返回 0 是不够的。

**否掉**：恒返回 0（apt 校验失败）；不改身份（apt/dpkg 完全不能用）。

**代价**：guest 对自己的身份认知与真实 uid 不一致。这是与 PRoot 同类的取舍，
因此 CONTEXT.md 明确写"rootfs 是软件包环境隔离，不是内核级安全沙箱"。

---

## D-008 `--library-path` 而非 `LD_LIBRARY_PATH`

**决策**：loader 的库搜索路径按次用 `--library-path` 传递；不设置也不剥离 `LD_LIBRARY_PATH`。

**理由**：两个约束同时成立才行——
1. loader 在 preload 生效**之前**就要加载 libc，所以库路径必须是物理路径且不能依赖 hook；
2. 但物理路径一旦进 `LD_LIBRARY_PATH`，会随环境传给 **Bionic 子进程**，Bionic 的 linker
   也会读它，可能加载到 glibc 的 `.so` 而崩溃。

`--library-path` 只作用于这一个 loader 调用，两个问题一起解决。

---

## D-009 测试必须断言"没有失败标记"，不能只看退出码

**决策**：`apt-get update` 一类命令的断言必须检查输出里的失败标记，且无 DNS 时报告
**skipped** 而不是 pass。

**理由**：实测踩过坑——`apt-get update` 在 DNS 完全失败时仍返回 **0**（把索引下载失败当 warning），
导致真机上曾出现"阶段 C 全过"的**假通过**。假通过比失败更危险，它会让集成方以为可以发布。

---

## D-010 不要指望拦截 libc 的内部调用

**决策**：凡是 libc 自己会去读某个路径的地方，一律在**程序真正调用的公开 API** 上补回来；
不再尝试拦截 glibc 内部别名或 `GLIBC_PRIVATE` 符号。

**理由**：`LD_PRELOAD` 只能覆盖跨 PLT 的公开符号。libc 内部调用自己的函数是 DSO 内直接调用，
不经过 PLT；而 `GLIBC_PRIVATE` 版本符号被 glibc 主动拒绝外部满足——`tests/helpers/privprobe.c`
里同时挂了一个公开的 `getaddrinfo` 作对照：对照打印、两个 `GLIBC_PRIVATE` 钩子都没打印，
说明此路不通。所以 DNS、NSS、`/bin/sh`、`mkstemp`、`dlopen` 这些都是一条条在公开 API 上补的。

## D-011 guest 的身份必须自洽，否则工具会拒绝自己的目录

**决策**：`getuid()` 报虚拟 root 时，`stat()` 系列必须把文件属主也报成同一个虚拟 uid/gid。

**理由**：宿主把文件都算在 App 自己的 uid 上，而 guest 被告知自己是 root。两者不一致时，
任何「把文件属主和自己比一比」的程序都会拒绝工作——`git clone` 直接中止于
`detected dubious ownership`。`chown()` 本来就是「成功但什么都不做」，所以把属主统一报成
虚拟身份才是唯一自洽的语义。

## D-012 Android 目录以原生名字暴露，而不是映射进 rootfs

**决策**：`/sdcard`、`/storage/emulated/0` 以及宿主 App 的私有目录，按**它们自己的绝对路径**
直通；用 `--host-path` / `BIONILUX_HOST_PATHS` 配置，`--no-android-paths` 关掉默认项。

**理由**：集成方（插件）和 App 共享的是同一份数据。若把 `/sdcard` 映射成 rootfs 内的另一个
路径，App 与 guest 就会各持一份副本，且 Android 的路径在 guest 里失去意义。反过来，
`/data/local/tmp` 这类目录在 SELinux 下**可读但不可执行**（`shell_data_file`），所以运行时本体
必须放在 App 自己的 `files/`（`app_data_file`）下——这也是生产布局。
---

## D-013 两个实验性内部插件、Release 分发、共享 glibc Node，默认不启用

**决策**：Linux 环境以**两个实验性内部 Cordis 插件**分发——极小的引导插件（设置入口 + 清单发现 +
安装事务 + 更新策略）与运行时插件（安装/健康检查/卸载 + `linux_bash`）。Bionilux、Debian
minimal rootfs 与 glibc Node.js 作为**版本化 GitHub Release 附件**发布，附 SHA-256/大小，
不进入 Git，也不使用 Git LFS。glibc Node 作为**应用级共享包**安装一次
（`<dataDir>/shared/node/sha256-<摘要>/<arch>`），由各 rootfs 引用；宿主 Bionic Node 与 Termux
保持不变。

**理由**：
1. 用户需求：系统独立于 DSH Mobile 本体更新；必须有“自动更新/手动检查更新”，且自动更新
   只在**已安装系统的 DSH Mobile 版本变化**时触发。
2. release 附件（而非 LFS）避免仓库膨胀与 LFS 配额爆炸——用户明确要求“不要让 LFS 炸了”。
3. 每个 rootfs 各装一份 Node 会重复数百 MB；以内容摘要为键的共享安装既去重又能在系统
   升级时复用同一份 Node。

**边界（不可默示违反）**：两个插件都是**我们自己的内部插件**，写进内置（hard）插件目录，
但默认不启用（存在 ≠ 启用）。应用更新或 Linux 新版本发布都不会启用它们；宿主
`linuxPluginHost.isInjected()` 是唯一权威，用户手工移除后自动更新失败关闭，只有显式安装才能恢复。

**否掉**：把插件打进默认 profile/快照（会与“默认不启用”冲突）；用 LFS 存 rootfs
（配额与克隆成本不可接受）；每个 rootfs 内 `apt install nodejs`（重复且与宿主 Node 混淆）。

**代价**：宿主需要提供真实的插件加载适配器（`linuxPluginHost`）与安全解包/下载 IO；真机端到端
安装、`isInjected` 行为与 guest DNS 仍需设备验收，本文档不将其记为已验证。

---

## D-014 引导插件由宿主显式装载，不进入 profile 与注入集

**决策**：引导插件以**源码**形式随应用分发（我们自己的实验性内部插件），但**不进入 Cordis
profile，也不加入注入集**；它只在用户**显式启用** Linux 环境时由宿主 JS 动态装载。运行时插件、
Bionilux、Debian rootfs 与共享 glibc Node 仍全部作为 Release 附件按需安装。

**理由**：
1. 引导插件需要**函数型 config**（`dataDir` / `releaseUrl` / `pluginHost` / `downloadAsset` /
   `extractArchive` / `fetchImpl` / `appVersionProvider`）。YAML 形态的 profile 在结构上无法表达，
   所以它根本无法被 profile patch 挂载——「在场但不挂载」不需要新增机制。
2. 因此不需要为「在场但不启用」新增 presence-only 注入类：它会牵动协调仓的逐字节镜像文件
   （`inject-all.py`、`build-apk-013.ps1`），却没有任何功能收益。
3. 「存在 ≠ 启用」由宿主的显式决策与 `isInjected()` 只读权威共同保证，与 D-013 的边界一致。

**边界**：未启用时不得注册 `linux_bash`、不得创建 `files/linux-environment`、设置页不得出现入口；
新 Release 或新应用版本都不会复活被用户移除的注入。

**否掉**：新增 presence-only 注入类（无功能收益 + 跨仓镜像改动）；把函数型配置序列化进 YAML
（脆弱，且容易与 JS 语义漂移）。
