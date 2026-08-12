#!/usr/bin/env node
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const arch = process.env.WORKTOPER_VM_ARCH || (process.arch === "arm64" ? "arm64" : "x64")
function defaultVmDir() {
  if (process.env.WORKTOPER_VM_ASSETS_DIR) return path.resolve(process.env.WORKTOPER_VM_ASSETS_DIR)
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "WorkToper Agent OS", "vm")
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "WorkToper Agent OS", "vm")
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "WorkToper Agent OS", "vm")
}

const runtimeDir = defaultVmDir()
const legacyRuntimeDir = path.join(root, "runtime", "images")
const imageUrls = {
  x64: process.env.WORKTOPER_BASE_IMAGE_URL || "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2",
  arm64: process.env.WORKTOPER_BASE_IMAGE_URL || "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2",
}
const baseImage = path.join(runtimeDir, `debian-bookworm-base-${arch}.qcow2`)
const legacyBaseImage = path.join(legacyRuntimeDir, `debian-bookworm-base-${arch}.qcow2`)
const vmImage = path.join(runtimeDir, `worktoper-agent-os-${arch}.qcow2`)
const seedIso = path.join(runtimeDir, `seed-${arch}.iso`)
const seedDir = path.join(runtimeDir, `seed-${arch}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  }
}

function which(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  if (result.status !== 0) return ""
  return result.stdout.split(/\r?\n/).find(Boolean) || ""
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    const part = `${target}.part`
    fs.rmSync(part, { force: true })
    const file = fs.createWriteStream(part)
    let lastPrinted = -1
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close()
        fs.rmSync(part, { force: true })
        download(new URL(response.headers.location, url).toString(), target).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        file.close()
        fs.rmSync(part, { force: true })
        reject(new Error(`Download failed: HTTP ${response.statusCode} ${url}`))
        return
      }
      const total = Number(response.headers["content-length"] || 0)
      let done = 0
      response.on("data", (chunk) => {
        done += chunk.length
        if (total) {
          const percent = Math.floor((done / total) * 100)
          if (percent === 100 || percent >= lastPrinted + 5) {
            lastPrinted = percent
            console.log(`Downloading Debian cloud image ${percent}%`)
          }
        }
      })
      response.pipe(file)
      file.on("finish", () => {
        file.close()
        fs.renameSync(part, target)
        resolve()
      })
    })
    request.on("error", (error) => {
      file.close()
      fs.rmSync(part, { force: true })
      reject(error)
    })
  })
}

function writeSeedFiles() {
  fs.rmSync(seedDir, { recursive: true, force: true })
  fs.mkdirSync(seedDir, { recursive: true })

  const userData = `#cloud-config
hostname: worktoper-agent-os
manage_etc_hosts: true
disable_root: false
ssh_pwauth: true
chpasswd:
  expire: false
  users:
    - { name: root, password: root, type: text }
    - { name: worktoper, password: worktoper, type: text }
users:
  - default
  - name: worktoper
    gecos: WorkToper
    groups: sudo,adm,audio,video,plugdev
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
bootcmd:
  - mkdir -p /var/lib/lightdm/data /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local/share /run/lightdm /var/log/lightdm
package_update: true
package_upgrade: false
packages:
  - sudo
  - curl
  - wget
  - ca-certificates
  - gnupg
  - git
  - dbus-x11
  - kbd
  - lightdm
  - xfce4
  - xfce4-terminal
  - xfce4-screensaver
  - light-locker
  - xterm
  - x11-xserver-utils
  - x11vnc
  - xserver-xorg-video-all
  - xserver-xorg-input-all
  - xserver-xorg-video-vesa
  - xserver-xorg-video-fbdev
  - xserver-xorg-video-qxl
  - chromium
  - fonts-noto
  - fonts-noto-cjk
  - qemu-guest-agent
write_files:
  - path: /usr/local/sbin/worktoper-install-vscode
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      if command -v code >/dev/null 2>&1; then exit 0; fi
      arch=$(dpkg --print-architecture)
      install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
      curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor >/tmp/worktoper-packages-microsoft.gpg
      install -m 0644 /tmp/worktoper-packages-microsoft.gpg /usr/share/keyrings/packages.microsoft.gpg
      printf 'deb [arch=%s signed-by=/usr/share/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main\n' "$arch" >/etc/apt/sources.list.d/vscode.list
      DEBIAN_FRONTEND=noninteractive apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y code
  - path: /usr/local/sbin/worktoper-install-chrome
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      if command -v google-chrome >/dev/null 2>&1; then exit 0; fi
      arch=$(dpkg --print-architecture)
      [ "$arch" = amd64 ] || exit 1
      install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor >/tmp/worktoper-google-linux.gpg
      install -m 0644 /tmp/worktoper-google-linux.gpg /usr/share/keyrings/google-linux-keyring.gpg
      printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main\n' >/etc/apt/sources.list.d/google-chrome.list
      DEBIAN_FRONTEND=noninteractive apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable
  - path: /etc/systemd/system/serial-getty@ttyS0.service.d/override.conf
    permissions: "0644"
    content: |
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin root --keep-baud 115200,38400,9600 %I $TERM
  - path: /etc/systemd/system/serial-getty@ttyS1.service.d/override.conf
    permissions: "0644"
    content: |
      [Service]
      ExecStart=
      ExecStart=-/sbin/agetty --autologin root --keep-baud 115200,38400,9600 %I $TERM
  - path: /etc/lightdm/lightdm.conf.d/50-worktoper-autologin.conf
    permissions: "0644"
    content: |
      [Seat:*]
      autologin-user=worktoper
      autologin-user-timeout=0
      user-session=xfce
  - path: /etc/ssh/sshd_config.d/99-worktoper-password-login.conf
    permissions: "0644"
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
  - path: /usr/local/bin/worktoper-open-code
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      export XDG_RUNTIME_DIR=/run/user/1000
      export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
      [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority
      cd /home/worktoper
      if ! command -v code >/dev/null 2>&1; then
        install_pid=''
        [ -f /tmp/worktoper-vscode-install.pid ] && install_pid=$(cat /tmp/worktoper-vscode-install.pid 2>/dev/null || true)
        if [ -z "$install_pid" ] || ! kill -0 "$install_pid" >/dev/null 2>&1; then
          nohup /usr/local/sbin/worktoper-install-vscode >/tmp/worktoper-install-vscode.log 2>&1 & echo $! >/tmp/worktoper-vscode-install.pid
        fi
        if command -v xterm >/dev/null 2>&1; then
          exec xterm -T 'Installing VS Code' -e sh -lc 'while ! command -v code >/dev/null 2>&1; do clear; echo "正在安装 Microsoft VS Code，请稍候..."; echo; tail -n 22 /tmp/worktoper-install-vscode.log 2>/dev/null || true; sleep 3; done; exec code --no-sandbox'
        fi
        while ! command -v code >/dev/null 2>&1; do sleep 3; done
      fi
      exec code --no-sandbox "$@" 2>/tmp/worktoper-code.log
  - path: /usr/local/bin/worktoper-open-browser
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      export XDG_RUNTIME_DIR=/run/user/1000
      export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
      [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority
      cd /home/worktoper
      if ! command -v google-chrome >/dev/null 2>&1; then
        install_pid=''
        [ -f /tmp/worktoper-chrome-install.pid ] && install_pid=$(cat /tmp/worktoper-chrome-install.pid 2>/dev/null || true)
        if [ -z "$install_pid" ] || ! kill -0 "$install_pid" >/dev/null 2>&1; then
          nohup /usr/local/sbin/worktoper-install-chrome >/tmp/worktoper-install-chrome.log 2>&1 & echo $! >/tmp/worktoper-chrome-install.pid
        fi
        if command -v xterm >/dev/null 2>&1; then
          exec xterm -T 'Installing Chrome' -e sh -lc 'install_pid=$(cat /tmp/worktoper-chrome-install.pid 2>/dev/null || true); while ! command -v google-chrome >/dev/null 2>&1; do clear; echo "正在安装 Google Chrome，请稍候..."; echo; tail -n 22 /tmp/worktoper-install-chrome.log 2>/dev/null || true; if [ -n "$install_pid" ] && ! kill -0 "$install_pid" >/dev/null 2>&1; then break; fi; sleep 3; done; if command -v google-chrome >/dev/null 2>&1; then exec google-chrome --no-sandbox; fi; exec chromium --no-sandbox || exec chromium-browser --no-sandbox'
        fi
      fi
      exec google-chrome --no-sandbox "$@" 2>/tmp/worktoper-chrome.log || exec chromium --no-sandbox "$@" 2>/tmp/worktoper-chromium.log || exec chromium-browser --no-sandbox "$@" 2>/tmp/worktoper-chromium-browser.log
  - path: /home/worktoper/Desktop/Terminal.desktop
    owner: worktoper:worktoper
    permissions: "0755"
    content: |
      [Desktop Entry]
      Type=Application
      Name=Terminal
      Exec=xfce4-terminal
      Icon=utilities-terminal
      Terminal=false
      Categories=System;TerminalEmulator;
  - path: /home/worktoper/Desktop/Chrome.desktop
    owner: worktoper:worktoper
    permissions: "0755"
    content: |
      [Desktop Entry]
      Type=Application
      Name=Chrome
      Exec=worktoper-open-browser
      Icon=chromium
      Terminal=false
      Categories=Network;WebBrowser;
  - path: /home/worktoper/Desktop/VSCode.desktop
    owner: worktoper:worktoper
    permissions: "0755"
    content: |
      [Desktop Entry]
      Type=Application
      Name=VS Code
      Exec=worktoper-open-code
      Icon=code
      Terminal=false
      Categories=Development;IDE;
  - path: /usr/local/bin/worktoper-trust-desktop-launchers
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      export XDG_RUNTIME_DIR=/run/user/1000
      export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
      [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority
      for file in /home/worktoper/Desktop/*.desktop; do
        [ -f "$file" ] || continue
        chmod +x "$file" 2>/dev/null || true
        gio set "$file" metadata::trusted true >/dev/null 2>&1 || true
        checksum=$(sha256sum "$file" 2>/dev/null | awk '{print $1}')
        [ -n "$checksum" ] && gio set -t string "$file" metadata::xfce-exe-checksum "$checksum" >/dev/null 2>&1 || true
      done
      xfdesktop --reload >/dev/null 2>&1 || true
  - path: /home/worktoper/.config/autostart/worktoper-desktop-trust.desktop
    owner: worktoper:worktoper
    permissions: "0644"
    content: |
      [Desktop Entry]
      Type=Application
      Name=WorkToper Desktop Trust
      Exec=/usr/local/bin/worktoper-trust-desktop-launchers
      OnlyShowIn=XFCE;
      Terminal=false
      X-GNOME-Autostart-enabled=true
runcmd:
  - systemctl enable qemu-guest-agent || true
  - systemctl enable serial-getty@ttyS0.service
  - systemctl enable serial-getty@ttyS1.service || true
  - systemctl restart ssh || systemctl restart sshd || true
  - mkdir -p /var/lib/lightdm/data /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local/share /run/lightdm /var/log/lightdm
  - chown -R lightdm:lightdm /var/lib/lightdm /run/lightdm /var/log/lightdm || true
  - chmod 0755 /var/lib/lightdm /run/lightdm /var/log/lightdm
  - chmod 0700 /var/lib/lightdm/data /var/lib/lightdm/.cache /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local /var/lib/lightdm/.local/share || true
  - systemctl reset-failed lightdm display-manager || true
  - systemctl restart lightdm || systemctl restart display-manager || true
  - systemctl set-default graphical.target
  - mkdir -p /home/worktoper/Desktop /home/worktoper/Projects
  - chmod +x /home/worktoper/Desktop/*.desktop || true
  - chown -R worktoper:worktoper /home/worktoper
  - runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-trust-desktop-launchers'
  - rm -f /home/worktoper/Desktop/Codium.desktop /home/worktoper/Desktop/VSCodium.desktop /usr/share/applications/codium.desktop /usr/share/applications/com.vscodium.codium.desktop || true
  - apt-get purge -y codium vscodium code-oss || true
  - /usr/local/sbin/worktoper-install-vscode || true
  - /usr/local/sbin/worktoper-install-chrome || true
final_message: "WorkToper Agent OS Debian desktop is ready. Login: worktoper / worktoper"
`
  fs.writeFileSync(path.join(seedDir, "user-data"), userData)
  fs.writeFileSync(path.join(seedDir, "meta-data"), `instance-id: worktoper-agent-os-${arch}-${Date.now()}\nlocal-hostname: worktoper-agent-os\n`)
}

function createSeedIso() {
  fs.rmSync(seedIso, { force: true })
  const userData = path.join(seedDir, "user-data")
  const metaData = path.join(seedDir, "meta-data")
  if (which("cloud-localds")) {
    run("cloud-localds", [seedIso, userData, metaData])
    return
  }
  if (which("genisoimage")) {
    run("genisoimage", ["-output", seedIso, "-volid", "cidata", "-joliet", "-rock", userData, metaData])
    return
  }
  if (which("mkisofs")) {
    run("mkisofs", ["-output", seedIso, "-volid", "cidata", "-joliet", "-rock", userData, metaData])
    return
  }
  if (which("xorriso")) {
    run("xorriso", ["-as", "mkisofs", "-output", seedIso, "-volid", "cidata", "-joliet", "-rock", userData, metaData])
    return
  }
  if (process.platform === "darwin" && which("hdiutil")) {
    run("hdiutil", ["makehybrid", "-o", seedIso, "-iso", "-joliet", "-default-volume-name", "cidata", seedDir])
    return
  }
  throw new Error("Cannot create cloud-init seed ISO. Install cloud-image-utils, genisoimage, mkisofs, xorriso, or run on macOS with hdiutil.")
}

async function main() {
  fs.mkdirSync(runtimeDir, { recursive: true })
  if (!which("qemu-img")) {
    throw new Error("qemu-img is required. Install QEMU first, then rerun this script.")
  }
  if (!fs.existsSync(baseImage) && fs.existsSync(legacyBaseImage)) {
    fs.copyFileSync(legacyBaseImage, baseImage)
    console.log(`Using cached base image: ${legacyBaseImage}`)
  }
  if (!fs.existsSync(baseImage)) {
    await download(imageUrls[arch], baseImage)
  } else {
    console.log(`Using cached base image: ${baseImage}`)
  }
  if (!fs.existsSync(vmImage)) {
    run("qemu-img", ["convert", "-O", "qcow2", baseImage, vmImage])
    run("qemu-img", ["resize", vmImage, process.env.WORKTOPER_VM_SIZE || "32G"])
  } else {
    console.log(`Using existing VM disk: ${vmImage}`)
  }
  writeSeedFiles()
  createSeedIso()
  console.log(`\nWorkToper VM assets are ready:
  Disk: ${vmImage}
  Seed: ${seedIso}
  Arch: ${arch}
  Host: ${os.platform()} ${os.arch()}

Start the app with:
  corepack pnpm@10.15.0 desktop:dev
`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
