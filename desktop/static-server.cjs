const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function resolveRequest(root, requestUrl) {
  const parsed = new URL(requestUrl, "http://worktoper.local")
  const pathname = decodeURIComponent(parsed.pathname)
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "")
  let target = path.join(root, normalized)

  if (!target.startsWith(root)) return null
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html")
  if (fs.existsSync(target)) return target

  if (!path.extname(target)) {
    const htmlFile = `${target}.html`
    if (fs.existsSync(htmlFile)) return htmlFile
  }

  return path.join(root, "index.html")
}

function writeHeaders(response, filePath) {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  response.setHeader("Cross-Origin-Embedder-Policy", "credentialless")
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  response.setHeader("Cache-Control", filePath.includes(`${path.sep}_next${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache")
  response.setHeader("Content-Type", MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream")
}

function createStaticServer(rootDir) {
  const root = path.resolve(rootDir)
  const server = http.createServer((request, response) => {
    const filePath = resolveRequest(root, request.url || "/")
    if (!filePath || !filePath.startsWith(root) || !fs.existsSync(filePath)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Not found")
      return
    }

    writeHeaders(response, filePath)
    if (request.method === "HEAD") {
      response.end()
      return
    }

    fs.createReadStream(filePath).on("error", () => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Read error")
    }).pipe(response)
  })

  return {
    root,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          server.off("error", reject)
          const address = server.address()
          if (!address || typeof address === "string") {
            reject(new Error("Unable to bind WorkToper static server"))
            return
          }
          resolve({ server, url: `http://${host}:${address.port}/` })
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

if (require.main === module) {
  const root = process.argv[2] || path.join(process.cwd(), "out")
  const port = Number(process.env.PORT || 3000)
  createStaticServer(root).listen(port, "127.0.0.1").then(({ url }) => {
    console.log(`WorkToper Agent OS static server: ${url}`)
    console.log(`Serving: ${pathToFileURL(path.resolve(root)).href}`)
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { createStaticServer }
