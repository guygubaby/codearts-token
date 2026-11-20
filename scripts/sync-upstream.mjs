#!/usr/bin/env node
// Re-applies this fork's account-file sign-in on top of the newest upstream
// packages/codearts, runs the tests, and pushes only when they pass.
//
//   node scripts/sync-upstream.mjs [--dry-run]
//
// The runtime files come from upstream; the fork's own pieces — the parser,
// the import page, the one method this card offers — live in scripts/patch/ as
// plain text and are re-applied by anchor. README and tests are this repo's
// own and are never synced.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const UPSTREAM = "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/codearts"
const API = "https://api.github.com/repos/magpie-community/plugins/contents/packages/codearts"
const dry = process.argv.includes("--dry-run")
const repatch = process.argv.includes("--repatch")
const sha = (s) => createHash("sha256").update(s).digest("hex")
const read = (p) => readFileSync(join(root, p))
const write = (p, s) => writeFileSync(join(root, p), s)
const fail = (msg) => {
  console.error(`sync-upstream: ${msg}`)
  process.exit(1)
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
const once = (src, needle, what) => {
  const n = src.split(needle).length - 1
  if (n !== 1) fail(`${what}: anchor found ${n} times in upstream index.mjs; update scripts/patch or the anchors`)
  return src.indexOf(needle)
}

if (git("status", "--porcelain").trim()) fail("working tree isn't clean; commit or stash first")

// One fetch, retried once: the sync runs unattended.
const headers = { "user-agent": "codearts-token-sync", accept: "application/vnd.github+json" }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
async function get(url, what) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
      if (res.ok) return await res.text()
      if (res.status < 500 || i >= 2) fail(`can't fetch ${what}: HTTP ${res.status}`)
    } catch (e) {
      if (i >= 2) fail(`can't fetch ${what}: ${e?.message ?? e}`)
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
  }
}

// every runtime file the upstream package ships (the README, LICENSE and the
// tests are not synced: this repo has its own)
const listing = JSON.parse(await get(API, "the upstream package listing"))
if (!Array.isArray(listing)) fail("the upstream package listing isn't a directory")
const NAMES = listing
  .filter((x) => x.type === "file")
  .filter((x) => x.name === "package.json" || (x.name.endsWith(".mjs") && !x.name.endsWith(".test.mjs")))
  .map((x) => x.name)
  .sort()
if (!NAMES.includes("index.mjs") || !NAMES.includes("package.json")) fail("the upstream package has no index.mjs or package.json")

const up = {}
for (const n of NAMES) up[n] = await get(`${UPSTREAM}/${n}`, n)
const upVersion = JSON.parse(up["package.json"]).version
const hashes = Object.fromEntries(NAMES.map((n) => [n, sha(up[n])]))
const statePath = join(root, "upstream.json")
const was = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null
if (!repatch && was && was.version === upVersion && NAMES.every((n) => was.files?.[n] === hashes[n])) {
  console.log(`up to date: ${upVersion}`)
  process.exit(0)
}

const helpers = readFileSync(join(root, "scripts/patch/import-helpers.js.txt"), "utf8")
const method = readFileSync(join(root, "scripts/patch/import-method.js.txt"), "utf8")
const hooks = readFileSync(join(root, "scripts/patch/import-hooks.js.txt"), "utf8")
const note = readFileSync(join(root, "scripts/patch/header-note.js.txt"), "utf8")

let index = up["index.mjs"]
if (index.includes("function importedAccountsIn")) fail("upstream index.mjs already holds the account-file patch")

// the fork, said in the header where a reader of the file meets it
const header = "// signed-request flow. See README.md."
once(index, header, "header")
index = index.replace(header, `${header}\n//\n${note.trimEnd()}`)

// a provider id of its own, so the official plugin can be installed beside
// this one instead of conflicting with it
once(index, 'const PROVIDER = "codearts"', "provider id")
index = index.replace('const PROVIDER = "codearts"', 'const PROVIDER = "codearts-token"')
once(index, '      p.name ??= "CodeArts"', "provider name")
index = index.replace('      p.name ??= "CodeArts"', '      p.name ??= "CodeArts Token"')

// the parser and the account-file page, before the plugin's section
const divider = "// ---- the plugin -------------------------------------------------------------"
once(index, divider, "plugin section")
index = index.replace(divider, `${helpers.trimEnd()}\n\n${divider}`)

// the one method, in place of upstream's sign-ins
const returnAnchor = "  return {\n    // The provider and the models it has before anyone is signed in."
once(index, returnAnchor, "factory return")
index = index.replace(returnAnchor, `${method.trimEnd()}\n\n${returnAnchor}`)

// the hooks that serve it: magpie's import, and the method list
const methodsStart = "      // The browser sign-in first, always; the CodeArts Agent's second, only"
once(index, methodsStart, "methods getter")
const getterTail = "      },\n    },\n  }\n}"
const stop = index.indexOf(getterTail, index.indexOf(methodsStart))
if (stop < 0) fail("methods getter: tail not found in upstream index.mjs")
index = index.slice(0, index.indexOf(methodsStart)) + `${hooks.trimEnd()}\n` + index.slice(stop + "      },\n".length)

// what the tests reach the parser through
const internals = "  checkIdeCredential, renewFromIde, openSqlite,\n}"
once(index, internals, "internal exports")
index = index.replace(
  internals,
  "  checkIdeCredential, renewFromIde, openSqlite,\n  importedExpiry, importedAccountCredential, importedAccountsIn, prepareImportedAccount, startImportPage,\n}",
)

write("index.mjs", index)
write(
  "opencode.mjs",
  '// The package\'s OpenCode 1.x plugins, as OpenCode 1.x and magpie\'s host\n' +
    "// load them: its plugin functions and nothing else (1.x refuses a\n" +
    "// package whose exports include anything but plugins). OpenCode 2.x\n" +
    "// loads opencode2.mjs, which runs these.\n" +
    "//\n" +
    "// This fork serves the CodeArts card only, on provider id `codearts-token`.\n" +
    "// The upstream package's OfficeAce card is not exported here: it belongs to\n" +
    "// @magpie-community/opencode-codearts-auth, and this package's point is the\n" +
    "// account-file sign-in for CodeArts.\n" +
    'export { CodeArtsAuthPlugin } from "./index.mjs"\n',
)
write("opencode2.mjs", up["opencode2.mjs"])
const pkg = JSON.parse(read("package.json").toString())
pkg.version = upVersion
write("package.json", `${JSON.stringify(pkg, null, 2)}\n`)

try {
  execFileSync("node", ["--check", "index.mjs"], { cwd: root, stdio: "inherit" })
  execFileSync("node", ["--test", "import.test.mjs"], { cwd: root, stdio: "inherit" })
} catch (e) {
  git("restore", "--", "index.mjs", "opencode.mjs", "opencode2.mjs", "package.json")
  fail(`the synced plugin failed its tests; files restored (exit ${e.status ?? 1})`)
}

if (dry) {
  // byte-identical to what is committed means the anchors reproduce the fork
  const changed = git("diff", "--name-only", "--", "index.mjs", "opencode.mjs", "opencode2.mjs", "package.json").trim()
  git("restore", "--", "index.mjs", "opencode.mjs", "opencode2.mjs", "package.json")
  console.log(`dry run: would sync to ${upVersion}${changed ? ` (differs: ${changed.replace(/\n/g, ", ")})` : " (identical to the committed files)"}`)
  process.exit(0)
}

writeFileSync(statePath, `${JSON.stringify({ version: upVersion, files: hashes, syncedAt: new Date().toISOString() }, null, 2)}\n`)
git("add", "-A")
git("commit", "-m", `chore: sync upstream codearts plugin to ${upVersion}`)
git("push", "origin", "main")
console.log(`synced to ${upVersion}`)
