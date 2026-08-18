# WorkToper Agent OS

WorkToper Agent OS 是一个桌面应用形态的 Linux OS。应用本身使用 Electron 打开，内部由 QEMU 启动一个完整 Linux VM，并在同一个应用窗口内提供可交互 Linux 桌面。开机画面显示真实的 BIOS、Linux kernel、systemd/getty 启动日志，终端窗口进入可交互 Linux shell。

当前架构不再把 VS Code/Chrome 做成 Web 外链，也不再使用 v86/Buildroot。Linux 命令、APT 安装、GUI 应用都运行在 VM 内。

```text
Electron desktop app
  -> QEMU VM manager
  -> Debian qcow2 disk
  -> APT + systemd + XFCE
  -> QEMU embedded desktop display
  -> QEMU serial ttyS0 -> xterm.js boot console
```

## 能力

- Windows、macOS、Linux 都以桌面应用方式打开。
- 启动真实 Linux VM，不依赖本机 Ubuntu、Docker、SSH 服务端或浏览器 wasm Linux。
- Linux 桌面在应用窗口内显示，可直接交互并运行图形应用。
- Linux 桌面开机画面显示完整启动日志；终端窗口只显示可交互 Linux shell 和用户命令输出。
- VM 内使用 Debian `apt-get` 安装软件。
- 默认开源组合建议为 Chromium + VSCodium；启动命令也会优先尝试 `google-chrome` / `code`，如果用户在 VM 内按各自许可安装了官方包，会直接打开官方应用。

## 依赖

### 运行依赖

正式发布包需要提供一个可运行的 QEMU 环境。应用启动时会按下面顺序查找：

1. 环境变量指定的二进制。
2. 应用随包二进制：`runtime/qemu/...`、`runtime/tools/...`。
3. 用户系统已经安装并在常见目录或 `PATH` 中的二进制。

如果第 2 项随包齐全，普通用户不需要额外安装 QEMU 或解压工具。

仓库当前已经包含三个平台的 x86_64 运行时及其完整依赖。`dist:mac`、`dist:win`、`dist:linux` 均固定构建 x64 安装包，并且每个平台的安装包只携带自己的运行时目录。macOS 内置 QEMU 的最低系统版本是 macOS 14。

| 平台 | 启动 Linux 桌面必需 | 首次下载镜像后解压必需 | 加速能力 |
| --- | --- | --- | --- |
| macOS | `qemu-system-x86_64` | `tar` 或 `bsdtar`，需支持 `.tar.xz` | HVF，系统自带 |
| Windows | `qemu-system-x86_64.exe` | `tar.exe` 或 `bsdtar.exe`，需支持 `.tar.xz` | WHPX，可选；没有时回落 TCG |
| Linux | `qemu-system-x86_64` | `tar` 或 `bsdtar`，需支持 `.tar.xz` | KVM，可选；没有时回落 TCG |

建议随应用打包的目录：

```text
runtime/qemu/darwin/qemu-system-x86_64
runtime/qemu/darwin/qemu-img
runtime/qemu/win32/qemu-system-x86_64.exe
runtime/qemu/win32/qemu-img.exe
runtime/qemu/linux/qemu-system-x86_64
runtime/qemu/linux/qemu-img

runtime/tools/darwin/tar
runtime/tools/win32/tar.exe
runtime/tools/linux/tar
```

QEMU 需要按平台打包成可独立运行的目录。当前 Windows 目录已经包含所需 DLL，macOS 目录已经改写为应用内相对动态库路径，Linux 目录包含静态启动器、musl 加载器和共享库闭包。不能只复制一个依赖开发机系统库的 QEMU 主程序。

macOS/Linux 下这些二进制需要保留可执行权限：

```bash
chmod +x runtime/qemu/darwin/qemu-system-x86_64 runtime/qemu/darwin/qemu-img runtime/tools/darwin/tar
chmod +x runtime/qemu/linux/qemu-system-x86_64 runtime/qemu/linux/qemu-img runtime/tools/linux/tar
```

同一平台需要区分宿主机 CPU 架构时，也支持：

```text
runtime/qemu/darwin-arm64/qemu-system-x86_64
runtime/qemu/darwin/arm64/qemu-system-x86_64
runtime/tools/win32-x64/tar.exe
runtime/tools/linux/x64/tar
```

可用环境变量覆盖默认查找：

```bash
WORKTOPER_QEMU=/absolute/path/to/qemu-system-x86_64
WORKTOPER_TAR=/absolute/path/to/tar
```

### 制作镜像依赖

只有运行 `vm:prepare` 重新制作镜像时才需要这些工具：

- Node.js + Corepack
- QEMU：`qemu-system-x86_64` 和 `qemu-img`
- 生成 cloud-init seed ISO 的工具之一：
  - macOS：系统自带 `hdiutil`
  - Linux：`cloud-localds`、`genisoimage`、`mkisofs` 或 `xorriso`
  - Windows：建议安装 QEMU 后再安装 `genisoimage`/`xorriso`，或直接使用预构建的 `seed-x64.iso`

`vm:prepare` 同样会优先使用 `runtime/qemu/<platform>/qemu-img` 和 `runtime/qemu/<platform>/qemu-system-x86_64`。ISO 工具也可以放在 `runtime/tools/<platform>/`，或通过环境变量指定：

```bash
WORKTOPER_QEMU=/absolute/path/to/qemu-system-x86_64
WORKTOPER_QEMU_IMG=/absolute/path/to/qemu-img
WORKTOPER_GENISOIMAGE=/absolute/path/to/genisoimage
WORKTOPER_MKISOFS=/absolute/path/to/mkisofs
WORKTOPER_XORRISO=/absolute/path/to/xorriso
WORKTOPER_CLOUD_LOCALDS=/absolute/path/to/cloud-localds
```

## 准备 VM 镜像

```bash
corepack prepare pnpm@10.15.0 --activate
corepack pnpm@10.15.0 install
corepack pnpm@10.15.0 vm:prepare
```

`vm:prepare` 会下载 Debian cloud qcow2，并把 VM 资产创建到应用默认数据目录：

```text
macOS: ~/Library/Application Support/WorkToper Agent OS/vm/
Windows: %APPDATA%\WorkToper Agent OS\vm\
Linux: ~/.config/WorkToper Agent OS/vm/

worktoper-agent-os-x64.qcow2
seed-x64.iso
```

应用包不携带 qcow2 镜像。需要自定义镜像目录时可以设置 `WORKTOPER_VM_ASSETS_DIR` 后再运行 `vm:prepare`；运行应用时可以用 `WORKTOPER_VM_IMAGE` / `WORKTOPER_VM_SEED` 指定绝对路径。

默认 cloud-init 会安装 XFCE、Chromium、VSCodium、常用 CLI 工具，并配置：

```text
用户: worktoper / worktoper
root: root
串口: ttyS0 root 自动登录
桌面: lightdm 自动登录 worktoper
```

如果你接受 Google Chrome 和 Microsoft VS Code 官方二进制许可，可以显式启用：

```bash
WORKTOPER_ALLOW_PROPRIETARY=1 corepack pnpm@10.15.0 vm:prepare
```

## 编译

```bash
corepack pnpm@10.15.0 build
```

## 运行

开发方式打开桌面应用：

```bash
corepack pnpm@10.15.0 desktop:dev
```

启动后会自动启动 VM。应用先全屏显示启动日志；Boot 100% 后，Linux 图形桌面会在同一个应用窗口中可交互运行，命令交互在应用内“终端”窗口显示。

## 打包

当前系统目录包：

```bash
corepack pnpm@10.15.0 desktop:pack
```

安装包：

```bash
corepack pnpm@10.15.0 dist:mac
corepack pnpm@10.15.0 dist:win
corepack pnpm@10.15.0 dist:linux
```

建议分别在目标平台打包：

- Windows：NSIS 安装包和 portable 包。
- macOS：dmg 和 zip。正式分发需要 Apple Developer ID 签名与 notarization。
- Linux：AppImage 和 deb。

打包命令只使用 `runtime/electron` 中预置的 macOS、Windows、Linux x86_64 Electron 发行包，不会在构建期间重新下载 Electron，也支持在 macOS 上生成三个平台的 x64 安装包。

每个平台的安装包都包含对应的 QEMU、QEMU 固件、动态库和 tar 工具。用户安装后不需要另行安装 Homebrew、QEMU、tar 或其他宿主机运行依赖。

## 使用 Linux

终端中可以直接运行：

```bash
whoami
uname -a
apt-cache policy
sudo apt-get update
sudo apt-get install -y git curl build-essential
```

打开 GUI 应用：

```bash
worktoper-open-browser
worktoper-open-code
```

Dock 中的 Chrome/VS Code 图标会向 VM 发送对应启动命令，实际窗口显示在 Linux 桌面窗口里。

## 轻量化策略

- Electron 应用只负责桌面壳、VM 管理、串口日志和应用启动控制。
- Linux 系统保存在应用默认数据目录的 qcow2 磁盘里，支持持久化，不随应用包一起打包。
- Linux 镜像是唯一与应用分离的外部文件；本地不存在镜像时，应用按配置的镜像地址下载并解压，之后直接从持久磁盘启动。
- VS Code、Chrome、Layan、Papirus、x11vnc 和锁屏组件必须预装在镜像中，应用启动后不会联网补装桌面依赖。
- QEMU 优先使用硬件加速：macOS HVF、Linux KVM、Windows WHPX；不可用时回落 TCG。
- 可以通过环境变量调整资源：

```bash
WORKTOPER_VM_MEMORY=6144
WORKTOPER_VM_CPUS=4
WORKTOPER_VM_IMAGE=/absolute/path/to/worktoper-agent-os-x64.qcow2
WORKTOPER_DISPLAY_MODE=embedded
```

## 商用合规

核心方案使用开源组件：

- QEMU：GPLv2
- Debian：Debian Free Software Guidelines 发行版，包许可证各不相同
- noVNC：MPL-2.0
- Chromium：开源浏览器项目
- VSCodium：基于 VS Code 源码构建的开源发行版

Google Chrome 和 Microsoft VS Code 官方 Linux 二进制不是默认开源组件。若产品必须“开源且可商用友好”，默认使用 Chromium + VSCodium；若必须使用官方 Chrome/VS Code，需要在发行和安装流程中单独处理它们的许可条款。
