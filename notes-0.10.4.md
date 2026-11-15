# Linux runtime 0.10.4

## 说明

**取证版，不是修复版。** 只增加诊断信息，不改变安装行为。

arm64 真机上安装推进到 Android rootfs 准备阶段后，仍会失败并报
`launcher/bionilux.sh: Permission denied`。外部进程复现时同一路径可以正常执行，
说明复现条件尚未找全。本版让失败时自动收集能区分成因的现场并写进错误信息：

- 引擎进程的 SELinux 域与 uid
- launcher 的模式、属主、是否普通文件、大小
- launcher 内容的开头
- 同一文件经 sh 启动、直接启动、经系统 linker 启动的三种结果

拿到下一版真机的 `[launcher]` 行后再针对实际成因修复。

## 修复与改进

- 无行为变更。
