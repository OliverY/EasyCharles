/**
 * 自测用的假上游服务。不需要真实服务器就能验证 EasyCharles 链路。
 *
 *   node tools/mock-upstream.ts            # 默认 9099
 *   node tools/mock-upstream.ts --port 9098
 */
import http from 'node:http'

const portIdx = process.argv.indexOf('--port')
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 9099

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    let n = 0
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ tick: ++n })}\n\n`)
      if (n >= 5) {
        clearInterval(timer)
        res.end()
      }
    }, 100)
    req.on('close', () => clearInterval(timer))
    return
  }

  if (url.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(2 << 20) })
    res.end(Buffer.alloc(2 << 20, 0x41))
    return
  }

  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const payload = JSON.stringify(
      {
        ok: true,
        upstream: true,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        sawHost: req.headers.host,
        sawHeaders: req.headers,
        echo: body,
      },
      null,
      2,
    )
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
    res.end(payload)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port}`)
})
