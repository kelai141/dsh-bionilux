# 独立 Linux 环境验收

日期：2026-11-04。源码分支：`codex/standalone-linux`。

## 实际运行结果

专用 AVD `dsh-api29` / `emulator-5580`，Android x86_64，SELinux Enforcing，
宿主进程实际 UID 10146。guest 为 Debian 13 / glibc，虚拟 root 不改变 Android 权限。

| 验收项 | 结果 |
|---|---|
| 模拟下载 → 摘要及体量复验 → 解包 → 激活 | 最终源码资产干净安装成功 |
| 损坏归档负控 | digest、truncate 均拒绝，插件未加载 |
| DNS / HTTPS / APT | 自动写入可用 DNS，严格 APT update 与工具链 install 均返回 0 |
| 包管理维护脚本 | openssh-client 账号锁、libc-bin ldconfig 触发器成功，`dpkg --audit` 无输出 |
| Node / npm | glibc Node v24.22.0、npm 11.19.1，通过共享目录直接调用 |
| Agent 持久会话 | 连续调用保留 cwd、变量；后台任务按字节偏移读取并返回实际退出状态 |
| 真实源码构建 | 官方 Zstandard 1.5.7，CMake + Ninja，138 个编译链接目标完成 |
| 测试与打包 | 上游 playTests、压缩解压往返比对、安装及 tar.gz 打包通过 |
| 从最终资产重新安装 | APT 再次成功；持久工作区中的项目再次配置、构建、测试、打包通过 |
| 模拟器完全停止后自动恢复 | `adb emu kill` 后仅运行 Agent 命令，自动启动 AVD、恢复已有实例 |
| 重启持久化 | runtime instanceId 前后一致，包、工作区、标记文件和归档摘要保持一致 |
| 源码与资产一致性 | runtime 的 lib/modules 与 backend 三份准备脚本共 10 项逐字节一致 |

最终构建归档：`target/independent-linux/zstd-1.5.7-linux-x64-final.tar.gz`。
SHA-256：`07e4e60e9df5e76510c6127b4d7b33288b08d2eee85a8e13434b8fe35b6be474`。

## 源码修复和复发防护

- release rootfs 不再含应用无法创建的设备节点或硬链接；清单生成器拒绝这些成员。
- DNS、宿主准备命令的动态库路径、完整共享 Node 目录和可遍历父目录在安装期自动准备。
- 共享目录同时登记 Android 路径别名及规范路径，CMake/Ninja 的子进程不再丢失工作目录。
- 静态 ldconfig 的适配使用真实缓存生成与本地 dpkg diversion；包升级会保留它。
- guest 账号锁使用真实文件互斥；Shadow 的链接数兼容仅限其精确的锁协议。
- 持久会话、后台输出及任务数量有界，关闭时验证 PID 身份并回收受管进程组。
- 114 项 Linux 插件测试全通过；Windows 侧 44 项通过、6 项平台跳过。
- Rust 76 项单元测试及原有的 3 项 launcher 错误回归通过。
- Make、runtime/PTY、audit、shadow 锁、Android rootfs 准备与 21 项发布契约测试通过；
  新增回归已接入构建工作流。

原始证据保存在 `target/independent-linux/`：
`plugin-final.log`、`shadow-final.log`、`android-prepare-final.log`、
`apt-install-fresh-final.json`、`final-reinstalled-build-poll.json`、
`restart-recovery-final.json`、`restart-instance-comparison.json`、
`source-asset-consistency.json`。令牌不进入源码或报告。

## 验证边界

本次打通的是本项目的独立模拟器入口和真实 bootstrap/runtime 安装执行链。
该轮独立验收服务不能用来证明 DSH Mobile 应用入口已经接通。
后续应用内设置页、bootstrap 宿主与 Kotlin 下载桥的整合和 MuMu 实测，
另见 [MuMu 应用内验收](MUMU_APP_ACCEPTANCE.md)。未发布 GitHub Release。

活 shell、内存变量和运行任务在模拟器停止时结束；文件系统和已安装包保留，
Agent 下一次调用自动打开新会话。此环境共享 Android 内核，不支持任意内核特权操作。
本次只覆盖 x86_64；未把结果推断为所有 ARM64 设备或所有大型项目都兼容。

早期构建轮次的 fullbench 与 playTests 通过；两项默认无时限 fuzz 测试未跑完，
保留为未得结论。最终复验使用明确有界的 playTests 与真实文件往返校验。
