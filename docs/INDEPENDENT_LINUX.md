# 独立模拟器与 Agent 入口

此入口在 Android 模拟器的应用 UID 内运行 Debian/glibc 用户空间。
安装、校验、工具注册和执行使用本仓的 bootstrap、runtime plugin 与 manager；
模拟下载服务及 HTTP 宿主适配器位于 `tests/acceptance/`。
它支持独立测试 Linux 运行时，不代表 DSH Mobile 设置页或 Kotlin 下载桥已经接通。
本次设备和源码验证结果见[独立环境验收记录](INDEPENDENT_LINUX_ACCEPTANCE.md)。

## 已安装的本地环境

在仓库根目录执行：

```powershell
pwsh -NoProfile -File scripts/start-independent-linux.ps1
node scripts/linux-agent.mjs status
node scripts/linux-agent.mjs exec 'pwd; node --version; gcc --version'
```

启动脚本复用专用 `emulator-5580`；未启动时启动 `dsh-api29`。
应用内必须已有可运行的宿主 Node 与 tar/xz。脚本自动部署源码、使用本地
`target/independent-linux/assets/linux-release.json` 中的资产并等待健康检查。
已经就绪时直接复用，不重新安装。脚本只向设备复制清单引用的归档，
不复制测试状态或令牌。

默认命令在 rootfs 外的 `files/independent-linux/workspace` 中打开名为 `agent` 的 shell。
变量、函数和当前目录跨调用保留，工作目录也会跨 rootfs 重装保留。
`BN_SESSION` 可选择其他会话，`BN_COMMAND_TIMEOUT` 可调整超时。

```powershell
node scripts/linux-agent.mjs exec 'cd /root; export EXAMPLE=kept'
node scripts/linux-agent.mjs exec 'printf "%s %s\n" "$PWD" "$EXAMPLE"'
node scripts/linux-agent.mjs tools
node scripts/linux-agent.mjs call linux_session '{"action":"list"}'
```

长任务通过 `linux_session` 的 `start` 返回 job，再用 `poll` 及返回的
`nextOffset` 增量读取输出。日志有固定上限，超过上限后继续排空输出，
编译继续执行；最终返回真实退出状态。

客户端自动读取私有令牌，并建立 ADB 端口转发。令牌不需要复制到配置中。
在 Windows 上，执行命令时发现服务未就绪会自动调用启动脚本，恢复模拟器和已有实例。
服务除 `/health` 外都校验 Bearer 认证，拒绝超出上限的请求体。

## 持久化边界

guest 文件、已安装包和项目文件位于应用私有目录；停止服务或重启模拟器不会删除它们。
重新运行启动脚本会恢复已有实例，不会通过重装来“恢复”。
活 shell 和内存变量属于当前进程；进程退出或模拟器重启后需创建新 shell。
本入口是非交互 shell，完整屏幕程序和交互式终端作业控制不在这个工具接口内。

重装会更换 rootfs。需要跨重装保留的项目应放在共享的应用工作目录，
并通过工具的绝对 `cwd` 参数使用；不要把 rootfs 内的临时工作目录当作外部数据卷。

## 从源码生成模拟资产

先编译 Android launcher 与匹配架构的 glibc preload，再使用：

```sh
python3 tests/acceptance/build-standalone-assets.py \
  --rootfs <Debian-rootfs.tar.gz> --node <official-node-linux-x64.tar.xz> \
  --launcher <bionilux-x86_64> --preload <libbionilux_preload.so> \
  --output target/independent-linux/assets
```

该脚本会从归档移除设备节点，并将硬链接展开为普通文件；符号链接保留。
生产构建在 `.github/workflows/debug-build.yml` 使用相同的无设备节点、无硬链接规则，
`scripts/build_release_manifest.py` 在生成清单时再次拒绝不支持的成员类型。
源码和归档更新后需重新生成清单中的摘要与体量，不能直接改已被清单钉定的资产内容。

## 平台兼容维护

- DNS 在安装期自动准备；Android 的本地 stub 不会直接写入 guest。
- 普通命令使用非 login shell，保留 manager 配置的共享 glibc Node PATH。
- Debian 13 的 GNU Make 使用管道 jobserver，避免 Android 拒绝 FIFO。
- Android audit 拒绝只在虚拟 root guest 中转换为“不支持 audit”；主机成功的审计调用保留。
  账号工具的容错条件见 [Shadow 官方实现](https://github.com/shadow-maint/shadow/blob/master/lib/audit_help.c)。
- 账号数据库使用 guest 内真实的有界文件锁；Shadow 的复制锁降级只影响其精确匹配的临时文件，
  不会全局伪造链接数。
- 静态 `ldconfig` 通过本地 dpkg diversion 保留原程序，实际生成 guest 缓存。
  注册和缓存生成位于实例最终路径上，失败时安装回滚，libc-bin 升级继续保留适配器。

这里运行的是共享 Android 内核的 Linux 用户空间，不能据此保证任意静态程序、
内核模块或需要特权的系统服务都能运行。完整模拟器安装和构建记录放在
`target/independent-linux/`；最终报告区分真实设备结果与宿主测试结果。
