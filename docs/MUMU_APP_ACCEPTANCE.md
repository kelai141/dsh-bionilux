# MuMu 应用内 Linux 接入验收（2026-11-05）

本轮使用用户指定的 MuMu 独立实例 `127.0.0.1:16448`，只操作 `com.dsharnessmobile.shell`。提供商为 `https://d1api.xin/v1`，模型为 `deepseek-v4.1-flash`。密钥仅通过 ADB 输入应用的密码框，不进入源码、安装包或报告。

## 源码与产物

- Bionilux 源码：本仓 `codex/standalone-linux`。
- APK 独立工作树：`D:/coding/dsh-mobile-linux-mumu`，分支 `codex/linux-mumu`。共享原目录中的删除和其他任务改动保持原状。
- 最终本地测试 APK：`target/independent-linux/mumu-ui/dsh-mobile-linux-source-final-x64.apk`，206099057 字节，SHA-256 `d055b06d95560b3b5a320c44534b3962381a58ccd8a851c18aeb10881712581f`。
- 内嵌快照：200713148 字节，SHA-256 `96a07411f316fb81e3ef5f1b92d5d161581d59cfd1605de8c569857605bc316b`。
- 独立审计：两个 profile 的 24 个插件实例、566 个文件逐字节匹配工作树构建产物；快照、指纹文件、199 条硬清单绑定一致。APK v1/v2/v3 签名通过。
- Linux runtime 下载资产：SHA-256 `735fc338081d089e212190309ad876be5ebb4d16baa57c8452eb5c7c5a6d893c`。归档内全部七个 `lib/`、`modules/` 文件与本仓源码逐字节一致。

## 实际操作链路

开发时热推只用于定位问题。最终记录从卸载清理应用开始：重装新版 UI APK、用 ADB 点击配置测试提供商，再覆盖安装含最终兼容元数据的源码 APK；提供商配置保留。随后从“尚未安装 Linux”的状态点击“一键下载并安装”，四类资产全部下载、校验、解包，bootstrap 安装并激活，回到对话提交完整任务。此最终链路未热推插件、未在设备上修源码或手动安装依赖。

本地模拟服务器只监听 `127.0.0.1:18793`，经 `adb reverse` 提供官方版本化路径的回放。debug APK 的私有 `linux-environment/debug-download-origin` 指向该回环地址。正式构建不读取此文件，正式 HTTPS 来源规则没有放宽。资产包括 runtime 插件、Bionilux 启动器、Debian rootfs 和共享 Linux Node；服务器记录完整 HTTP 200 字节数，宿主和引擎分别复验摘要、体量和解包内容。

所有界面动作使用 ADB `input tap/swipe/text/keyevent` 或应用自带 ADB 输入法；CDP 只读状态、几何和对话内容。点击清单记录在 `mumu-ui/adb-actions.jsonl`，密码文本只记录字符数。

## 已验证行为

- 最终 APK 中 bootstrap 服务可用，首次 `manifest:null` 自动检查并重读；安装后 runtime 为 healthy、enabled、injectionActivated。
- 真实模型直接调用 `linux_bash` 和 `linux_session`，无需发现启动器或额外配置。
- 文件工具与 Linux 工具双向读写同一工作区，设备号和 inode 相同；指定 guest cwd 仍保留工作区映射。
- 持久会话跨多次调用保留 cwd、导出变量和 shell PID；后台构建返回 job ID，`poll` 返回真实状态和日志偏移。
- 中英文页面和横竖屏均实际点击并截图；英文横屏检查更新可操作，无水平溢出；已是最新版本时更新按钮禁用，重新安装独立可用。
- 中间开发轮次由模型构建多源文件 C++ 项目，单元测试 72 项检查、CLI 34/34、CTest 通过，完成打包与解包重建。该轮仅作开发证据，最终源码 APK 另跑官方 zstd 任务。

## 修复与回归证据

源码修复覆盖：Cordis 可选服务读取及父子激活顺序、真实 fiber ACTIVE 检查、首次清单发现、四类资产与 guest symlink、冷启动恢复、标准 JSON Schema、运行中 nullable 字段、注册失败回滚、模型可见的 job/offset、按 agent 隔离的会话和自动工作区映射。回归测试使用真实 Harness rc3 ToolRuntime，而非仅记录注册名的桩。

代码层记录包括 Kotlin Linux 资产测试、host 路由/恢复测试、UI 全套 886 项及 Linux 页 12 项测试、runtime 全套和真实 registry/工作区测试。平台条件导致的跳过保留在日志中；自包含 APK 工作树缺少只读上游检出的门禁项仍为 SKIP，不把本地 debug APK 宣称为完成发布门禁的 release。

## 最终模型结果

同一最终源码 APK 中，d1 模型自主完成官方 zstd 1.5.7 任务（86 步，12 分钟）：

- 通过 apt 自行安装 gcc 14.2、Make 4.4.1、libc6-dev、binutils、curl 等依赖。
- 官方源码发布包 SHA-256 `eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3`；637 个原始文件构建后均未修改或缺失。
- `make -j4 lib zstd` 异步构建退出 0，约 124 秒；可执行文件、静态库、共享库及安装树均生成，静态/动态链接探针均返回 1.5.7/10507。
- 两轮官方 `make -C tests check` 带明确时间上限，退出均为 0，约 170/62 秒。第二轮仅通过环境变量启用默认未初始化而跳过的解析器段，无源码修改。官方 large data tests 按环境逻辑跳过，未宣称覆盖。
- 9 个文件、22 个官方夹具、Unicode 路径、篡改负控、大窗口及额外 40 MB 数据往返全部通过。
- 持久会话多次调用保持 PID 32638、cwd 与导出变量；后台任务通过真实 job/poll 跟踪。
- 归档 `zstd-1.5.7-mumu-acceptance.tar.gz`：4024173 字节，SHA-256 `e0ef89e6e184cbc63fbe5fb46b1481bb6797254da405fa885238f6cac4184e7c`。新目录解包后的运行、静态/动态链接和 30 个载荷摘要均通过。
- 已实际强制停止并冷启动应用；实例 ID 不变，healthy/enabled/activated 均为 true，归档摘要不变，模拟下载服务器请求数保持 10 条，没有重新下载。
- 冷启动后由同一真实模型再次执行现有二进制、工具链和文件校验通过。随后跨对话轮次保留 PID 41645、REVERIFY_MARK=mark-21573，以及最后显式 cd 设置的 acceptance 目录，三项均通过。`cross-turn-final.json` 保留原始输出和更正：此前模型误把自己最后的 cd 归因于运行时重置；显式关闭的会话也不计入持久性失败。

原始模型报告为 `mumu-ui/model-acceptance-report.md`，日志和产物位于同目录；`source-restart-audit.json` 记录前后实例与下载计数。源码安装包、工具源码和下载资产的审计报告均在 `target/independent-linux/mumu-ui/`。

## 边界

这是共享 Android 内核的 Debian/glibc 用户空间。活 shell 和内存变量在进程结束时终止，文件及安装的软件持久保存，重启后重新创建会话。MuMu 本次暴露 x86_64 应用 ABI，内核 `uname -m` 为 aarch64；结果限于该实例，不能推断所有真机或所有项目。此次未上传 GitHub Release，正式下载资产发布不在本地模拟服务器验收之内。
