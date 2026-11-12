# 独立模拟器与 Agent 入口

**状态：通道已移除（2026-11-12）。**

原入口依赖 DSH/Cordis 插件层（`packages/linux-bootstrap`、`packages/linux-runtime`）与
`scripts/start-independent-linux.ps1`，这些已随插件层一并删除。独立 Linux 环境的安装、
校验与执行现由 acp-agent-ui 的 Rust 安装器（`src-tauri/src/linux_runtime/`）承担。

历史验收记录见[独立环境验收记录](INDEPENDENT_LINUX_ACCEPTANCE.md)，仅作时间点参考。

在本仓库内验证 launcher/preload 请使用：

```bash
cargo test
bash tests/runtime.sh
bash tests/preload_paths.sh
```
