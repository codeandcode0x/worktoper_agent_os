import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const projectRoot = path.resolve(import.meta.dirname, "..")
const qemuPrefix = process.argv[2] || execFileSync("brew", ["--prefix", "qemu"], { encoding: "utf8" }).trim()
const qemuOutput = path.join(projectRoot, "runtime", "qemu", "darwin")
const stagingOutput = `${qemuOutput}.staging-${process.pid}`
const backupOutput = `${qemuOutput}.backup-${process.pid}`
const libraryOutput = path.join(stagingOutput, "lib")
const firmwareOutput = path.join(stagingOutput, "share", "qemu")
const entitlements = path.join(projectRoot, "build", "entitlements.mac.inherit.plist")
const binaries = ["qemu-system-x86_64", "qemu-img"]
const firmwarePattern = /^(bios|kvmvapic|linuxboot|multiboot|pvh|qboot|vgabios|efi-(e1000|e1000e|eepro100|ne2k_pci|pcnet|rtl8139|virtio|vmxnet3)|pxe-(e1000|eepro100|ne2k_pci|pcnet|rtl8139|virtio))([-.].*)?\.(bin|rom)$/
const firmwareSource = path.join(qemuPrefix, "share", "qemu")
const binarySources = binaries.map((binary) => path.join(qemuPrefix, "bin", binary))

for (const source of [...binarySources, firmwareSource, entitlements]) {
  if (!fs.existsSync(source)) throw new Error(`Required macOS QEMU source is missing: ${source}`)
}

fs.rmSync(stagingOutput, { recursive: true, force: true })
fs.rmSync(backupOutput, { recursive: true, force: true })
fs.mkdirSync(libraryOutput, { recursive: true })
fs.mkdirSync(firmwareOutput, { recursive: true })

const pending = []
for (const [index, binary] of binaries.entries()) {
  const source = binarySources[index]
  const destination = path.join(stagingOutput, binary)
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o755)
  pending.push(destination)
}

const copiedLibraries = new Map()
for (let index = 0; index < pending.length; index += 1) {
  const current = pending[index]
  const output = execFileSync("otool", ["-L", current], { encoding: "utf8" })
  const dependencies = output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean)
    .filter((dependency) => !dependency.startsWith("/System/") && !dependency.startsWith("/usr/lib/"))

  for (const dependency of dependencies) {
    const name = path.basename(dependency)
    let destination = copiedLibraries.get(dependency)
    if (!destination) {
      destination = path.join(libraryOutput, name)
      if (!fs.existsSync(destination)) {
        fs.copyFileSync(fs.realpathSync(dependency), destination)
        fs.chmodSync(destination, 0o755)
        pending.push(destination)
      }
      copiedLibraries.set(dependency, destination)
    }
    const relativeDependency = current.startsWith(`${libraryOutput}${path.sep}`)
      ? `@loader_path/${name}`
      : `@loader_path/lib/${name}`
    execFileSync("install_name_tool", ["-change", dependency, relativeDependency, current])
  }

  if (current.startsWith(`${libraryOutput}${path.sep}`)) {
    execFileSync("install_name_tool", ["-id", `@loader_path/${path.basename(current)}`, current])
  }
}

for (const entry of fs.readdirSync(firmwareSource, { withFileTypes: true })) {
  if (!entry.isFile() || !firmwarePattern.test(entry.name)) continue
  fs.copyFileSync(path.join(firmwareSource, entry.name), path.join(firmwareOutput, entry.name))
}

for (const license of ["COPYING", "COPYING.LIB", "LICENSE"]) {
  const source = path.join(qemuPrefix, license)
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stagingOutput, license))
}

for (const file of [...pending].reverse()) {
  try {
    execFileSync("codesign", ["--remove-signature", file], { stdio: "ignore" })
  } catch {}
  const signArguments = ["--force", "--sign", "-"]
  if (path.basename(file) === "qemu-system-x86_64") {
    signArguments.push("--entitlements", entitlements)
  }
  signArguments.push(file)
  execFileSync("codesign", signArguments, { stdio: "ignore" })
}

const unresolved = pending.flatMap((file) => {
  const output = execFileSync("otool", ["-L", file], { encoding: "utf8" })
  return output.split("\n").filter((line) => line.includes("/usr/local/") || line.includes("/opt/homebrew/"))
})
if (unresolved.length > 0) throw new Error(`Unresolved Homebrew libraries:\n${unresolved.join("\n")}`)

try {
  if (fs.existsSync(qemuOutput)) fs.renameSync(qemuOutput, backupOutput)
  fs.renameSync(stagingOutput, qemuOutput)
  fs.rmSync(backupOutput, { recursive: true, force: true })
} catch (error) {
  if (!fs.existsSync(qemuOutput) && fs.existsSync(backupOutput)) fs.renameSync(backupOutput, qemuOutput)
  throw error
}

console.log(`Bundled macOS QEMU from ${qemuPrefix}`)
console.log(`QEMU files: ${qemuOutput}`)
