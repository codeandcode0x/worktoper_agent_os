<div align="center">
  <img src="images/icons/icon.svg" alt="WorkToper Agent OS icon" width="128" height="128">
  <h1>WorkToper Agent OS</h1>
  <p><strong>Work With AI Agent</strong></p>
  <p>Bring your AI Agent into a real, interactive Linux workspace.<br>Build, automate, and get things done in one desktop.</p>
  <img src="docs/images/worktoper-agent-os.png" alt="WorkToper Agent OS smart desktop" width="1100">
</div>

[中文](README.zh-CN.md) · [Website](https://www.worktoper.com/agent-os) · [Download](https://www.worktoper.com/agent-os/downloads?lang=en) · [MIT License](LICENSE)


## A desktop that works with your AI Agent

WorkToper Agent OS brings your AI Agent, a real Linux environment, and everyday development tools into one desktop. Watch what the agent is doing, inspect the Linux terminal, or take over manually whenever you need to.

It is designed for people who want real Linux capabilities without switching hosts or maintaining a complicated remote setup: isolated, persistent, and ready for daily work.

Release packages include QEMU, firmware, runtime libraries, and the VM archive tool for their target platform. End users do not install QEMU, tar, or other host runtime dependencies; the application downloads and installs the Linux VM image automatically on first launch.

### What you can do

- Use an isolated Debian workspace on macOS, Windows, or Linux.
- Run AI agents inside an observable and interactive Linux desktop.
- Launch a terminal, Chromium, VSCodium, and other Linux GUI applications.
- Install packages with APT and access host files through a shared directory.
- Synchronize text clipboard content between the host and Linux desktop.

### Smart desktop experience

Boot logs, the Linux terminal, the graphical desktop, and Agent Robot work together in one application. Desktop windows support keyboard, mouse, clipboard, and familiar development workflows.

<div align="center">
  <img src="docs/images/worktoper-agent-os-2.png" alt="WorkToper Agent OS with development tools and AI Agent" width="1100">
</div>

### Core technology

Electron provides the desktop shell. QEMU runs a Debian Linux VM, while noVNC and xterm.js provide the embedded graphical desktop and terminal. QEMU Guest Agent handles desktop integration and system operations; a qcow2 disk keeps the workspace persistent.

```text
Electron → QEMU → Debian Linux VM
                    ├─ XFCE / x11vnc: graphical desktop
                    ├─ noVNC: embedded display
                    └─ xterm.js: boot log and terminal
```

### Quick start

The following requirements apply only to source development: Node.js 20+, Corepack, pnpm 10.15.0, and macOS x64, Windows x64, or Linux x64. End users installing a release package do not need these development dependencies.

```bash
corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm install
pnpm build
pnpm desktop:dev
```

Prepare a Debian VM image when needed:

```bash
pnpm vm:prepare
```

### Packaging

```bash
pnpm dist:mac
pnpm dist:win
pnpm dist:linux
```

Linux builds produce AppImage and deb packages; macOS produces DMG and ZIP; Windows produces NSIS and portable packages. macOS distribution additionally requires signing and notarization.

Packaging validates the bundled QEMU executable, firmware, runtime libraries, and archive tool both before packaging and in the unpacked application. A missing target runtime stops the build.

### Project structure

```text
app/                  Next.js page entry
components/web-os/    Smart desktop UI, terminal, and embedded desktop
desktop/              Electron main process, IPC, and VM Manager
lib/                  Frontend runtime and Electron bridge
scripts/              VM image preparation and runtime scripts
runtime/              QEMU, Electron, and platform runtimes
docs/images/          README screenshots
```

### Contributing

Issues, documentation improvements, bug fixes, and code contributions are welcome. Before submitting a change, run:

```bash
pnpm build
node --check desktop/vm-manager.cjs
git diff --check
```


Runtime binaries and third-party components may have their own licenses; see `runtime/THIRD_PARTY.md` as well.

### License

The project source is released under the [MIT License](LICENSE). QEMU, Debian, noVNC, Electron, Chromium, VSCodium, and other dependencies remain subject to their own licenses.
