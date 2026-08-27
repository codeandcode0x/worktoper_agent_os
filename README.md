# WorkToper Agent OS

**WorkToper Agent OS** 是一个将 Linux 桌面、开发工具和智能助手整合到单一应用窗口中的开源桌面项目。它在 Electron 应用中运行隔离的 Debian Linux 环境，让用户可以像使用普通桌面系统一样运行终端、浏览器、编辑器和自动化工具。

[English](#english) · [MIT License](LICENSE)

<img src="docs/images/worktoper-agent-os.png" alt="WorkToper Agent OS 智能桌面" width="960">


### 项目背景

开发者经常需要在宿主机、容器、远程服务器和多个桌面工具之间切换。这样的工作流虽然灵活，但也带来了环境不一致、工具难以复现、窗口分散以及 Linux 图形应用使用门槛较高等问题。

WorkToper Agent OS 希望提供一个更直接的工作空间：应用负责窗口和交互，Linux VM 负责真实的系统环境，智能助手和开发工具在同一个可视化桌面中协同工作。用户无需把宿主机改造成 Linux，也不必依赖浏览器中的 wasm 模拟器，就可以获得一个可持久化、可交互的 Linux 桌面。

### 智能桌面

项目的核心体验是一个可嵌入应用窗口的 Linux 智能桌面：

- 启动时展示真实的 Linux 启动日志和进度。
- 在同一个窗口中运行 XFCE 图形桌面、终端和 GUI 应用。
- 支持宿主机与 Linux 桌面之间的文字剪贴板同步。
- 支持共享目录，将宿主机文件挂载到 Linux 工作空间。
- 可通过 Agent Robot 和桌面内的快捷入口启动自动化任务与开发工具。

### 主要功能

- **隔离的 Linux 工作环境**：使用 Debian VM 保存系统、软件和用户数据，避免污染宿主机。
- **桌面化交互**：通过 noVNC 在 Electron 窗口中显示并操作 Linux 桌面。
- **开发工具**：支持终端、Chromium、VSCodium，以及在 VM 内安装的其他 Linux 软件。
- **软件包管理**：可以在 Linux 终端中使用 `apt-get` 安装和更新软件。
- **持久化磁盘**：Linux 环境使用 qcow2 磁盘，重启应用后保留用户配置和文件。
- **跨平台桌面壳**：目标平台为 macOS、Windows 和 Linux x64。
- **启动容错**：Guest Agent 断线时会自动重连；桌面显示提供串口启动和 VNC 探测兜底，不会无限停留在启动进度中。

### 使用场景

#### 统一的开发工作区

在 macOS 或 Windows 上获得一个稳定的 Debian 开发环境，运行 Linux CLI、编译工具、浏览器和编辑器，同时保留宿主机的窗口管理和文件访问能力。

#### AI Agent 与自动化任务

为 Agent 提供一个可观察、可交互的 Linux 桌面。用户可以看到任务执行过程，也可以随时打开终端检查状态或手动接管。

#### 教学、演示和实验

用一个可分发的桌面应用展示 Linux 启动、系统服务、图形桌面和软件安装过程，适合课程、技术演示和原型验证。

#### 安全的临时环境

将不确定的脚本、工具链或实验依赖放入独立 VM 中运行，减少对宿主机开发环境的影响。正式使用前仍应根据实际威胁模型配置权限和网络策略。

### 核心技术

项目采用较薄的桌面应用层和独立的 Linux 虚拟机层：

```text
Electron
  └─ VM Manager
      └─ QEMU
          └─ Debian qcow2 + systemd + XFCE
              ├─ noVNC / WebSocket：图形桌面
              ├─ xterm.js：启动日志与 Linux 终端
              └─ QEMU Guest Agent：桌面集成与系统操作
```

Electron 负责窗口、设置、IPC 和桌面编排；QEMU 负责运行 Linux；Debian VM 内的 systemd、LightDM、XFCE、x11vnc 和 Agent Robot 提供实际系统能力。详细实现可从 `desktop/`、`components/web-os/` 和 `lib/desktop-linux.ts` 开始阅读。

### 快速开始

#### 环境要求

- Node.js 20 或更高版本。
- Corepack 和 pnpm 10.15.0。
- macOS 14+、Windows x64 或 Linux x64。
- 运行应用时通常不需要单独安装 QEMU；仓库和发行包可以携带对应运行时。

#### 安装依赖

```bash
corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm install
```

#### 构建和开发运行

```bash
pnpm build
pnpm desktop:dev
```


默认镜像用户为 `worktoper`，密码为 `worktoper`；root 密码为 `root`。镜像中的软件由 `scripts/prepare-vm.mjs` 和 cloud-init 配置。

#### 打包

```bash
pnpm dist:mac
pnpm dist:win
pnpm dist:linux
```

对应产物为：

- macOS：DMG 和 ZIP。
- Windows：NSIS 安装包和 portable 包。
- Linux：AppImage 和 deb。

正式发布 macOS 应用时，还需要 Apple Developer ID 签名和 notarization。


应用设置中还可以选择共享目录。共享目录会挂载到 Linux VM 的 `/home/worktoper/Shared`。

### 项目结构

```text
app/                  Next.js 页面入口
components/web-os/    智能桌面 UI、终端和嵌入式桌面
desktop/              Electron 主进程、IPC 和 VM Manager
lib/                  前端运行时与 Electron bridge 封装
scripts/              VM 镜像准备和运行时打包脚本
runtime/              QEMU、Electron、tar 等平台运行时
images/               应用图标和桌面背景
```

### 开发说明

- 前端使用 Next.js、React 和 TypeScript，桌面壳使用 Electron。
- Linux 图形桌面通过 noVNC 连接到 VM 内的 x11vnc。
- Linux 命令、APT 安装和 GUI 应用都运行在 VM 内，不依赖宿主机的 Linux、Docker 或 SSH 服务端。
- 运行时二进制和第三方组件可能有各自的许可证，请同时阅读 `runtime/THIRD_PARTY.md`。

### 参与贡献

欢迎提交 Issue、改进文档、修复 bug 和贡献代码。建议在提交前：

```bash
pnpm build
node --check desktop/vm-manager.cjs
git diff --check
```

如果修改了 VM 启动流程，请同时验证至少一种 Guest Agent 正常路径和一种断线/不可用兜底路径。

### 开源协议

本项目源代码使用 [MIT License](LICENSE) 发布。MIT 协议允许在保留版权和许可声明的前提下使用、复制、修改、合并、发布、再许可和销售软件。

---


### Background

Developers often move between a host operating system, containers, remote servers, and scattered desktop tools. This makes environments harder to reproduce and makes Linux GUI workflows less approachable on macOS or Windows.

WorkToper Agent OS provides one visual workspace instead: Electron owns the desktop shell, while a real Debian Linux VM owns the system environment. Development tools, terminal commands, GUI applications, and agent workflows can run together inside the same interactive desktop without turning the host machine into a Linux system or relying on a browser-based wasm emulator.

### Smart desktop

The main experience is an embedded Linux smart desktop:

- Real Linux boot logs and progress are visible during startup.
- XFCE, a terminal, and GUI applications run inside the same application window.
- Text clipboard synchronization works in both directions between the host and Linux desktop.
- A host directory can be mounted into the Linux workspace.
- Agent Robot and desktop shortcuts can launch automation tasks and development tools.

### Features

- **Isolated Linux workspace**: Debian runs in a VM so packages and system changes stay separate from the host.
- **Desktop interaction**: noVNC displays and controls the Linux desktop inside Electron.
- **Developer tools**: terminal, Chromium, VSCodium, and other Linux applications installed in the VM.
- **Package management**: use `apt-get` directly in the Linux terminal.
- **Persistent storage**: a qcow2 disk keeps user files and configuration across restarts.
- **Cross-platform shell**: targets macOS, Windows, and Linux x64.
- **Startup recovery**: Guest Agent reconnects automatically; serial and VNC readiness fallbacks prevent an endless boot wait.

### Use cases

- **Consistent development workspace**: use a reproducible Debian environment on macOS or Windows while keeping host window management and file access.
- **AI agents and automation**: provide agents with an observable Linux desktop that users can inspect or take over.
- **Teaching and demos**: demonstrate Linux boot, services, GUI applications, and package installation from one distributable app.
- **Temporary experimentation**: keep uncertain scripts, toolchains, and dependencies inside a separate VM. Apply your own security and network policy for production use.

### Core technology

```text
Electron
  └─ VM Manager
      └─ QEMU
          └─ Debian qcow2 + systemd + XFCE
              ├─ noVNC / WebSocket: graphical desktop
              ├─ xterm.js: boot logs and Linux terminal
              └─ QEMU Guest Agent: desktop integration and system operations
```

Electron handles the window, settings, IPC, and desktop orchestration. QEMU runs Linux, while systemd, LightDM, XFCE, x11vnc, and Agent Robot provide the guest-side capabilities. Start exploring the implementation in `desktop/`, `components/web-os/`, and `lib/desktop-linux.ts`.

### Quick start

#### Requirements

- Node.js 20 or newer.
- Corepack and pnpm 10.15.0.
- macOS 14+, Windows x64, or Linux x64.
- QEMU is normally bundled for application runtime; the repository and release packages can carry platform-specific runtimes.

#### Install dependencies

```bash
corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm install
```

#### Build and run in development

```bash
pnpm build
pnpm desktop:dev
```

If no VM image exists yet, prepare a Debian image:

```bash
pnpm vm:prepare
```

The default image uses `worktoper` / `worktoper` for the regular user and `root` for root. Image provisioning is defined by `scripts/prepare-vm.mjs` and cloud-init.

#### Package the application

```bash
pnpm dist:mac
pnpm dist:win
pnpm dist:linux
```

The targets are DMG/ZIP for macOS, NSIS/portable for Windows, and AppImage/deb for Linux. macOS distribution additionally requires Apple Developer ID signing and notarization.


The settings UI can also select a shared host directory. It is mounted at `/home/worktoper/Shared` inside the Linux VM.

### Project layout

```text
app/                  Next.js entry points
components/web-os/    Smart desktop UI, terminal, and embedded display
desktop/              Electron main process, IPC, and VM Manager
lib/                  Frontend runtime and Electron bridge wrappers
scripts/              VM image preparation and runtime bundling
runtime/              QEMU, Electron, tar, and platform runtimes
images/               Application icons and desktop backgrounds
```

### Development notes

- The frontend uses Next.js, React, and TypeScript; the desktop shell uses Electron.
- The Linux graphical desktop is connected through noVNC to x11vnc inside the VM.
- Linux commands, APT installation, and GUI applications run in the VM rather than requiring Linux, Docker, or an SSH server on the host.
- Bundled runtimes and third-party components may carry separate licenses; see `runtime/THIRD_PARTY.md`.

### Contributing

Issues, documentation improvements, bug fixes, and code contributions are welcome. Before opening a change, run:

```bash
pnpm build
node --check desktop/vm-manager.cjs
git diff --check
```

Changes to VM startup should be checked against both the normal Guest Agent path and at least one Guest Agent recovery path.

### License

The project source is released under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, sublicense, and sell the software as long as the copyright and license notice are preserved.
