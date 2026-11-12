# Device acceptance

这些脚本在真机上验证 **guest 内部**行为，不依赖 DSH/Cordis 插件层。

## 文件

- `polyglot/`：多语言栈（Ruby / Erlang / Zig / Rust / C）在 guest 内的构建与互操作验收。
- `composer_mongodb.php`：PHP + Composer + MongoDB 扩展的 guest 内验收。
- `standalone-build.sh`：在已安装的 Linux 环境里做真实源码构建（zstd）验收。

## 边界

- 安装、校验、解包与进程生命周期由消费方应用（acp-agent-ui 的 Rust 安装器）负责。
  原先基于 `packages/linux-*` 的 `manager-device.mjs` 与 `standalone-device.mjs`
  已随插件层一起删除。
- 本目录的脚本只断言 guest 语义，不声称 Android 平台兼容性，也不替代真实资产安装验证。
