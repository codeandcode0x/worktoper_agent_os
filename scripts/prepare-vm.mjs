#!/usr/bin/env node
import fs from "node:fs"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
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
const initializedMarker = path.join(runtimeDir, `worktoper-agent-os-${arch}.initialized`)
const seedBackgroundDir = path.join(seedDir, "backgrounds")
const defaultBackgroundName = "Alchemy-5.png"
const forceRebuild = process.argv.includes("--force") || process.argv.includes("--rebuild") || process.env.WORKTOPER_VM_REBUILD === "1"
const skipInitialize = process.argv.includes("--skip-init") || process.env.WORKTOPER_VM_SKIP_INIT === "1"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Unable to allocate localhost port"))
          return
        }
        resolve(address.port)
      })
    })
  })
}

function which(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" })
  if (result.status !== 0) return ""
  return result.stdout.split(/\r?\n/).find(Boolean) || ""
}

function executableExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false
    if (process.platform === "win32") return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function executableName(command) {
  if (process.platform !== "win32") return command
  return /\.(exe|cmd|bat)$/i.test(command) ? command : `${command}.exe`
}

function runtimeExecutableCandidates(group, command) {
  const name = executableName(command)
  const platformArch = `${process.platform}-${process.arch}`
  const runtimeRoot = path.join(root, "runtime")
  return [
    path.join(runtimeRoot, group, platformArch, name),
    path.join(runtimeRoot, group, process.platform, process.arch, name),
    path.join(runtimeRoot, group, process.platform, name),
    path.join(runtimeRoot, group, name),
  ]
}

function executableCandidates(commands, { group = "tools", envVar = "" } = {}) {
  const commandList = Array.isArray(commands) ? commands : [commands]
  return [
    envVar ? process.env[envVar] : "",
    ...commandList.flatMap((command) => runtimeExecutableCandidates(group, command)),
    ...commandList.map((command) => which(executableName(command))),
    ...commandList.map((command) => which(command)),
  ].filter(Boolean)
}

function resolveExecutable(commands, options = {}) {
  return executableCandidates(commands, options).find(executableExists) || ""
}

function resolveBackgroundSourceDir() {
  const candidates = [
    path.join(root, "bg"),
    path.join(root, "images", "bg"),
  ]
  return candidates.find((candidate) => {
    if (!fs.existsSync(candidate)) return false
    return fs.readdirSync(candidate).some((name) => name.toLowerCase() === defaultBackgroundName.toLowerCase())
  }) || ""
}

function copyBackgroundsToSeed() {
  fs.rmSync(seedBackgroundDir, { recursive: true, force: true })
  const backgroundSourceDir = resolveBackgroundSourceDir()
  if (!fs.existsSync(backgroundSourceDir)) return false
  const files = fs.readdirSync(backgroundSourceDir)
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .sort()
  if (!files.length) return false
  fs.mkdirSync(seedBackgroundDir, { recursive: true })
  for (const file of files) {
    fs.copyFileSync(path.join(backgroundSourceDir, file), path.join(seedBackgroundDir, file))
  }
  if (!files.some((name) => name.toLowerCase() === defaultBackgroundName.toLowerCase())) {
    throw new Error(`Default background is missing: ${path.join(backgroundSourceDir, defaultBackgroundName)}`)
  }
  return true
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
  copyBackgroundsToSeed()

  const powerState = skipInitialize ? "" : `power_state:
  mode: poweroff
  timeout: 30
  condition: true
`
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
  - linux-image-amd64
  - lightdm
  - xfce4
  - xfce4-terminal
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
  - fonts-noto-color-emoji
  - papirus-icon-theme
  - qemu-guest-agent
  - sshfs
  - cifs-utils
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
      printf 'deb [arch=%s signed-by=/usr/share/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main\\n' "$arch" >/etc/apt/sources.list.d/vscode.list
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
      printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main\\n' >/etc/apt/sources.list.d/google-chrome.list
      DEBIAN_FRONTEND=noninteractive apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable
  - path: /usr/local/sbin/worktoper-install-layan-theme
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      packages='git ca-certificates gtk2-engines-murrine gtk2-engines-pixbuf sassc papirus-icon-theme fonts-noto fonts-noto-cjk fonts-noto-color-emoji librsvg2-common'
      missing=''
      for package in $packages; do
        dpkg-query -W -f='\${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $package"
      done
      if [ -n "$missing" ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y $missing
      fi
      install -d -m 0755 /opt/worktoper
      if [ -d /opt/worktoper/Layan-gtk-theme/.git ]; then
        git -C /opt/worktoper/Layan-gtk-theme pull --ff-only
      else
        rm -rf /opt/worktoper/Layan-gtk-theme
        git clone --depth 1 https://github.com/vinceliuice/Layan-gtk-theme.git /opt/worktoper/Layan-gtk-theme
      fi
      cd /opt/worktoper/Layan-gtk-theme
      bash ./install.sh -d /usr/share/themes -c dark -s solid || bash ./install.sh -d /usr/share/themes -c dark || bash ./install.sh -d /usr/share/themes
  - path: /usr/local/sbin/worktoper-install-backgrounds
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      target=/usr/share/backgrounds/worktoper
      backdrops=/usr/share/xfce4/backdrops
      install -d -m 0755 "$target" "$backdrops"
      copied=0
      copy_background_dir() {
        source_dir=$1
        [ -d "$source_dir" ] || return 0
        found=0
        for file in "$source_dir"/*; do
          [ -f "$file" ] || continue
          case "$file" in
            *.jpg|*.jpeg|*.png|*.webp|*.JPG|*.JPEG|*.PNG|*.WEBP)
              cp -f "$file" "$target"/
              found=1
              ;;
          esac
        done
        [ "$found" -eq 0 ] || copied=1
      }
      for source_dir in /var/lib/cloud/seed/nocloud/backgrounds /var/lib/cloud/seed/nocloud-net/backgrounds /media/cidata/backgrounds /mnt/backgrounds /run/cloud-init/backgrounds /media/*/backgrounds /run/media/*/cidata/backgrounds; do
        copy_background_dir "$source_dir"
      done
      if [ "$copied" -eq 0 ]; then
        tmp=$(mktemp -d)
        for dev in /dev/disk/by-label/cidata /dev/disk/by-label/CIDATA /dev/vdb /dev/sr0; do
          [ -e "$dev" ] || continue
          mount -o ro "$dev" "$tmp" 2>/dev/null || continue
          copy_background_dir "$tmp/backgrounds"
          umount "$tmp" 2>/dev/null || true
          [ "$copied" -eq 0 ] || break
        done
        rmdir "$tmp" 2>/dev/null || true
      fi
      for file in "$target"/*; do
        [ -f "$file" ] || continue
        chmod 0644 "$file" 2>/dev/null || true
        chown root:root "$file" 2>/dev/null || true
        ln -sfn "$file" "$backdrops/$(basename "$file")" 2>/dev/null || true
      done
  - path: /usr/local/bin/worktoper-apply-layan-theme
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      export XDG_RUNTIME_DIR=/run/user/1000
      export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
      [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority
      theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*Dark*Solid*' -printf '%f\\n' | head -n 1 2>/dev/null || true)
      [ -n "$theme_name" ] || theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*Dark*' -printf '%f\\n' | head -n 1 2>/dev/null || true)
      [ -n "$theme_name" ] || theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*' -printf '%f\\n' | head -n 1 2>/dev/null || true)
      icon_theme=Papirus-Dark
      [ -d /usr/share/icons/$icon_theme ] || icon_theme=Adwaita
      if [ -z "$theme_name" ]; then
        exit 1
      fi
      theme_path=/usr/share/themes/$theme_name
      wallpaper=$(find /usr/share/backgrounds/worktoper -maxdepth 1 -iname 'alchemy-5.png' | head -n 1 2>/dev/null || true)
      [ -n "$wallpaper" ] || wallpaper=/usr/share/backgrounds/worktoper/Alchemy-5.png
      mkdir -p /home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml
      if [ ! -f "$wallpaper" ]; then
        echo "WorkToper background missing: $wallpaper" >&2
      fi
      printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '' '<channel name="xsettings" version="1.0">' '  <property name="Net" type="empty">' "    <property name=\"ThemeName\" type=\"string\" value=\"$theme_name\"/>" "    <property name=\"IconThemeName\" type=\"string\" value=\"$icon_theme\"/>" '  </property>' '  <property name="Gtk" type="empty">' '    <property name="FontName" type="string" value="Noto Sans 10"/>' '    <property name="MonospaceFontName" type="string" value="Noto Sans Mono 10"/>' '    <property name="DecorationLayout" type="string" value="menu:minimize,maximize,close"/>' '  </property>' '</channel>' >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
      printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '' '<channel name="xfwm4" version="1.0">' '  <property name="general" type="empty">' "    <property name=\"theme\" type=\"string\" value=\"$theme_name\"/>" '  </property>' '</channel>' >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml
      xfconf-query -c xsettings -p /Net/ThemeName -r >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/theme -r >/dev/null 2>&1 || true
      xfconf-query -c xsettings -p /Net/ThemeName -n -t string -s "$theme_name" >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/theme -n -t string -s "$theme_name" >/dev/null 2>&1 || true
      xfconf-query -c xsettings -p /Net/IconThemeName -n -t string -s "$icon_theme" >/dev/null 2>&1 || true
      xfconf-query -c xsettings -p /Gtk/DecorationLayout -n -t string -s 'menu:minimize,maximize,close' >/dev/null 2>&1 || true
      xfconf-query -c xsettings -p /Gtk/FontName -n -t string -s 'Noto Sans 10' >/dev/null 2>&1 || true
      xfconf-query -c xsettings -p /Gtk/MonospaceFontName -n -t string -s 'Noto Sans Mono 10' >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/use_compositing -n -t bool -s true >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/frame_opacity -n -t int -s 100 >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/inactive_opacity -n -t int -s 94 >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/show_frame_shadow -n -t bool -s true >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/show_popup_shadow -n -t bool -s true >/dev/null 2>&1 || true
      xfconf-query -c xfwm4 -p /general/button_layout -n -t string -s 'O|HMC' >/dev/null 2>&1 || true
      for monitor in monitor0 monitorVirtual-1 monitorVirtual1 monitorVNC-0 monitorDefault; do
        base=/backdrop/screen0/$monitor/workspace0
        xfconf-query -c xfce4-desktop -p $base/last-image -n -t string -s "$wallpaper" >/dev/null 2>&1 || true
        xfconf-query -c xfce4-desktop -p $base/image-path -n -t string -s "$wallpaper" >/dev/null 2>&1 || true
        xfconf-query -c xfce4-desktop -p $base/image-style -n -t int -s 5 >/dev/null 2>&1 || true
      done
      for property in $(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -E '/last-image$|/image-path$' || true); do xfconf-query -c xfce4-desktop -p "$property" -s "$wallpaper" >/dev/null 2>&1 || true; done
      for property in $(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -E '/image-style$' || true); do xfconf-query -c xfce4-desktop -p "$property" -s 5 >/dev/null 2>&1 || true; done
      mkdir -p /home/worktoper/.config/gtk-3.0 /home/worktoper/.config/gtk-4.0
      printf '%s\\n' '[Settings]' "gtk-theme-name=$theme_name" "gtk-icon-theme-name=$icon_theme" 'gtk-font-name=Noto Sans 10' 'gtk-application-prefer-dark-theme=true' >/home/worktoper/.config/gtk-3.0/settings.ini
      ln -sfn "$theme_path/gtk-4.0/assets" /home/worktoper/.config/gtk-4.0/assets 2>/dev/null || true
      ln -sfn "$theme_path/gtk-4.0/gtk.css" /home/worktoper/.config/gtk-4.0/gtk.css 2>/dev/null || true
      ln -sfn "$theme_path/gtk-4.0/gtk-dark.css" /home/worktoper/.config/gtk-4.0/gtk-dark.css 2>/dev/null || true
      chown -R worktoper:worktoper /home/worktoper/.config/gtk-3.0 /home/worktoper/.config/gtk-4.0 /home/worktoper/.config/xfce4 2>/dev/null || true
      xfdesktop --reload >/dev/null 2>&1 || true
  - path: /usr/local/bin/worktoper-configure-xfce-panel
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      target=/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml
      mkdir -p "$target"
      cat >"$target/xfce4-panel.xml" <<'EOF'
      <?xml version="1.0" encoding="UTF-8"?>

      <channel name="xfce4-panel" version="1.0">
        <property name="configver" type="int" value="2"/>
        <property name="panels" type="array">
          <value type="int" value="1"/>
          <property name="panel-1" type="empty">
            <property name="position" type="string" value="p=10;x=0;y=0"/>
            <property name="length" type="uint" value="100"/>
            <property name="position-locked" type="bool" value="true"/>
            <property name="size" type="uint" value="32"/>
            <property name="plugin-ids" type="array">
              <value type="int" value="1"/>
              <value type="int" value="2"/>
              <value type="int" value="3"/>
              <value type="int" value="4"/>
              <value type="int" value="5"/>
              <value type="int" value="6"/>
            </property>
          </property>
        </property>
        <property name="plugins" type="empty">
          <property name="plugin-1" type="string" value="applicationsmenu"/>
          <property name="plugin-2" type="string" value="tasklist"/>
          <property name="plugin-3" type="string" value="separator">
            <property name="expand" type="bool" value="true"/>
            <property name="style" type="uint" value="0"/>
          </property>
          <property name="plugin-4" type="string" value="pager"/>
          <property name="plugin-5" type="string" value="clock"/>
          <property name="plugin-6" type="string" value="actions"/>
        </property>
      </channel>
      EOF
      chown -R worktoper:worktoper /home/worktoper/.config/xfce4 2>/dev/null || true
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
    permissions: "0755"
    content: |
      [Desktop Entry]
      Type=Application
      Name=Terminal
      Exec=xfce4-terminal
      Icon=utilities-terminal
      Terminal=false
      Categories=System;TerminalEmulator;
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
  - path: /usr/local/bin/worktoper-keep-display-awake
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      export XDG_RUNTIME_DIR=/run/user/1000
      export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
      [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority
      xset s off >/dev/null 2>&1 || true
      xset s noblank >/dev/null 2>&1 || true
      xset -dpms >/dev/null 2>&1 || true
      xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/blank-on-ac -n -t int -s 0 >/dev/null 2>&1 || true
      xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled -n -t bool -s false >/dev/null 2>&1 || true
      xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/lock-screen-suspend-hibernate -n -t bool -s false >/dev/null 2>&1 || true
  - path: /home/worktoper/.config/autostart/worktoper-keep-display-awake.desktop
    permissions: "0644"
    content: |
      [Desktop Entry]
      Type=Application
      Name=WorkToper Keep Display Awake
      Exec=/usr/local/bin/worktoper-keep-display-awake
      OnlyShowIn=XFCE;
      Terminal=false
      X-GNOME-Autostart-enabled=true
  - path: /home/worktoper/.config/autostart/worktoper-layan-theme.desktop
    permissions: "0644"
    content: |
      [Desktop Entry]
      Type=Application
      Name=WorkToper Layan Theme
      Exec=/usr/local/bin/worktoper-apply-layan-theme
      OnlyShowIn=XFCE;
      Terminal=false
      X-GNOME-Autostart-enabled=true
  - path: /home/worktoper/.config/autostart/worktoper-desktop-trust.desktop
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
  - generic_kernel=$(ls -1 /boot/vmlinuz-*-amd64 2>/dev/null | grep -v cloud | sort -V | tail -n 1 || true); if [ -n "$generic_kernel" ]; then generic_version=$(basename "$generic_kernel" | sed 's/^vmlinuz-//'); menu="Advanced options for Debian GNU/Linux>Debian GNU/Linux, with Linux $generic_version"; mkdir -p /etc/default/grub.d; printf 'GRUB_DEFAULT="%s"\nGRUB_TIMEOUT=0\n' "$menu" >/etc/default/grub.d/99-worktoper-default-kernel.cfg; update-grub || true; fi
  - mkdir -p /var/lib/lightdm/data /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local/share /run/lightdm /var/log/lightdm
  - chown -R lightdm:lightdm /var/lib/lightdm /run/lightdm /var/log/lightdm || true
  - chmod 0755 /var/lib/lightdm /run/lightdm /var/log/lightdm
  - chmod 0700 /var/lib/lightdm/data /var/lib/lightdm/.cache /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local /var/lib/lightdm/.local/share || true
  - /usr/local/sbin/worktoper-install-backgrounds || true
  - mkdir -p /home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml /home/worktoper/.config/gtk-3.0
  - printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '' '<channel name="xsettings" version="1.0">' '  <property name="Net" type="empty">' '    <property name="IconThemeName" type="string" value="Papirus-Dark"/>' '  </property>' '  <property name="Gtk" type="empty">' '    <property name="FontName" type="string" value="Noto Sans 10"/>' '    <property name="MonospaceFontName" type="string" value="Noto Sans Mono 10"/>' '  </property>' '</channel>' >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
  - printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '' '<channel name="xfce4-desktop" version="1.0">' '  <property name="backdrop" type="empty">' '    <property name="screen0" type="empty">' '      <property name="monitor0" type="empty">' '        <property name="workspace0" type="empty">' '          <property name="last-image" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-path" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-style" type="int" value="5"/>' '        </property>' '      </property>' '      <property name="monitorVirtual-1" type="empty">' '        <property name="workspace0" type="empty">' '          <property name="last-image" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-path" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-style" type="int" value="5"/>' '        </property>' '      </property>' '      <property name="monitorVirtual1" type="empty">' '        <property name="workspace0" type="empty">' '          <property name="last-image" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-path" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-style" type="int" value="5"/>' '        </property>' '      </property>' '      <property name="monitorDefault" type="empty">' '        <property name="workspace0" type="empty">' '          <property name="last-image" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-path" type="string" value="/usr/share/backgrounds/worktoper/Alchemy-5.png"/>' '          <property name="image-style" type="int" value="5"/>' '        </property>' '      </property>' '    </property>' '  </property>' '</channel>' >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
  - printf '%s\\n' '[Settings]' 'gtk-icon-theme-name=Papirus-Dark' 'gtk-font-name=Noto Sans 10' >/home/worktoper/.config/gtk-3.0/settings.ini
  - for monitor in monitor0 monitorVirtual-1 monitorVirtual1 monitorVNC-0 monitorDefault; do base=/backdrop/screen0/$monitor/workspace0; xfconf-query -c xfce4-desktop -p $base/last-image -n -t string -s /usr/share/backgrounds/worktoper/Alchemy-5.png >/dev/null 2>&1 || true; xfconf-query -c xfce4-desktop -p $base/image-path -n -t string -s /usr/share/backgrounds/worktoper/Alchemy-5.png >/dev/null 2>&1 || true; xfconf-query -c xfce4-desktop -p $base/image-style -n -t int -s 5 >/dev/null 2>&1 || true; done
  - /usr/local/bin/worktoper-configure-xfce-panel || true
  - chown -R worktoper:worktoper /home/worktoper/.config
  - systemctl reset-failed lightdm display-manager || true
  - systemctl restart lightdm || systemctl restart display-manager || true
  - systemctl set-default graphical.target
  - mkdir -p /home/worktoper/Desktop /home/worktoper/Projects
  - chmod +x /home/worktoper/Desktop/*.desktop || true
  - chown -R worktoper:worktoper /home/worktoper
  - runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-trust-desktop-launchers'
  - runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-keep-display-awake'
  - /usr/local/sbin/worktoper-install-backgrounds || true
  - /usr/local/sbin/worktoper-install-layan-theme || true
  - runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-apply-layan-theme' || true
  - rm -f /home/worktoper/Desktop/Chrome.desktop /home/worktoper/Desktop/VSCode.desktop /home/worktoper/Desktop/Code.desktop /home/worktoper/Desktop/Codium.desktop /home/worktoper/Desktop/VSCodium.desktop /usr/share/applications/codium.desktop /usr/share/applications/com.vscodium.codium.desktop || true
  - for package in codium vscodium code-oss; do dpkg-query -W -f='\${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' && apt-get purge -y "$package" || true; done
  - /usr/local/sbin/worktoper-install-vscode || true
  - /usr/local/sbin/worktoper-install-chrome || true
  - mkdir -p /var/lib/worktoper
  - test -x /usr/sbin/lightdm
  - test -x /usr/bin/x11vnc
  - test -x /usr/sbin/qemu-ga
  - touch /var/lib/worktoper/desktop-image-ready
  - echo "WORKTOPER_DESKTOP_IMAGE_READY"
final_message: "WorkToper Agent OS Debian desktop is ready. Login: worktoper / worktoper"
${powerState}
`
  fs.writeFileSync(path.join(seedDir, "user-data"), userData)
  fs.writeFileSync(path.join(seedDir, "meta-data"), `instance-id: worktoper-agent-os-${arch}-${Date.now()}\nlocal-hostname: worktoper-agent-os\n`)
}

function createSeedIso() {
  fs.rmSync(seedIso, { force: true })
  const userData = path.join(seedDir, "user-data")
  const metaData = path.join(seedDir, "meta-data")
  const hasBackgrounds = fs.existsSync(seedBackgroundDir)
  const graftArgs = hasBackgrounds
    ? ["-graft-points", `user-data=${userData}`, `meta-data=${metaData}`, `backgrounds=${seedBackgroundDir}`]
    : [userData, metaData]
  const genisoimage = resolveExecutable("genisoimage", { group: "tools", envVar: "WORKTOPER_GENISOIMAGE" })
  if (genisoimage) {
    run(genisoimage, ["-output", seedIso, "-volid", "cidata", "-joliet", "-rock", ...graftArgs])
    return
  }
  const mkisofs = resolveExecutable("mkisofs", { group: "tools", envVar: "WORKTOPER_MKISOFS" })
  if (mkisofs) {
    run(mkisofs, ["-output", seedIso, "-volid", "cidata", "-joliet", "-rock", ...graftArgs])
    return
  }
  const xorriso = resolveExecutable("xorriso", { group: "tools", envVar: "WORKTOPER_XORRISO" })
  if (xorriso) {
    run(xorriso, ["-as", "mkisofs", "-output", seedIso, "-volid", "cidata", "-joliet", "-rock", ...graftArgs])
    return
  }
  if (process.platform === "darwin" && which("hdiutil")) {
    run("hdiutil", ["makehybrid", "-o", seedIso, "-iso", "-joliet", "-default-volume-name", "cidata", seedDir])
    return
  }
  const cloudLocalds = resolveExecutable("cloud-localds", { group: "tools", envVar: "WORKTOPER_CLOUD_LOCALDS" })
  if (!hasBackgrounds && cloudLocalds) {
    run(cloudLocalds, [seedIso, userData, metaData])
    return
  }
  throw new Error("Cannot create cloud-init seed ISO. Install cloud-image-utils, genisoimage, mkisofs, xorriso, run on macOS with hdiutil, or bundle one of these tools in runtime/tools/<platform>/.")
}

function qemuSystemBinary() {
  const name = arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64"
  return resolveExecutable(name, { group: "qemu", envVar: "WORKTOPER_QEMU" })
}

function qemuImgBinary() {
  return resolveExecutable("qemu-img", { group: "qemu", envVar: "WORKTOPER_QEMU_IMG" })
}

async function initializeVmImage() {
  if (skipInitialize) {
    console.log("Skipping VM initialization because --skip-init or WORKTOPER_VM_SKIP_INIT=1 was set.")
    return
  }
  const qemu = qemuSystemBinary()
  if (!qemu) throw new Error("qemu-system is required to initialize the VM image.")
  const sshPort = await getFreePort()
  const serialPort = await getFreePort()
  const accelerator = process.env.WORKTOPER_QEMU_ACCEL || (process.platform === "darwin" ? "hvf" : "tcg")
  const cpuModel = process.env.WORKTOPER_QEMU_CPU || (accelerator === "tcg" ? "max" : "host")
  const args = [
    "-accel", accelerator,
    "-name", "WorkToper Agent OS Image Initializer",
    "-m", String(process.env.WORKTOPER_VM_INIT_MEMORY || 4096),
    "-smp", String(process.env.WORKTOPER_VM_INIT_CPUS || Math.max(2, Math.min(os.cpus().length, 4))),
    "-machine", "q35",
    "-cpu", cpuModel,
    "-display", "none",
    "-monitor", "none",
    "-vga", "std",
    "-device", "virtio-rng-pci",
    "-drive", `file=${vmImage},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
    "-drive", `file=${seedIso},format=raw,if=virtio,media=cdrom,readonly=on`,
    "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
    "-device", "virtio-net-pci,netdev=net0",
    "-serial", `tcp:127.0.0.1:${serialPort},server=on,wait=off,nodelay=on`,
  ]
  console.log(`Initializing VM image with cloud-init. SSH port: ${sshPort}`)
  const child = spawn(qemu, args, { stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  let serialLog = ""
  let serialSocket = null
  let cloudInitSucceeded = false
  let desktopImageReady = false
  let exitCode = null
  let exitSignal = null
  let lastLog = Date.now()
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8")
    stderr += text
    if (/error|failed|lock/i.test(text)) process.stderr.write(text)
  })
  const connectSerial = () => {
    if (child.exitCode !== null || serialSocket) return
    const socket = net.createConnection({ host: "127.0.0.1", port: serialPort })
    socket.on("connect", () => {
      serialSocket = socket
      console.log("Connected to VM initialization serial console.")
    })
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      serialLog += text
      if (serialLog.length > 1_000_000) serialLog = serialLog.slice(-800_000)
      if (/WorkToper Agent OS Debian desktop is ready/i.test(text)) cloudInitSucceeded = true
      if (/WORKTOPER_DESKTOP_IMAGE_READY/.test(text)) desktopImageReady = true
    })
    socket.on("error", () => {
      socket.destroy()
      if (child.exitCode === null) setTimeout(connectSerial, 500)
    })
    socket.on("close", () => {
      if (serialSocket === socket) serialSocket = null
      if (child.exitCode === null) setTimeout(connectSerial, 500)
    })
  }
  setTimeout(connectSerial, 500)
  try {
    const timeoutMs = Number(process.env.WORKTOPER_VM_INIT_TIMEOUT_MS || 1800000)
    const stopped = await new Promise((resolve) => {
      const heartbeat = setInterval(() => {
        if (Date.now() - lastLog >= 30000) {
          lastLog = Date.now()
          console.log("Waiting for cloud-init to finish image initialization...")
        }
      }, 5000)
      const timer = setTimeout(() => resolve(false), timeoutMs)
      child.once("exit", (code, signal) => {
        exitCode = code
        exitSignal = signal
        clearInterval(heartbeat)
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!stopped) {
      child.kill("SIGTERM")
      await sleep(3000)
      if (!child.killed) child.kill("SIGKILL")
      throw new Error(`Timed out waiting for cloud-init image initialization.\n${stderr}`)
    }
    serialSocket?.destroy()
    const combinedLog = `${stderr}\n${serialLog}`
    const markerComplete = cloudInitSucceeded && desktopImageReady
    const sawPoweroff = /reboot:\s*Power down|Powering off|systemd-shutdown/i.test(combinedLog)
    const knownConfigFailure = /Failed loading yaml blob|Invalid format at line|could not find expected ':'|cloud-init\[[^\]]+\]: .*Traceback/i.test(combinedLog)
    const qemuFailed = exitCode !== 0 && !sawPoweroff
    if (!markerComplete && (knownConfigFailure || qemuFailed || !sawPoweroff)) {
      throw new Error(`VM image initialization did not complete cleanly. Refusing to write initialized marker. QEMU exit: ${exitCode ?? "null"}${exitSignal ? ` signal ${exitSignal}` : ""}\n${stderr}\n${serialLog.slice(-12000)}`)
    }
    if (!markerComplete) {
      console.warn("VM powered off after initialization, but the serial completion marker was not captured. Accepting the initialized image.")
    }
    console.log("cloud-init finished and VM powered off.")
  } catch (error) {
    serialSocket?.destroy()
    child.kill("SIGTERM")
    throw error
  }
}

async function main() {
  fs.mkdirSync(runtimeDir, { recursive: true })
  const qemuImg = qemuImgBinary()
  if (!qemuImg) {
    const searched = executableCandidates("qemu-img", { group: "qemu", envVar: "WORKTOPER_QEMU_IMG" }).join(", ")
    throw new Error(`qemu-img is required. Install QEMU, set WORKTOPER_QEMU_IMG, or bundle qemu-img in runtime/qemu/${process.platform}/. Searched: ${searched || "none"}`)
  }
  console.log(`Using qemu-img: ${qemuImg}`)
  if (!fs.existsSync(baseImage) && fs.existsSync(legacyBaseImage)) {
    fs.copyFileSync(legacyBaseImage, baseImage)
    console.log(`Using cached base image: ${legacyBaseImage}`)
  }
  if (!fs.existsSync(baseImage)) {
    await download(imageUrls[arch], baseImage)
  } else {
    console.log(`Using cached base image: ${baseImage}`)
  }
  if (forceRebuild && fs.existsSync(vmImage)) {
    fs.rmSync(vmImage, { force: true })
    fs.rmSync(initializedMarker, { force: true })
    console.log(`Removed existing VM disk for rebuild: ${vmImage}`)
  }
  if (!fs.existsSync(vmImage)) {
    run(qemuImg, ["convert", "-O", "qcow2", baseImage, vmImage])
    run(qemuImg, ["resize", vmImage, process.env.WORKTOPER_VM_SIZE || "32G"])
    fs.rmSync(initializedMarker, { force: true })
  } else {
    console.log(`Using existing VM disk: ${vmImage}`)
  }
  writeSeedFiles()
  createSeedIso()
  if (!fs.existsSync(initializedMarker)) {
    await initializeVmImage()
    fs.writeFileSync(initializedMarker, `initialized=${new Date().toISOString()}\n`)
  } else {
    console.log(`Using initialized VM marker: ${initializedMarker}`)
  }
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
