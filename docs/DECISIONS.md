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
