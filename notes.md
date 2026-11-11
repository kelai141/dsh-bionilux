# Linux runtime 0.10.0

## 修复与改进

- 修复 Android system-linker 启动的 launcher 身份、外部子进程及 posix_spawn 重入链路。
- 安装、冷启动恢复与工具注册必须通过真实 Bash、外部命令和共享 glibc Node 的执行验证；任何启动错误均不再作为成功。
- 保留持久会话在健康刷新期间的状态，限制排队与输出，修复超时诊断、后台任务清理及容量管理。
- 为安装中断、共享 Node 换树及删除中断增加保守恢复和故障注入回归。
- DNS 查询采用整次预算；路径映射溢出失败关闭；空环境子进程保留必要的私有启动上下文。
- Android launcher/preload 构建加入 16 KB 对齐；发布检查完整 ELF 载荷（ARM64 16 KB、x86_64 4 KB），不以构建通过代替设备验证。

## 安装前提与验证边界

仅面向 64 位 ARM64 / x86_64 引擎。现代 Android APK 必须携带与 Debian/glibc 配套的 native loader，并正确传递 nativeLibraryDir；现有 APK 的版本号本身不是兼容性证明。详见 [移动端兼容条件](docs/MOBILE_COMPATIBILITY.md)。

本运行时不是安全沙箱，Linux 虚拟 root 不是 Android root。实际设备、正式资产与 CI 验证结果以发布前审计记录为准；未验证组合不声称已支持。
