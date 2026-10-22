# 调试构建与草稿发布

两个手动入口均编译 ARM64 与 x86_64，使用 cargo release 配置。
包含 Android/Bionic launcher、glibc preload、Debian 13 rootfs、匹配架构的 glibc Node，以及两份安装插件。
构建和 QEMU 检查不能替代 Android ARM64 真机验收。

## 调试构建

在 Actions 选择 **Debug dual-architecture build**，点击 Run workflow。
source_ref 可填分支、tag 或完整提交 SHA；留空使用所选工作流提交。

~~~sh
gh workflow run debug-build.yml \
  --repo kelai141/dsh-bionilux \
  -f source_ref=main
~~~

完成后下载该次运行的 **linux-assets** Artifact，保存 7 天。
也会保留 release-runtime-aarch64、release-runtime-x86_64 和 release-plugins 分组。
调试标识为 v<插件版本>-debug.<run_id>.<attempt>，无需建立 Git tag。
此入口只有 contents:read，不创建 Release，也不替换已有安装。
调试 manifest 中的 release 下载链接是占位的预期发布位置，Artifact 本身不是公开下载服务；
不能把其中的链接当成已经可下载安装的 Release URL。

## 草稿发布

在 Actions 选择 **Draft release**，填入 tag，例如 v0.5.0。
tag 去掉 v 后必须与 linux-bootstrap 和 linux-runtime 的 package.json 版本一致。
source_ref 与调试入口相同；整个运行固定为最初解析出的同一个提交。

默认从该提交的仓库根 notes.md 读取说明，也可以修改 notes_file 指定仓库内其他文件。
命令行直接传入本地文件内容：

~~~sh
gh workflow run release.yml \
  --repo kelai141/dsh-bionilux \
  -f source_ref=main \
  -f tag=v0.5.0 \
  -F notes=@notes.md
~~~

本地文件不需要先提交；-F 的 @ 语法由 gh 读取内容后提交到 notes 输入。
如果填写 notes，则优先使用其原文，不再读取 notes_file。
说明按 UTF-8 处理，不执行其中的反引号、$() 或其他 shell 内容。
GitHub workflow_dispatch 整体输入有大小限制，大文件应提交到仓库并使用 notes_file。

发布工作流复用同一双架构构建流程。两架构与插件全部成功、清单与校验和通过后，
自动上传到 **draft release**；不会自动公开发布，不会自动设置为 latest。
已有草稿或正式 Release 一律不覆盖；相同 tag 如已指向其他提交也拒绝继续。
要重新发布，请先明确处理旧草稿，或更新插件版本并使用新 tag。
公开发布由维护者在 GitHub 草稿页面审阅后手动决定。

## 产物与核验

linux-assets 与 draft release 包含：

- 两架构 launcher、preload、backend/rootfs/Node 归档。
- linux-bootstrap-plugin.tar.xz 与 linux-runtime-plugin.tar.xz。
- linux-release.json：双架构运行时及插件的下载地址、大小与 SHA-256。
- BUILD_INFO.json：实际源码 SHA、构建 tag、插件版本及 debug/release 模式。
- SHA256SUMS：全部其他产物的校验和。

下载后在产物目录运行：

~~~sh
sha256sum --check --strict SHA256SUMS
~~~

draft release 的下载链接仍受 GitHub 草稿可见性与认证约束；自动更新不会把草稿当公开稳定版。
普通 push、PR 和 tag 不再自动公开发布资产；CI 只运行验证。
