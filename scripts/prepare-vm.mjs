#!/usr/bin/env node
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeDir = path.join(root, "runtime", "images")
const arch = process.env.WORKTOPER_VM_ARCH || (process.arch === "arm64" ? "arm64" : "x64")
const imageUrls = {
  x64: process.env.WORKTOPER_BASE_IMAGE_URL || "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2",
  arm64: process.env.WORKTOPER_BASE_IMAGE_URL || "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2",
}
const baseImage = path.join(runtimeDir, `debian-bookworm-base-${arch}.qcow2`)
const vmImage = path.join(runtimeDir, `worktoper-agent-os-${arch}.qcow2`)
const seedIso = path.join(runtimeDir, `seed-${arch}.iso`)
const seedDir = path.join(runtimeDir, `seed-${arch}`)
const allowProprietary = process.env.WORKTOPER_ALLOW_PROPRIETARY === "1"

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
  const proprietaryCommands = allowProprietary ? `
  - curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-keyring.gpg
  - echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  - curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/packages.microsoft.gpg
  - echo "deb [arch=amd64 signed-by=/usr/share/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list
  - apt-get update
  - apt-get install -y google-chrome-stable code
` : ""

  const userData = `#cloud-config
hostname: worktoper-agent-os
manage_etc_hosts: true
disable_root: false
ssh_pwauth: true
chpasswd:
  expire: false
  users:
    - { name: root, password: worktoper, type: text }
    - { name: worktoper, password: worktoper, type: text }
users:
  - default
  - name: worktoper
    gecos: WorkToper
    groups: sudo,adm,audio,video,plugdev
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
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
  - lightdm
  - xfce4
  - xfce4-terminal
  - xterm
  - chromium
  - fonts-noto
  - fonts-noto-cjk
  - qemu-guest-agent
write_files:
  - path: /etc/systemd/system/serial-getty@ttyS0.service.d/override.conf
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
  - path: /usr/local/bin/worktoper-open-code
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      exec code --no-sandbox "$@" 2>/tmp/worktoper-code.log || exec codium --no-sandbox "$@" 2>/tmp/worktoper-codium.log || exec code-oss --no-sandbox "$@" 2>/tmp/worktoper-code-oss.log || exec mousepad "$@"
  - path: /usr/local/bin/worktoper-open-browser
    permissions: "0755"
    content: |
      #!/bin/sh
      export DISPLAY=:0
      exec google-chrome --no-sandbox "$@" 2>/tmp/worktoper-chrome.log || exec chromium --no-sandbox "$@" 2>/tmp/worktoper-chromium.log || exec chromium-browser --no-sandbox "$@"
runcmd:
  - systemctl enable qemu-guest-agent || true
  - systemctl enable serial-getty@ttyS0.service
  - systemctl set-default graphical.target
  - mkdir -p /home/worktoper/Desktop /home/worktoper/Projects
  - chown -R worktoper:worktoper /home/worktoper
  - apt-get update
  - curl -fsSL https://gitlab.com/paulcarroty/vscodium-deb-rpm-repo/raw/master/pub.gpg | gpg --dearmor -o /usr/share/keyrings/vscodium-archive-keyring.gpg || true
  - echo "deb [signed-by=/usr/share/keyrings/vscodium-archive-keyring.gpg] https://download.vscodium.com/debs vscodium main" > /etc/apt/sources.list.d/vscodium.list
  - apt-get update || true
  - apt-get install -y codium || true
${proprietaryCommands}
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
