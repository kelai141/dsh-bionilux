# Linux runtime 0.5.0

- 增加 ARM64 与 x86_64 的 Debian 13 开发运行时资产、配套 glibc Node 和安装插件。
- 修复路径映射、动态库与 executable 身份、最小子进程环境、文件 IPC 及进程生命周期问题。
- 调试构建与发布分离；发布入口仅创建草稿，包含双架构 manifest、源码提交信息和 SHA-256 校验文件。

验证范围与限制见 docs/ACCEPTANCE_FIXES.md 和 docs/ACCEPTANCE_FIXES_FOLLOWUP.md。
部分工具链需要配置适配；ARM64 手机、SELinux Enforcing 与完整长期压力验收尚未完成。
运行时不提供内核级安全隔离。草稿经人工审阅后再决定是否公开发布。
