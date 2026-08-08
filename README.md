# WorkToper Agent OS

WorkToper Agent OS 是一个桌面应用形态的 Linux OS。应用本身使用 Electron 打开，内部由 QEMU 启动一个完整 Linux VM，并通过 noVNC 把 Linux 图形桌面嵌入应用窗口。终端窗口连接 QEMU 串口 `ttyS0`，应用打开后会显示真实的 BIOS、Linux kernel、systemd/getty 启动日志。

当前架构不再把 VS Code/Chrome 做成 Web 外链，也不再使用 v86/Buildroot。Linux 命令、APT 安装、GUI 应用都运行在 VM 内。

```text
Electron desktop app
  -> QEMU VM manager
  -> Debian qcow2 disk
  -> APT + systemd + XFCE
  -> QEMU VNC WebSocket -> noVNC window
  -> QEMU serial ttyS0 -> xterm.js boot console
```

## 能力

- Windows、macOS、Linux 都以桌面应用方式打开。
- 启动真实 Linux VM，不依赖本机 Ubuntu、Docker、SSH 服务端或浏览器 wasm Linux。
- Linux 桌面在应用内部显示，可运行图形应用。
- 终端显示完整启动日志，并可直接对串口 shell 输入命令。
- VM 内使用 Debian `apt-get` 安装软件。
- 默认开源组合建议为 Chromium + VSCodium；启动命令也会优先尝试 `google-chrome` / `code`，如果用户在 VM 内按各自许可安装了官方包，会直接打开官方应用。

## 依赖

本地开发需要：

- Node.js + Corepack
- QEMU：`qemu-system-x86_64` 和 `qemu-img`
- 生成 cloud-init seed ISO 的工具之一：
  - macOS：系统自带 `hdiutil`
  - Linux：`cloud-localds`、`genisoimage`、`mkisofs` 或 `xorriso`
  - Windows：建议安装 QEMU 后再安装 `genisoimage`/`xorriso`，或直接使用预构建的 `seed-x64.iso`

正式发布时，应把对应平台的 QEMU 二进制放到：

```text
runtime/qemu/darwin/qemu-system-x86_64
runtime/qemu/win32/qemu-system-x86_64.exe
runtime/qemu/linux/qemu-system-x86_64
```

也可以用环境变量指定：

```bash
WORKTOPER_QEMU=/absolute/path/to/qemu-system-x86_64
```

## 准备 VM 镜像

```bash
corepack prepare pnpm@10.15.0 --activate
corepack pnpm@10.15.0 install
corepack pnpm@10.15.0 vm:prepare
```

`vm:prepare` 会下载 Debian cloud qcow2，创建：

```text
runtime/images/worktoper-agent-os-x64.qcow2
runtime/images/seed-x64.iso
```

默认 cloud-init 会安装 XFCE、Chromium、VSCodium、常用 CLI 工具，并配置：

```text
用户: worktoper / worktoper
root: worktoper
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

如果 Electron 下载慢：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ corepack pnpm@10.15.0 desktop:dev
```

启动后会自动启动 VM。Linux 图形桌面在“Linux 桌面”窗口显示，启动日志和命令交互在“终端”窗口显示。

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

- Electron 应用只负责桌面壳、VM 管理、串口和 VNC 显示。
- Linux 系统保存在 qcow2 磁盘里，支持持久化。
- 首次启动会执行 cloud-init 安装桌面软件，耗时取决于网络和机器性能；之后直接从持久磁盘启动。
- QEMU 优先使用硬件加速：macOS HVF、Linux KVM、Windows WHPX；不可用时回落 TCG。
- 可以通过环境变量调整资源：

```bash
WORKTOPER_VM_MEMORY=6144
WORKTOPER_VM_CPUS=4
WORKTOPER_VM_IMAGE=/absolute/path/to/worktoper-agent-os-x64.qcow2
```

## 商用合规

核心方案使用开源组件：

- QEMU：GPLv2
- Debian：Debian Free Software Guidelines 发行版，包许可证各不相同
- noVNC：MPL-2.0
- Chromium：开源浏览器项目
- VSCodium：基于 VS Code 源码构建的开源发行版

Google Chrome 和 Microsoft VS Code 官方 Linux 二进制不是默认开源组件。若产品必须“开源且可商用友好”，默认使用 Chromium + VSCodium；若必须使用官方 Chrome/VS Code，需要在发行和安装流程中单独处理它们的许可条款。
