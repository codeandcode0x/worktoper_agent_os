#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const platformRequirements = {
  darwin: [
    "qemu/darwin/qemu-system-x86_64",
    "qemu/darwin/qemu-img",
    "qemu/darwin/share/qemu/bios.bin",
    "tools/darwin/tar",
  ],
  linux: [
    "qemu/linux/qemu-system-x86_64",
    "qemu/linux/qemu-img",
    "qemu/linux/lib/ld-musl-x86_64.so.1",
    "qemu/linux/libexec/qemu-system-x86_64",
    "qemu/linux/libexec/qemu-img",
    "qemu/linux/share/qemu/bios.bin",
    "tools/linux/tar",
  ],
  win32: [
    "qemu/win32/qemu-system-x86_64.exe",
    "qemu/win32/qemu-img.exe",
    "qemu/win32/share/qemu/bios.bin",
    "qemu/win32/zlib1.dll",
    "tools/win32/tar.exe",
  ],
}

function requireFile(runtimeRoot, relativePath) {
  const filePath = path.join(runtimeRoot, relativePath)
  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size === 0) throw new Error(`Bundled runtime file is missing or empty: ${filePath}`)
  return filePath
}

function requireExecutable(filePath) {
  fs.accessSync(filePath, fs.constants.X_OK)
}

export function verifyRuntime(runtimeRoot, platform) {
  const requirements = platformRequirements[platform]
  if (!requirements) throw new Error(`Unsupported runtime platform: ${platform}`)
  const files = requirements.map((relativePath) => requireFile(runtimeRoot, relativePath))
  if (platform !== "win32") {
    for (const filePath of files.filter((candidate) => /(?:qemu-system-x86_64|qemu-img|\/tar)$/.test(candidate))) {
      requireExecutable(filePath)
    }
  }
  if (platform === "darwin") {
    const libraries = fs.readdirSync(path.join(runtimeRoot, "qemu", "darwin", "lib"))
    if (!libraries.some((name) => name.endsWith(".dylib"))) throw new Error("Bundled macOS QEMU libraries are missing")
  }
  if (platform === "win32") {
    const libraries = fs.readdirSync(path.join(runtimeRoot, "qemu", "win32")).filter((name) => name.endsWith(".dll"))
    if (libraries.length < 10) throw new Error("Bundled Windows QEMU DLL set is incomplete")
  }
  console.log(`Verified self-contained ${platform} runtime: ${runtimeRoot}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const runtimeRoot = path.resolve(process.argv[3] || path.join(projectRoot, "runtime"))
  const platforms = process.argv[2] ? [process.argv[2]] : Object.keys(platformRequirements)
  for (const platform of platforms) verifyRuntime(runtimeRoot, platform)
}
