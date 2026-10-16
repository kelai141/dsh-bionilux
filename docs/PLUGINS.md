# PLUGINS — 挂载、安装与运行设计

本文件是本轮实现的**设计记录**：两个实验性内部插件的边界、安装/启用流程、挂载与执行路径、
更新策略，以及“默认不启用”不变量。图与代码一一对应；实现细节见
[RELEASES.md](RELEASES.md) 与两个包的 README。

## 1. 组件与边界

```mermaid
flowchart TD
    A[DSH Mobile 壳 Bionic] --> B[DSH Core / Cordis / Bionic Node.js]
    A --> C[Termux Bash 基座 保持不变]
    A --> D[内置 hard 插件目录 随应用分发]

    D -->|已放入但默认未启用| E[实验性引导插件 linux-bootstrap]
    E --> F[用户启用后 设置 → Linux环境]
    E -->|confirmed + activate| G[实验性运行时插件 linux-runtime]

    G --> H[Runtime Manager 安装/健康/卸载]
    G --> I[linux_bash 仅在健康时注册]
    H --> J[Bionilux launcher + preload Release 资产]
    H --> K[Debian minimal rootfs Release 资产]
    H --> L[共享 glibc Node Release 资产]

    E --> M[linux-release.json 版本化清单]
    G --> M
```

* **host** 是 Android/壳（Bionic、应用私有目录）；**guest** 是 Debian 用户空间。
* 两个插件都是**我们自己的实验性内部插件**：**引导插件**随应用放入内置（hard）插件目录、
  但**默认不启用**（存在 ≠ 启用）；**运行时插件**与 Bionilux、rootfs、glibc Node 一样按需取自
  Release，不随应用分发。
* `linux-release.json`、rootfs、Node、Bionilux 全部是 **Release 附件**，不进 Git、不进 LFS。
* 壳提供 `linuxPluginHost` 适配器（加载/卸载插件目录、`isInjected`），并**承担字节获取与安全解包**
  ——`.tar.xz` 的解码在 Node 侧没有实现（Node 的 zlib 不含 xz，本仓也没有 xz/tar 依赖），而宿主
  已有加固实现（`SnapshotExtractor` 的穿越/符号链接逃逸/炸弹上限、`SnapshotBundledAsset.digest`
  的流式摘要 + 实读字节数），因此宿主负责下载与解包，**不复制**版本/状态/校验/激活事务。
* **所有权边界**：bootstrap 仍**拥有**版本解析、状态、完整性验收与激活；宿主产物（暂存区）不是
  可用性凭据，bootstrap 必须在激活前**自行复验**（重算保留归档的摘要，或校验解包树的
  `unpackedSize` + 入口 + 包名），`reused:true` 必须是复验结果而非假设。

### 1.1 资产准备的所有权（宿主取字节，bootstrap 复验）

引擎（Node/Cordis）侧**没有反向通道**调用宿主：壳是客户端，长轮询引擎的
`/api/android/ui/pending`，而那条队列是**设备控制队列**，其策略要求 `danger-full-access`。
把资产下载挂上去等于「装 Linux 必须先开设备控制档」，与用户要求相反；协议面又属逐字节镜像面。
因此采用**客户端触发**：

```mermaid
flowchart LR
    U[用户点击安装] --> C[客户端调宿主准备原语]
    C --> H[宿主: 来源白名单 https + 逐跳重定向校验 + SHA-256 与字节数]
    H --> X[宿主: 安全解包到 staging 内容寻址目录]
    X --> R[引擎侧 bootstrap: 按清单 sha256 自行定位并复验]
    R -->|通过| A[激活并注册 linux_bash]
    R -->|失败或缺失| F[失败关闭 不下载不激活]
```

* 落点由宿主按摘要推导，**调用方无法指定路径**；摘要与体量在任何文件系统操作前校验。
* 引擎侧**不接受调用方传入的暂存路径**：bootstrap 用自己清单里的 `sha256` 定位暂存目录。
* `downloadAsset` / `extractArchive` 在此形态下是**宿主透传/占位**，bootstrap 的该契约不变。

### 1.2 引导插件的客户端注册契约（跨包接口）

引导插件的 client 半边由 DSH Mobile 的 UI 宿主装载，宿主提供 `react` 与 `slots` 两个面，
并从 `settings.section` 槽位读回设置页条目。这是一条**跨仓接口**，因此钉进本仓测试
（`packages/linux-bootstrap/test/client.test.mjs`）：

* `inject` 必须同时声明 `slots` 与 `linuxBootstrap`——壳按声明的注入集决定槽位服务是否可见，
  其自带客户端插件（`dsh-client-ui-responsive`、`dsh-android-vdisplay`）也是这样声明的。
* 注册形态与壳现有先例一致：`ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'linux-environment', order, label: () => 'Linux环境' }, Section))`。
  注意 `sidebar.right.pane.tab` 用的是 `{ key, inject }`，**不是**本槽位的形态，不可照抄。
* 槽位注册返回 disposer，必须经 `ctx.effect(...)` 交给上下文，避免重载/卸载后残留入口。
* 设置入口的**唯一权威注册方**是引导插件的 client 半边；壳侧不再重复注册，避免双入口。

## 2. 安装与启用（默认不启用）

```mermaid
flowchart TD
    A[应用更新 / Linux 新版本发布] --> B[不自动启用插件]
    C[用户在设置中启用 Linux 环境] --> D[linuxBootstrap 服务可用]
    D --> E[设置页注册 Linux环境 入口]
    E --> F[手动检查更新 仅报告]
    F --> G{用户确认安装<br/>confirmed + activate}
    G -->|否| F
    G -->|是| H[读取并校验版本化清单]
    H --> I[校验 SHA-256 与大小]
    I --> J[安全解包到 staging 内容寻址目录]
    J --> K[pluginHost.install 加载运行时插件]
    K --> L[manager.install 暂存后端/rootfs/共享 Node]
    L --> M[健康检查通过后原子切换 active.json]
    M --> N[linux_bash 注册 环境就绪]
    L -->|失败| O[回滚插件 + 保留旧实例]
```

**不变量**：`K` 之前不存在任何 Linux 工具；`G` 是唯一启用路径；`A` 永不触发 `G`。

## 3. 挂载与执行

```mermaid
sequenceDiagram
    participant Ag as Agent
    participant T as linux_bash
    participant M as Runtime Manager
    participant B as Bionilux
    participant D as Debian bash
    Ag->>T: command / cwd / timeoutMs
    T->>M: execute()
    M->>M: 读健康状态 无则显式失败
    M->>M: 只继承白名单宿主变量
    M->>B: launcher + rootfs + guest PATH + host-path
    B->>D: 在 guest 内 /bin/bash -lc
    D-->>T: stdout / stderr / exitCode / timedOut
    T-->>Ag: 结果含 cwd 与 runtimeId
```

* “挂载”分两层：**插件装配**（由壳的注入目录决定）与 **guest 路径映射**（`--host-path` 原路径直通，
  不做内核 bind mount）。
* 工作目录规则：rootfs 内的路径映射为 guest 路径；**guest 命名空间之外**且宿主上确实存在的目录
  按原名直通可见；位于 guest 命名空间内（`/etc`、`/usr`、`/tmp` …）或宿主上不存在的路径一律按
  guest 语义处理——因为 launcher 会先按名解析已配置的宿主目录，把这些目录提升为直通会遮蔽
  guest 自己的同名子树。
* 共享 glibc Node 位于各 rootfs 之外，经 `BIONILUX_HOST_PATHS` 与 guest `PATH` 暴露，
  从而“一份 Node 多环境复用”。
* guest 路径缺失按 guest 语义失败，**绝不**回落到宿主同名路径；Linux 失败也**绝不**回退 Termux。

## 4. 两个 Bash 的区别（面向 Agent）

| 项目 | Termux Bash（既有） | Linux Bash（本系统） |
|---|---|---|
| 执行环境 | Android/Bionic 宿主 | Debian/glibc guest 用户空间 |
| 软件包 | Termux 包与 PREFIX | Debian `apt`/`dpkg` |
| Node.js | 宿主 Bionic Node | 共享 glibc Node（应用级一份） |
| 用途 | 手机侧任务、宿主路径 | 需要 Debian/glibc 的任务 |
| 失败策略 | 原链路不变 | 显式报错，不静默切换 |

rootfs 提供的是**运行环境支持**，不是安全沙箱；guest root 是用户态身份，不等于 Android root。

## 5. 更新策略（独立于应用发布）

```mermaid
flowchart TD
    A[服务启动] --> B{已安装 且 仍被注入<br/>且 开关开启}
    B -->|否| C[不做网络请求]
    B -->|是| D{应用版本与安装记录不同?}
    D -->|否| C
    D -->|是| E[检查一次 每个应用版本最多一次]
    E --> F{有更新的 Linux 版本?}
    F -->|是| G[自动安装并保留启用状态]
    F -->|否| C

    H[手动检查更新] --> I[总是查询]
    I --> J[只报告 updateAvailable]
    J --> K{用户确认}
    K -->|是| L[安装]
    K -->|否| J

    M[用户手工移除插件] --> N[isInjected=false 持久化]
    N --> O[自动更新失败关闭 绝不复活]
```

* 自动更新默认**关闭**；开关本身不触发检查。
* 降级被拒绝；相同版本需走“重新安装”。
* 插件版本与 Linux 系统版本独立于 DSH Mobile 应用版本演进。

## 6. 未验证项

真机端到端安装与 `isInjected` 行为属集成方；x86_64 未构建未验证；PTY/长会话未验证；
Debian rootfs 未固定镜像快照哈希。见 [STATUS.md](STATUS.md) §11。

两个插件**尚未**按注入链登记进 DSH Mobile 的内置（hard）插件目录——本仓是插件源码真源，登记与
装载仍在进行中；引导插件需要函数型 config，无法被 profile patch 挂载，因此由宿主在用户显式启用时
动态装载（见 [DECISIONS.md](DECISIONS.md) D-014）。
