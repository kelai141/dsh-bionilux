# 0.10.0 发布前审计与验证记录

## 结论与范围

本轮接续历史交接，对 Android launcher/preload、bootstrap 一键安装/恢复、runtime 工具注册、持久会话与发布产物进行正确性和兼容性审查。**不能据此确认现有 DSH Mobile 壳在“大多数安卓设备”上一键可用**：现代壳必须在 APK 中携带匹配的 glibc native loader，64 位 ABI 与页大小也必须匹配。详细前提见 [移动端兼容条件](MOBILE_COMPATIBILITY.md)。

这不是一次已完成的完整安全认证。安全技能流程仅完成源代码侦察，因缺少规定的 OS 强制隔离验证环境、且审查时源码持续变化，已记录为 incomplete；没有把未验证的猜测定为已确认安全漏洞。运行时本身也不是安全沙箱。

## 已修复的发布相关缺陷

1. system linker 启动时错误的 launcher 身份，以及 Android posix_spawn 未经过 system linker。
2. 文件存在即健康、启动 ENOENT/EACCES 放行、只有 shell builtin 能运行也注册工具。现在必须验证 Bash、外部 id/uname/ls 与共享 Node，冷启动重新验证。
3. bootstrap 安装/恢复仅凭 host membership 持久化启用；现在执行证明、版本与 ABI 检查失败即不激活。
4. 共享 Node 换树先删除、崩溃残留与引用计数；增加事务替换、失败回滚、保守清理与 verify/execute 前独占恢复。
5. 健康刷新重复注册导致会话消失；异步激活卸载后仍发布服务。
6. 会话准备期间跨过管理门禁、同名跨 registry 互删任务文件、并发打开未等待 READY。
7. 会话队列、任务容量/清理、UTF-8 输出限制、超时部分输出和工具结果截断标记。
8. 路径溢出可落到宿主/可创建的 sentinel；现在返回内核必拒绝的超长路径。DNS 使用整次 deadline，最小环境保留私有启动上下文。
9. 发布新增完整 ELF 载荷布局检查，而非只检查 launcher。ARM64 guest 要求 16 KB，x86_64 明确是 4 KB 模拟器目标；两架构自编 launcher/preload 都使用 16 KB 对齐。

历史 [RISK](RISK.md) 和 [HANDOFF](HANDOFF.md) 仅为旧快照，不代表当前状态。其中 getifaddrs 逐节点释放猜测不适用于 Linux glibc 的一次 free(head) 协议，未据此做错误重写。

## 本地证据（发布资产尚需独立核验）

| 环境 / 检查 | 本轮结果 | 边界 |
|---|---|---|
| Windows 全量 bootstrap/runtime Node 测试 | 221 项，203 通过，18 跳过，0 失败/取消 | 跳过 POSIX/权限/进程相关项；不是 Android 覆盖；在最后 registry 同时打开补丁之前启动 |
| 独立 Debian 最新 bootstrap/session/registry/render | 127 项全过，0 跳过 | API29/x64，真实 shell/会话子集；不是 clean release 安装 |
| Windows 最新完整 session 文件 | 33 项全过 | 包括真实 Git Bash、并发 READY、跨 registry 文件隔离；不是 Linux 主机验证 |
| Windows ELF 合成测试 | 19 项全过 | 合成 ELF 正/反例，不是设备执行 |
| Windows 发布合约 | 21 项成功，1 个符号链接权限用例跳过 | Python 元数据/归档负例 |
| Rust 格式 | cargo fmt --check 通过 | 主机离线格式检查 |
| 独立 Debian C 构建 | preload 与 hooks-unit 均 -O2 -Wall -Wextra -Werror 通过 | 编译在 Android 内 Debian；不替代正式资产 |
| 独立 Debian hooks-unit | 12 个检查段全过 | 使用独立 glibc loader、规范化 synthetic root |
| 旧 x64 本地归档 ELF 全扫描 | 660 个 runtime ELF，4 KB 规则 0 失败 | 明确旧资产，不是 0.10.0 源码/归档一致性证明；不含 APK loader |
| Android 当前源码集成冒烟 | API29 / x86_64 / 4096 页 / SELinux Enforcing：真实 manager.verify、linux_bash/linux_session 注册、外部命令、共享 Node24.22、export 跨调用复用、会话关闭全部通过 | 现有 0.5.0 实例换入新 preload 与当前 JS；launcher 来自此前本地重建，**不是干净 0.10.0 安装或 Settings UI** |

证据日志位于被忽略的 target/independent-linux；不提交二进制、令牌或本地报告原始设备路径。

## 失败/不成立的验证不能隐去

- 初次 Debian 插件子集 52 项：49 通过、3 失败。其一是测试把元数据 cwd 当真实 PWD，已修；另两项在过短冷启动预算下未观察到任务完成，现改为有上限等待并保证失败 teardown。最后源码在独立 Debian 重跑 bootstrap + session + tool registry/render 子集：127 项全部通过、0 跳过；旧失败仍保留为历史。
- Debian 中 rustc -vV 在旧/新 preload 下均超时，cargo test 尚未编译。无有效本地 Rust 单测通过声明。
- 将 Linux host-style preload_paths/runtime 套件嵌在 Android Debian 内会受外层 reroute 与 synthetic root 缺 loader/host launcher Bionic 不兼容影响；记录失败，不作为该套件有效通过。需 Linux CI 提供独立主机结果。
- 未完成 ARM64、Android 新版本 OEM、实际 16 KB 页设备与正式壳 Settings 一键安装矩阵。

## 远程门禁

[PR #14](https://github.com/kelai141/dsh-bionilux/pull/14) 承载修改。合并前须检查最终源码的 Linux CI、双架构实际构建、manifest/SHA256SUMS/BUILD_INFO 与 ELF 报告；正式版只使用合并提交重建资产，不复用旧本地 backend。远程核心测试记录：Rust 84 个单测 + 3 个集成测试通过；Linux 插件 222 项中 221 通过、1 个平台条件跳过，0 失败。首轮 [Linux CI](https://github.com/kelai141/dsh-bionilux/actions/runs/43056494456) 中 Rust fmt/clippy/test、原生 Make/interactive/preload paths、插件测试、发布合约与 Android ARM64 launcher 构建已通过；旧 Box64/x64-libs 辅助构建遇到 Ubuntu DNS 解析失败。首轮 [双架构 build](https://github.com/kelai141/dsh-bionilux/actions/runs/43056686884) 在必需 cross-tool apt 下载处等待/失败，尚未生成可发布的双架构资产。已为网络步骤增加严格失败、IPv4、有限重试与总时限，并固定 Ubuntu24.04 runner；旧 Box64/x64-libs 改为显式 workflow_dispatch 的 build_legacy_artifacts 选项（默认关闭，它们仍供旧 setup 使用，不属于现代 release 依赖）。所有必需 AArch64/QEMU、Rust、原生、插件与 ELF 门禁保留。需要重跑，不能将旧失败 run 声称为全绿，也不能将此 CI 范围调整称为修好了旧下载源。后续网络故障已通过只在确认 DNS/网络错误时启用的 Ubuntu 签名镜像回退推进至交叉编译；回退保留 Ubuntu archive keyring、APT Release 签名与包摘要验证，绝不绕过证书/签名/摘要错误。交叉编译随后暴露 --no-install-recommends 需要显式声明 libc6-dev-arm64-cross，继续修正并重跑。远程最终结果与正式 release 链接在完成后补记。
