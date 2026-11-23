# Bionilux 0.10.11

- ARM64 guest 的 libc 被包管理器替换后，下次健康验证会重新检查实际文件。已识别的 libc 会原子恢复兼容处理，无法识别的构建会报告原因。
- Android 更新先由宿主 shell 准备缓存路径，再由 guest 的动态 ldconfig 写出并回读真实缓存。准备失败时保留原活动运行时，并显示失败步骤和退出码。
- Linux 状态查询使用活动管理器的执行验证。运行时异常时保留工具入口，执行前仍检查健康状态。
- Debian 13 rootfs 预装与 libc6 版本匹配的 libc6-dev，Android 安装时固定 libc6 和 libc-bin，避免普通升级覆盖已准备的 glibc。

本版提供 ARM64 和 x86_64 资产。vivo Android 17 已验证既有 Linux 环境的终端与子进程。此版后端的原地更新以及 OnePlus 原机报告的 SIGSYS 仍需现场复测。相关记录见 #36 和 #37。
