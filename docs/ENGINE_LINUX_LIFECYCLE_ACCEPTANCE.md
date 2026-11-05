# DSH / Linux 启停与强杀恢复验收（2026-11-05）

联动对象是应用内 Debian/glibc 用户空间与其终端、后台任务。MuMu 是测试设备，应用不会关闭整台 MuMu。Linux 文件系统和软件安装保存在应用私有目录；活 shell、环境变量和进行中的命令属于进程，强杀后结束，重新启动创建新会话。

## 源码行为

- 应用原有自动启动开关保持生效。DSH 的宿主插件先激活，Linux bootstrap 在后台恢复已经启用的环境，父 `apply()` 不等待子 fiber，避免互锁或把对话就绪卡在 Linux 恢复上。
- `linux_environment_status` 始终可见，立即返回 starting / ready / not-installed / disabled / failed / stopping / stopped。每轮 required context 也读取该状态，启动中明确说明“DSH 已启动，Linux 运行时引擎仍在启动”，不用工具缺席让 agent 猜路径或回退宿主 shell。慢恢复和失败由受控延迟、真实 ToolRuntime 与 SystemPrompt 测试验证；设备上真实模型已调用状态工具读到 ready。
- 正常关闭先持久化用户停止选择，界面进入 Stopping，禁用启动按钮；SIGTERM 让插件停止接受新的激活、释放 runtime、终端和任务。原生侧保留宿主句柄，给予 12 秒宽限，必要时强制终止并按 PID/starttime/UID 清理本代引擎域。无法确认清理时保留原因、拒绝重复启动，不提前显示 Closed。
- 代际标识在创建宿主前落盘；旧代际未清理不能创建新引擎。只清理可归属的同 UID 进程，PID 复用、僵尸和不可读身份分别处理。进程域白名单保留 `DSH_ENGINE_INSTANCE`，不继承提供商密钥。
- 启动与停止竞争时，在创建进程前再次检查用户停止状态。引擎关闭造成的 restore 取消不清除用户的持久启用选择，下一次启动仍可自动恢复。

## 设备与最终产物

使用用户批准的 MuMu 实例 `127.0.0.1:16448`、应用 `com.dsharnessmobile.shell`，提供商 d1、模型 `deepseek-v4.1-flash`。设置导航、关闭确认、输入、切后台和启动均经 ADB；CDP 只读页面/几何与状态。

最终 APK：`target/independent-linux/dsh-mobile-linux-lifecycle-x64.apk`，207354337 字节，SHA256 `b2ba3ee8d80bfe4bc6dabd5eb692e0cd320d9f2b2ed550f6bf053958466e182f`。签名 v1/v2/v3 通过（显式 min-sdk 23 校验 v1）；最终包嵌入快照 SHA256 `37fe2e297d55142a95222526f3da17b589d6a905d12fc898b44ee1e978ae082b`，快照、指纹、199 条硬清单一致。两个 profile 中相关插件 42 个文件逐字节匹配构建产物。

APK 源码在 `D:/coding/dsh-mobile-linux-mumu` 的 `codex/linux-mumu`；实际提交见该分支最新生命周期修复提交。本仓源码在 `codex/linux-mumu-source`，独立工作树保存完整构建基线。已按用户指示删除 AGENTS.md 中禁止使用其它设备的限制，并停止本任务子代理。

## 实测结果

1. 正常关闭：真实模型建立 shell 62348、后台任务 launcher 62362 与循环子进程 62365，保持运行后从设置页点击关闭。约 3.804 秒复查，DSH Node 与全部 Linux 进程消失，代际账本清空；截图证实先显示“正在释放 Linux 终端和后台任务”，清理完成后才显示“引擎已关闭”。这一轮使用同策略的前一包 `00e2e74d…`；最终包只清理了未使用的辅助接口，随后单测重跑并执行下列强杀测试。
2. 运行中切后台强杀（最终 APK）：模型自行建立新 shell 63135、任务 63162/63164。按 Home 后执行 Android `am force-stop`，约 0.656 秒复查，Java、引擎、终端、后台任务均消失。只重新打开应用，无手工修复、无重装，实例 ID 仍是 `debian-minimal-x64-mw2s05ze-5c2aa098-c1e5-4d52-886b-a4cbc410a0a5`。
3. 真实模型恢复验收：145 个 dpkg 包均为 ii，无半配置状态；`dpkg --audit` 无输出，`dpkg -C` 返回 0。gcc 14.2、Node 24.22.0、npm 11.19.1、zstd 1.5.7 可用；临时 C 程序实际编译、链接、运行成功；30 万字节数据经 zstd 压缩解压，cmp 和完整性检查通过。原 zstd 归档 SHA256 仍为 `e0ef89e6e184cbc63fbe5fb46b1481bb6797254da405fa885238f6cac4184e7c`，637 个原始源码文件未修改、未缺失。
4. 心跳任务确已退出：强杀后等待 35 秒，final-heartbeat.txt 保持 5 行不再增长；旧 PID 均不存在，会话列表为空。本轮检查使用临时目录并清理，无测试后台任务遗留。
5. 启动中强杀（最终 APK）：新引擎子进程出现约 5.099 秒时、HTTP 尚未应答即再次 force-stop；子进程退出。再次打开应用，状态路由 200、installed/enabled/activated=true、busy=false，页面正常显示，代际账本仅含当前一代。
6. 两类强杀后，同一实例、`/etc/os-release`、dpkg status 和原 zstd 归档的宿主独立 SHA256 校验均一致。应用实际仍指向 18793 回放服务器，其请求总数保持此前 10 条，最后请求是 08:00 的旧验收请求，本轮没有下载。18794 是另备的未使用 fixture，不能以其空请求代替实际下载证据。

## 代码层验证与边界

- Android JVM：OwnedEngineStopPolicyTest 18、GuideAndConsoleBatch6Test 27、GuidePaletteMonochromeTest 3，全部通过；最终 APK 从源码重新编译。
- 专用模拟器 Debian 内：宿主插件 69 项通过（含真实 Cordis/ToolRuntime/SystemPrompt、延迟恢复、停止竞态、信号退出）；bootstrap 15 项通过；runtime 聚焦集 61 项通过、1 项条件跳过，ownership marker / secret 隔离最终回归另外执行通过。
- 全量普通 Linux 主机进程域夹具在嵌套 Bionilux 环境的虚拟路径下失败，本轮不把它计为通过；本次通过的是上述聚焦测试与实际应用进程检查。包记录校验也不等于所有包文件逐字节校验；没有安装 debsums。
- API 鉴权、vendored bootstrap、执行地图及维护文档检查通过；APK 自包含工作树缺少上游只读 checkout 的发布门禁仍为 SKIP。
- 此次复用已安装 0.5.0 runtime，未替换用户已有 rootfs 或工具链。新的进程归属白名单已写入本仓源码及本地 runtime 资产（SHA256 `215c90510a29f9d3c9bf1826bc9a6521ebdee7ff002bb3344a17d5e613994a47`），经过 Debian 内源代码测试；未把新资产热推替换进旧安装。正式发布仍需按正常发布链输出对应 runtime Release；本地 Debug APK 不等于已发布正式版本。
- 本次未在 apt/dpkg 正进行安装时强杀，也未模拟设备断电；结论是所测运行中、启动中强杀未发现 Linux 环境损坏，不能外推为任何时刻都不会损坏。

原始证据在 `target/independent-linux/`：`lifecycle-close-audit.json`、`lifecycle-stopping.png`、`lifecycle-stopped.png`、`force-stop-process-audit.json`、`force-stop-during-startup.json`、两份 persistence audit、`force-stop-recovery-model-report.json`、`force-stop-actual-download-audit.json`、最终 UI 状态及截图。模型报告为证据之一，PID、摘要、下载计数另由宿主独立核对。
