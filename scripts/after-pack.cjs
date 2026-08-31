const fs = require("node:fs")
const path = require("node:path")

module.exports = async function verifyPackagedRuntime(context) {
  const platform = context.electronPlatformName === "mas" ? "darwin" : context.electronPlatformName
  const resourcesDirectory = platform === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources")
  if (!fs.statSync(resourcesDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Packaged resources directory is missing: ${resourcesDirectory}`)
  }
  const { verifyRuntime } = await import("./verify-runtime.mjs")
  verifyRuntime(path.join(resourcesDirectory, "runtime"), platform)
}
