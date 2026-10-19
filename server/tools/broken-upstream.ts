/**
 * F-01 验收用「半途断流」假上游（默认端口 9097）。
 *
 * 用法：node tools/broken-upstream.ts [port]
 * 端点：
 *   /broken           writeHead(content-length: 100) 后写 10 字节再销毁 socket（模拟上游 ECONNRESET）
 *   /chunked-json     无 content-length 的 20KB JSON（验证 bounded buffering 完整记录）
 *   /big              2MB 固定长度响应（验证流式采样）
 *   /sse              text/event-stream（验证 SSE 流式 + 采样）
 *   /r1 /r2           302 → /r2 的相对/绝对跳转（验证 Location 透传）
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 9097)

http
  .createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/broken') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
      res.write('{"a":1,"b"')
      setTimeout(() => res.socket?.destroy(), 30)
      return
    }
    if (url === '/chunked-json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"part":1,')
      setTimeout(() => {
        res.end(JSON.stringify({ data: 'X'.repeat(20_000) }).slice(1))
      }, 30)
      return
    }
    if (url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(2 << 20) })
      res.end(Buffer.alloc(2 << 20, 0x41))
      return
    }
    if (url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      setTimeout(() => res.end('data: 2\n\n'), 20)
      return
    }
    if (url === '/r1') {
      res.writeHead(302, { location: 'http://127.0.0.1:9097/r2' })
      res.end('go to r2')
      return
    }
    const payload = JSON.stringify({ ok: true, path: url }, null, 2)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
    res.end(payload)
  })
  .listen(port, '127.0.0.1', () => console.log(`broken-upstream on ${port}`))
