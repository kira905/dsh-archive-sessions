// 测试宿主：把 dsh-archive-sessions 的 host 半挂在一个最小的 webServer 上跑真实 HTTP。
// 用法：ARCHIVE_SESSIONS_CONFIG=<配置文件> DSH_HOME=<临时 home> node scripts/test-host.mjs <port>
//
// 这个宿主不是 DSH：它只实现插件用到的那一个 ctx 面（webServer.register + logger），
// 目的是在没有 DSH 进程的情况下，用真实 HTTP 请求跑通 list / detail / restore / delete。
import http from 'node:http'

const port = Number(process.argv[2] ?? 0)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('usage: node scripts/test-host.mjs <port>   (0 = random free port)')
  process.exit(2)
}

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

const registered = []
const logger = {
  info: (msg) => console.log('[info] ' + msg),
  warn: (msg) => console.log('[warn] ' + msg),
}
const fakeServer = {
  register(route) {
    registered.push(route)
    console.log('[register] ' + route.kind + ' ' + route.path)
    return () => {
      const index = registered.indexOf(route)
      if (index >= 0) registered.splice(index, 1)
    }
  },
}
const fakeCtx = { webServer: fakeServer, logger, effect: () => () => {} }

const dispose = plugin.apply(fakeCtx)

// 把注册进来的 exact 路由转成一个朴素路由器（够本插件用）
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = registered.find((item) => item.kind === 'exact' && item.path === url.pathname)
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no route: ' + url.pathname }))
    return
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    })
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  console.log('[ready] http://127.0.0.1:' + actual + ' routes=' + registered.length)
})

// 退出时清理插件注册的定时器
const shutdown = () => {
  try {
    if (typeof dispose === 'function') dispose()
  } catch { /* ignore */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('end', shutdown)
