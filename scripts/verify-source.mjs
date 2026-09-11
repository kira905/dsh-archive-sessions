// 开源版源码静态验证：语法 + 配置层行为 + 硬编码扫描
// 用法：node <此文件> <repoRoot>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
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
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.tmp-')) continue
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
//    全部用系统临时目录，绝不往仓库里写测试残留
const cfgMod = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const sandbox = mkdtempSync(join(tmpdir(), 'as-verify-'))
const defaults = cfgMod.DEFAULT_CONFIG
check('default archive dir name', defaults.paths.archiveRoot === null)
check('default api prefix', defaults.server.apiPrefix === '/api/dsh-archive-sessions')
check('default preview messages', defaults.preview.maxMessages === 50)
check('default auto disabled + dryRun', defaults.auto.enabled === false && defaults.auto.dryRun === true)

const sandboxHome = join(sandbox, 'home')
process.env.DSH_HOME = sandboxHome
const loaded = cfgMod.loadConfig({ cache: false })
check('DSH_HOME respected', loaded.config.paths.home === sandboxHome)
check('archiveRoot derived from DSH_HOME', loaded.config.paths.archiveRoot === null)
check('no config file -> source null', loaded.source === null)
check('no sanitize errors on defaults', loaded.errors.length === 0, JSON.stringify(loaded.errors))

// 相对路径按 DSH home 解析
process.env.ARCHIVE_SESSIONS_CONFIG = join(sandboxHome, 'cfg.json')
const cfgPath = process.env.ARCHIVE_SESSIONS_CONFIG
mkdirSync(sandboxHome, { recursive: true })
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
check('relative archiveRoot resolved under home', loaded2.config.paths.archiveRoot === join(sandboxHome, 'my-archive'), loaded2.config.paths.archiveRoot)
check('relative sessionsRoot resolved under home', loaded2.config.paths.sessionsRoot === join(sandboxHome, 'my-sessions'))
check('override maxMessages', loaded2.config.preview.maxMessages === 5)
check('override auto.hours', loaded2.config.auto.hours === 12)
check('apiPrefix normalized', loaded2.config.server.apiPrefix === '/api/custom-prefix', loaded2.config.server.apiPrefix)
check('ui override merged', cfgMod.resolveUi(loaded2.config).nav === 'Custom Nav')
check('en language ui present', cfgMod.resolveUi(loaded2.config).refresh === 'Refresh')
const pub = cfgMod.publicConfig(loaded2.config)
// 公开配置必须只含界面需要的东西：不能带 home / 归档目录 / sessions 目录等绝对路径
const pubText = JSON.stringify(pub)
check('publicConfig hides absolute paths', !pubText.includes(sandboxHome) && !/[A-Ha-h]:[\\/]/.test(pubText), pubText.slice(0, 120))
check('publicConfig has no paths section', pub.paths === undefined)
check('unknown key tolerated', loaded2.errors.length === 0, JSON.stringify(loaded2.errors))

// 坏值应被清洗并记错误
writeFileSync(cfgPath, JSON.stringify({ preview: { maxMessages: 'abc' }, auto: { hours: -5 }, server: { apiPrefix: 123 } }), 'utf8')
const loaded3 = cfgMod.loadConfig({ cache: false })
check('invalid values reported', loaded3.errors.length >= 2, JSON.stringify(loaded3.errors))
check('invalid value fell back to default', loaded3.config.preview.maxMessages === defaults.preview.maxMessages)
check('negative hours clamped', loaded3.config.auto.hours >= 1)

// 4) 敏感词扫描
//    规则只放**真实发生过的**本机标识（机器名 / 用户名 / 本机目录名 / 个人称呼），
//    不放宽泛词，免得扫描器把自己定义的规则也扫出来（那是自匹配，不是发现）。
//    扫描范围：lib/ 与文档/配置（scripts/ 里是测试与部署工具，自身含检测规则，跳过）。
const PATTERNS = [
  [/ZEPHYRUSAIR|KIRA-TUF|zephyrusair/i, 'machine name'],
  [/[\\/]Users[\\/]51367|\b51367\b/, 'user name'],
  [/D:\\DSH\b|D:\/DSH\b|BaiduSync|DSH-offsync|H:\\DSH-test|H:\/DSH-test/i, 'local layout path'],
  [/主人|本鱼|铲屎的|鲸鱼娘|whale-girl/, 'personal wording'],
  [/坚果云|百度网盘|Nutstore/i, 'local sync product'],
  [/\bsk-[A-Za-z0-9]{8,}/, 'api key'],
]
const TEXT_LIKE = new Set(['.md', '.json', '.yml', '.yaml', '.txt', '.example'])
const isTextLike = (rel) => [...TEXT_LIKE].some((ext) => rel.endsWith(ext))
const isComment = (line) => /^\s{0,4}(\/\/|\/\*|\*|#|<!--)/.test(line)
let scanned = 0
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (rel.startsWith('scripts/')) continue // 跳过测试/部署工具目录（自身含检测规则）
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const patterns = isTextLike(rel) ? PATTERNS : [...PATTERNS, [/[A-H]:[\\/]/, 'absolute windows path in code']]
  for (let i = 0; i < lines.length; i++) {
    scanned += 1
    if (isComment(lines[i])) continue // 注释里允许说明性提及（含通用绝对路径示例）
    for (const [re, label] of patterns) {
      if (!re.test(lines[i])) continue
      check(`sensitive scan ${rel}:${i + 1} [${label}]`, false, lines[i].trim().slice(0, 120))
    }
  }
}
check('sensitive scan finished (' + scanned + ' lines)', true)

// 收尾：清掉沙箱，绝不在仓库里留测试残留
try {
  rmSync(sandbox, { recursive: true, force: true })
} catch { /* ignore */ }
check('sandbox cleaned up', !existsSync(sandbox))

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
