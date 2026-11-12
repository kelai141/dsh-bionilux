# 机内 agent 构建 APK 与环境契约修复（2026-11-05）

> **2026-11-12：** `packages/linux-*` 插件层已移除，文中对 `linux_bash` 工具描述引用的位置已失效。

设备为 MuMu `127.0.0.1:16448`，应用 `com.dsharnessmobile.shell`，真实提供商 d1，模型 `deepseek-v4.1-flash`。用户已授权使用该实例；本轮没有启用子代理。提供商凭据没有写入源码或报告。

## APK 构建与装机

通过 ADB 在应用新会话发送构建目标；会话 `22def602-534e-42f3-a058-b5c144a9568e`。模型自行安装 OpenJDK 21、获取 Google build-tools 35/platform 35、编写 Java/XML 与可重放脚本，并通过 Linux 工具完成 javac、aapt2、D8、zipalign 和 apksigner。宿主只导出、验包、安装和操作 UI，没有替模型编译计数器。

首轮模型混用了宿主 bash 与 Debian 工具，且遇到真实的 Java alternatives 加载器缺陷。通过 ADB 发送过一次环境边界纠偏，没有提供构建命令或代写应用源码。因此这轮结果不能称作“零纠偏单提示成功”。模型修正后完成构建并重复重放，APK 摘要一致。

- APK：`dev.dsh.linuxbuild.counter`，21,430 字节，SHA256 `b09ebe5a8597fbcf87db81b1f43ac6e768661985f6300fc511ff0f4e9780633f`。
- minSdk 26 / targetSdk 35；无联网权限；签名 v2/v3 有效。应用源码、构建脚本及模型原始报告保存在设备共享工作区 `apk-self-build`。
- ADB 安装成功，实际界面从 0 连续点击两次 +1 后显示 2，退后台并 force-stop 后重开仍为 2；清零后显示 0，再次 force-stop/重开仍为 0。
- MuMu 的 uiautomator 在退出时发生 SIGSEGV/SIGBUS，故功能验收改用观察过的按钮位置进行真实 ADB 点击、逐阶段截图。计数器应用没有发生上述崩溃。证据含初始、加一、重开、清零、再次重开截图。

修复后的新应用会话为 `ae935925-3925-4e5e-a80a-be968c840d12`。只发送重放验收目标，没有提供工具名或环境纠偏。模型自行查状态，以 linux_bash 验证 JAVA_HOME、LD_LIBRARY_PATH、CLASSPATH 均未设置时 java/javac 返回 0，再验证 keytool/jarsigner；自行打开 linux_session，以 start/poll 完成完整重编译，任务退出码 0，APK SHA256 与首轮完全一致。目录检查使用过宿主文件工具；依赖和构建检查在 Linux 工具执行，没有再尝试 proot/chroot 或宿主编译。模型另写 `replay-acceptance.md` 留下验收记录。

## 源码修复

`src/launcher/resolve.rs` 的加载器搜索路径原先以命令别名的父目录展开 `$ORIGIN`。Debian 的 `/usr/bin/java -> /etc/alternatives/java -> JDK/bin/java` 因而把 JDK 库目录计算到错误位置。现使用真实 ELF 文件目录；只接受 rootfs 或显式透传路径内的规范路径，不改变 argv 或脚本调用名。覆盖 alternatives 多级链接、RPATH/RUNPATH、带空格 SDK 路径、共享 SDK 与未授权外部路径边界。

MuMu 同一 JDK 的独立前后对照：旧加载器运行 `/usr/bin/java -version` 和 `/usr/bin/javac -version` 均返回 127、缺少 `libjli.so`；修复加载器两者返回 0、21.0.13；直接 JDK 路径在两版均成功。没有设置 JAVA_HOME 或向 LD_LIBRARY_PATH 补 JDK 库来绕过缺陷。随后在引擎停止时以同目录临时文件和 rename 部署修复加载器，保留原 rootfs、已安装软件与共享工作区；旧二进制只归档到本地验证目录。

`packages/linux-runtime/lib/index.js` 明确 JDK/SDK/APK 构建属于 Debian 工具、共享内核/proc 不代表执行在宿主、一次性调用不保留 cd/export，并在模型可见的工具输出中加入执行环境标记。

APK 仓的 `linux-tool-contract.ts` 补全模型实际收到的 bash 工具描述及每轮 required context，说明宿主/客体边界、启动等待、共享路径和持续会话；保留宿主执行器及权限策略。构建依赖显式声明，执行地图纳入新模块。独立 Linux 启动脚本同时修复启动早期 ADB 未返回 boot 值时的 null.Trim 异常。

## 验证和交付边界

- 模拟器 Debian：Rust 单元测试 78/78；真实宿主插件及提示组装测试 69/69；Linux 工具注册、持续会话与模型输出聚焦测试 6/6。
- 反证：仅将加载器路径计算还原为旧逻辑、保留新增测试时，3 个 ORIGIN 测试中 2 个失败；恢复修复后 3/3 通过。
- Android x64 加载器交叉编译成功；新版壳应用打包、安装成功；签名用显式 minSdk 23 验证 v1/v2/v3 均有效；执行地图检查通过。
- 新 APK 两个 profile 的宿主插件 lib 共 28 个文件逐字节匹配构建产物。重新生成的 backend/runtime 资产分别校验到最终加载器和 runtime 源码，清单重新计算校验和。
- 普通 Linux 主机用的 `tests/sharedlib.sh` 夹具在嵌套 Bionilux 下 29 项失败；`launcher_errors` 2 项通过、1 项因嵌套 guest cwd 映射失败。这两组没有算入通过数。新增真实 Java 前后对照及单测通过，不宣称完整普通 Linux 主机集通过。
- 当前 APK 为本地 DEV-FAST 验证包，正式发布链未运行；新的下载资产尚未发布到远端 Release，不能把远端现有 v0.5.0 资产视为已更新。设备的原运行时插件未被改写成伪造的旧摘要目录，新 runtime 输出标记由资产和 Debian 回归验证。
- 本次真实构建的是小型纯 Java APK，未使用 Gradle/NDK，不能据此承诺任意大型工程都无需适配。

完整日志、模型会话、截图、APK、构建资产、前后对照和摘要清单位于 `target/independent-linux/`，不提交二进制或令牌。
