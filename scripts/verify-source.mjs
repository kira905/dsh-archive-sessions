// 开源版源码静态验证：语法 + 配置层行为 + 硬编码扫描
// 用法：node <此文件> <repoRoot>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ?? process.cwd()
let fail = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
  if (!ok) fail += 1
}

// 1) node --check 每个 .js / .mjs
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full)
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry))) files.push(full)
  }
}
walk(root)
for (const file of files) {
  const rel = file.slice(root.length + 1)
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  check('syntax ' + rel, res.status === 0, (res.stderr || '').split('\n')[0] ?? '')
}

// 2) client.js：剥离 window.__ModuleLoader__ 壳后用 new Function 解析（浏览器端代码）
const clientPath = join(root, 'lib', 'client.js')
const clientSrc = readFileSync(clientPath, 'utf8')
try {
  const wrapped = clientSrc.replace(/^window\.__ModuleLoader__\.load\(/m, 'LOAD(')
  // eslint-disable-next-line no-new-func
  new Function('LOAD', 'return ' + wrapped)
  check('client.js factory parses as browser bundle', true)
} catch (err) {
  check('client.js factory parses as browser bundle', false, err.message)
}

// 3) 配置层：默认值 + 环境变量覆盖 + 相对路径解析
const cfgMod = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const defaults = cfgMod.DEFAULT_CONFIG
check('default archive dir name', defaults.paths.archiveRoot === null)
check('default api prefix', defaults.server.apiPrefix === '/api/dsh-archive-sessions')
check('default preview messages', defaults.preview.maxMessages === 50)
check('default auto disabled + dryRun', defaults.auto.enabled === false && defaults.auto.dryRun === true)

process.env.DSH_HOME = join(root, '.tmp-home-a')
const loaded = cfgMod.loadConfig({ cache: false })
check('DSH_HOME respected', loaded.config.paths.home === join(root, '.tmp-home-a'))
check('archiveRoot derived from DSH_HOME', loaded.config.paths.archiveRoot === null)
check('no config file -> source null', loaded.source === null)
check('no sanitize errors on defaults', loaded.errors.length === 0, JSON.stringify(loaded.errors))

// 相对路径按 DSH home 解析
process.env.ARCHIVE_SESSIONS_CONFIG = join(root, '.tmp-home-a', 'cfg.json')
const cfgPath = process.env.ARCHIVE_SESSIONS_CONFIG
const { writeFileSync, mkdirSync } = await import('node:fs')
mkdirSync(join(root, '.tmp-home-a'), { recursive: true })
writeFileSync(cfgPath, JSON.stringify({
  language: 'en',
  paths: { archiveRoot: 'my-archive', sessionsRoot: 'my-sessions' },
  preview: { maxMessages: 5 },
  auto: { hours: 12, enabled: true },
  server: { apiPrefix: 'api/custom-prefix/' },
  ui: { nav: 'Custom Nav' },
  bogusKey: 'x',
}), 'utf8')
const loaded2 = cfgMod.loadConfig({ cache: false })
check('relative archiveRoot resolved under home', loaded2.config.paths.archiveRoot === join(root, '.tmp-home-a', 'my-archive'), loaded2.config.paths.archiveRoot)
check('relative sessionsRoot resolved under home', loaded2.config.paths.sessionsRoot === join(root, '.tmp-home-a', 'my-sessions'))
check('override maxMessages', loaded2.config.preview.maxMessages === 5)
check('override auto.hours', loaded2.config.auto.hours === 12)
check('apiPrefix normalized', loaded2.config.server.apiPrefix === '/api/custom-prefix', loaded2.config.server.apiPrefix)
check('ui override merged', cfgMod.resolveUi(loaded2.config).nav === 'Custom Nav')
check('en language ui present', cfgMod.resolveUi(loaded2.config).refresh === 'Refresh')
const pub = cfgMod.publicConfig(loaded2.config)
check('publicConfig hides absolute paths', !JSON.stringify(pub).includes(root))
check('unknown key tolerated', loaded2.errors.length === 0, JSON.stringify(loaded2.errors))

// 坏值应被清洗并记错误
writeFileSync(cfgPath, JSON.stringify({ preview: { maxMessages: 'abc' }, auto: { hours: -5 }, server: { apiPrefix: 123 } }), 'utf8')
const loaded3 = cfgMod.loadConfig({ cache: false })
check('invalid values reported', loaded3.errors.length >= 2, JSON.stringify(loaded3.errors))
check('invalid value fell back to default', loaded3.config.preview.maxMessages === defaults.preview.maxMessages)
check('negative hours clamped', loaded3.config.auto.hours >= 1)

// 4) 硬编码扫描
//    代码文件（lib/scripts）：连通用绝对路径一起禁（示例一律用相对路径或 <DSH_HOME>）
//    文本文件（README / 示例配置 / 模板）：允许出现通用绝对路径示例（如 C:\Users\me\.dsh），
//    但一律禁本机路径、机器名/用户名、个人称呼、本机同步产品名、会话数据特征。
const CODE_PATTERNS = [
  // 绝对路径只看盘符（[A-H]，方案写作 2026 年不影响）：URL 协议头是 5+ 字母，天然不匹配
  [/[A-H]:[\\/]/, 'absolute windows path'],
]
const COMMON_PATTERNS = [
  [/D:\\?DSH/i, 'local DSH path'],
  [/DSH-oss|DSH-offsync|BaiduSync|H:\\?DSH-test/i, 'local layout name'],
  [/51367|zephyrusa?ir|KIRA-TUF|ZEPHYRUSAIR/i, 'machine/user identifier'],
  [/主人|本鱼|铲屎的|鲸鱼娘/, 'personal wording'],
  [/dsh-config|dsh-workspace|坚果云|百度网盘|Nutstore/i, 'local sync product'],
  [/session-e6d636|archive-sessions-plugin-deploy/i, 'local artifact name'],
  [/\bsk-[A-Za-z0-9]{8,}/, 'api key'],
]
const TEXT_LIKE = new Set(['.md', '.json', '.yml', '.yaml', '.txt', '.example'])
const isTextLike = (rel) => [...TEXT_LIKE].some((ext) => rel.endsWith(ext))
const isComment = (line) => /^\s{0,4}(\/\/|\/\*|\*|#|<!--)/.test(line)
let scanned = 0
for (const file of files) {
  const rel = file.slice(root.length + 1)
  if (rel.endsWith('scripts/verify-source.mjs') || rel.endsWith('scripts/verify-source.mjs'.replace(/\//g, '\\'))) continue // 扫描器自身含模式串
  if (rel.startsWith('.tmp-') || rel.includes('.tmp-home')) continue
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const patterns = isTextLike(rel) ? COMMON_PATTERNS : [...COMMON_PATTERNS, ...CODE_PATTERNS]
  for (let i = 0; i < lines.length; i++) {
    scanned += 1
    if (isComment(lines[i])) continue // 注释里允许说明性提及（含通用绝对路径示例）
    for (const [re, label] of patterns) {
      if (!re.test(lines[i])) continue
      check(`hardcode scan ${rel}:${i + 1} [${label}]`, false, lines[i].trim().slice(0, 120))
    }
  }
}
check('hardcode scan finished (' + scanned + ' lines)', true)

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
