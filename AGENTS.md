# 独立 Linux 环境

本项目的 Linux 命令、依赖安装、编译和打包，使用模拟器内的 Debian 环境。

- 状态：`node scripts/linux-agent.mjs status`。
- 未启动时：`pwsh -NoProfile -File scripts/start-independent-linux.ps1`。等待安装完成后继续。
- 执行：`node scripts/linux-agent.mjs exec '<Linux command>'`。默认复用 `agent` 会话，保留工作目录、环境变量和 shell 状态。
- 工具说明：`node scripts/linux-agent.mjs tools`。
- 长构建：调用 `linux_session` 的 `start` / `poll` 动作，按输出偏移续读；命令格式见工具说明。
- 默认设备为 `emulator-5580`；可按任务需要使用用户指定的 MuMu 实例。认证由客户端自动读取，不需要手工配置令牌。
- guest 文件和已安装软件保存在应用私有目录，停止服务不删除它们。进程终止或模拟器重启会结束活 shell；重新启动服务会恢复已有文件系统并创建新会话。
- Windows / Android 交叉构建仍在宿主执行。不要把 Debian 的成功结果冒充 Android 设备验证。

所有本地归档、编译产物和验证报告放入 `target/independent-linux/`，不要提交二进制或令牌。
