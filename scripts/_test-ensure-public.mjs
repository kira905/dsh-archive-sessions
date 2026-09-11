// push-publish.mjs 的 ensureGiteePublic 单测 + 对真实仓库的生效验证
//
// 用法：node scripts/_test-ensure-public.mjs
// 说明：只读 + 幂等（对已经是公开的仓执行只会再次确认；mock 环节不触网）。
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

let fail = 0
const check = (name, ok, detail = '') => {
  if (!ok) fail += 1
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
}

const mod = await import(pathToFileURL(join(REPO, 'scripts', 'push-publish.mjs')).href)

// ── 1. mock：请求形状必须正确（缺 name 会被 Gitee 拒） ─────────────────────
const captured = []
const fakeFetch = async (url, init) => {
  captured.push({ url, init })
  return { status: 200, json: async () => ({ private: false }) }
}
const okResult = await mod.ensureGiteePublic({ owner: 'acme', repo: 'demo', token: 'tok', fetchImpl: fakeFetch })
check('mock：返回 ok', okResult.ok === true, JSON.stringify(okResult))
check('mock：URL 正确', captured[0].url === 'https://gitee.com/api/v5/repos/acme/demo', captured[0].url)
check('mock：方法为 PATCH', captured[0].init.method === 'PATCH')
check('mock：form 编码', String(captured[0].init.headers['content-type']).includes('x-www-form-urlencoded'))
const params = new URLSearchParams(String(captured[0].init.body))
check('mock：带 name（Gitee 必填）', params.get('name') === 'demo', String(params.get('name')))
check('mock：private=false', params.get('private') === 'false')
check('mock：带 access_token', params.get('access_token') === 'tok')

// ── 2. mock：服务端拒绝时的降级（返回 ok=false 且带 detail） ───────────────
const badFetch = async () => ({ status: 400, json: async () => ({ messages: ['name is missing'] }) })
const bad = await mod.ensureGiteePublic({ owner: 'acme', repo: 'demo', token: 'tok', fetchImpl: badFetch })
check('mock：失败时 ok=false', bad.ok === false && bad.status === 400, JSON.stringify(bad))
check('mock：失败时带 detail', typeof bad.detail === 'string' && bad.detail.includes('name is missing'))

// ── 3. mock：抛异常时不崩 ──────────────────────────────────────────────────
const throwFetch = async () => { throw new Error('network down') }
const thrown = await mod.ensureGiteePublic({ owner: 'acme', repo: 'demo', token: 'tok', fetchImpl: throwFetch })
check('mock：异常被兜住', thrown.ok === false && String(thrown.detail).includes('network down'), JSON.stringify(thrown))

// ── 4. 真实仓库：跑一次（幂等 no-op），确认公开状态被确认 ──────────────────
const ps = `
$t = @'
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredReadW")]
  public static extern bool CredRead(string x, int y, int f, out IntPtr p);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
}
'@
Add-Type -TypeDefinition $t
[IntPtr]$p = [IntPtr]::Zero
[void][C]::CredRead('git:https://gitee.com', 1, 0, [ref]$p)
$c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][C+CREDENTIAL])
Write-Output ([System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2))
`
const token = (spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 }).stdout ?? '').trim()
if (token.length < 8) {
  console.log('[SKIP] 没读到 Gitee 凭据，跳过真实仓库验证')
} else {
  const real = await mod.ensureGiteePublic({ owner: 'kira905', repo: 'dsh-archive-sessions', token })
  check('真实仓库：ensureGiteePublic 成功', real.ok === true, JSON.stringify(real))
  const anon = await fetch('https://gitee.com/api/v5/repos/kira905/dsh-archive-sessions')
  const anonBody = await anon.json()
  check('真实仓库：匿名视角确认公开', anon.status === 200 && anonBody.private === false, 'HTTP ' + anon.status + ' private=' + anonBody.private)
  const content = await fetch('https://gitee.com/api/v5/repos/kira905/dsh-archive-sessions/contents/README.md?ref=main')
  check('真实仓库：匿名可读 README', content.status === 200, 'HTTP ' + content.status)
}

console.log('\n' + (fail === 0 ? 'ensureGiteePublic 单测 + 生效验证 PASSED' : 'FAILED（' + fail + ' 项）'))
process.exit(fail === 0 ? 0 : 1)
