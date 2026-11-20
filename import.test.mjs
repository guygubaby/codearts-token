// The fork's tests: the account-file sign-in (both faces of it) and the
// contract this card has with magpie. The upstream package's own suite covers
// the card's request path; it runs there, against the upstream file.
//
// Run with: bun test (node --test runs it too).

import { test } from "node:test"
import assert from "node:assert/strict"

import { CodeArtsAuthPlugin, _internal as x } from "./index.mjs"

// ---- fixtures --------------------------------------------------------------

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")

// A refresh token shaped as STS issues it: a JWT whose user_profile claim
// names the signer (that is where accountIdentityOf reads the URN from).
function refreshJwt(urn, over = {}) {
  const account = urn.split(":user:")[1] ?? urn
  const payload = {
    user_profile: JSON.stringify({ principal_urn: urn, account_name: account, account_id: `d-${account}` }),
    client_id: "codearts-agent",
    exp: 4102444800,
    ...over,
  }
  return `h.${b64u(payload)}.s`
}

let keys = null
async function dpopKeys() {
  keys ??= await x.generateDpopKeyPair()
  return keys
}

// One entry of an agent2api export, as the file carries them (the access
// credentials long expired: the refresh token is what brings it back).
async function account(n, over = {}) {
  const kp = await dpopKeys()
  const urn = `iam::domain${n}:user:hw0000000000000${n}`
  return {
    provider: "codearts",
    format: "agent2api-account",
    access_key_id: `AK${n}`,
    accessToken: `AK${n}`,
    secret_access_key: `SK${n}`,
    security_token: `ST${n}`,
    refresh_token: refreshJwt(urn),
    refreshToken: refreshJwt(urn),
    expires_at: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: Date.now() - 3600_000,
    domain_id: `domain${n}`,
    user_name: `hw0000000000000${n}`,
    name: `hw0000000000000${n}`,
    oauth_context: {
      dpop_key_pair: { private_key_jwk: kp.privateKeyJwk, public_key_jwk: kp.publicKeyJwk },
      pkce_pair: { code_challenge_method: "SHA-256", code_verifier: `verifier-${n}` },
    },
    ...over,
  }
}

// The STS refresh answer: a fresh STS triple and a refresh token for the same
// signer (what STS gives — the account does not change on a renewal).
function stsFetcher({ calls = [], reject } = {}) {
  let n = 0
  return async (url, init) => {
    const body = String(init?.body ?? "")
    calls.push({ url: String(url), body })
    if (String(url).startsWith(x.STS_TOKEN_ENDPOINT)) {
      if (reject) {
        return Response.json({ error: "invalid_grant", error_description: "ExpiredRefreshToken" }, { status: 400 })
      }
      n += 1
      const sent = new URLSearchParams(body).get("refresh_token") ?? ""
      const claims = sent.split(".").length === 3 ? JSON.parse(Buffer.from(sent.split(".")[1], "base64url").toString()) : {}
      return Response.json({
        credentials: {
          access_key_id: `AK-renewed-${n}`,
          secret_access_key: `SK-renewed-${n}`,
          security_token: `ST-renewed-${n}`,
          expiration: new Date(Date.now() + 3600_000).toISOString(),
        },
        refresh_token: refreshJwt(JSON.parse(claims.user_profile).principal_urn, { jti: `renewed-${n}` }),
      })
    }
    if (String(url).includes(x.IAM_HOST)) return Response.json({ error: "not found" }, { status: 404 })
    throw new Error(`unexpected request: ${url}`)
  }
}

function mockClient() {
  const saved = []
  const toasts = []
  return {
    saved,
    toasts,
    client: {
      auth: { set: async (o) => saved.push(o) },
      tui: { showToast: async (o) => toasts.push(o) },
    },
  }
}

const upload = (url, files) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }) })

async function importMethodOf(plugin) {
  const m = plugin.auth.methods.find((x) => /account file/.test(x.label))
  assert.ok(m, "the account-file method is there")
  return m
}

// the import page's env, restored after each test that opens one
async function withImportServer(fn) {
  process.env.CODEARTS_IMPORT_PORT = "0"
  process.env.CODEARTS_IMPORT_HOST = "127.0.0.1"
  try {
    return await fn()
  } finally {
    delete process.env.CODEARTS_IMPORT_PORT
    delete process.env.CODEARTS_IMPORT_HOST
  }
}

// ---- the card's contract ---------------------------------------------------

test("serves the CodeArts Token provider on an id of its own", async () => {
  const plugin = await CodeArtsAuthPlugin({ client: {} })
  const config = { provider: {} }
  await plugin.config(config)
  assert.equal(config.provider["codearts-token"].name, "CodeArts Token")
  assert.equal(plugin.provider.id, "codearts-token")
  assert.equal(plugin.auth.provider, "codearts-token")
  assert.equal(x.PROVIDER, "codearts-token", "apart from the official plugin's codearts card")
})

test("offers one sign-in: the account-file page", async () => {
  const plugin = await CodeArtsAuthPlugin({ client: {} })
  assert.equal(plugin.auth.methods.length, 1)
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.match(plugin.auth.methods[0].label, /CodeArts Token account file \(browser\)/)
  assert.equal(typeof plugin.auth.import, "function", "magpie's Import accounts from a file… is served too")
  assert.match(plugin.auth.importFrom, /agent2api|JSON/)
})

// ---- the parser ------------------------------------------------------------

test("importedExpiry takes an ISO string, milliseconds, or seconds", () => {
  assert.equal(x.importedExpiry("2026-12-19T10:43:01.000Z", undefined), "2026-12-19T10:43:01.000Z")
  assert.equal(x.importedExpiry(undefined, 1795096488885), new Date(1795096488885).toISOString())
  assert.equal(x.importedExpiry(undefined, 1795096488), new Date(1795096488 * 1000).toISOString())
  assert.equal(x.importedExpiry(undefined, undefined), "")
  assert.equal(x.importedExpiry(1795096488885, undefined), "", "a number in expires_at is not a date")
})

test("importedAccountCredential maps an agent2api export entry", async () => {
  const got = x.importedAccountCredential(await account(1))
  assert.equal(got.why, undefined)
  assert.equal(got.renewable, true)
  const c = got.cred
  assert.equal(c.access_key_id, "AK1")
  assert.equal(c.secret_access_key, "SK1")
  assert.equal(c.security_token, "ST1")
  assert.equal(c.code_verifier, "verifier-1")
  assert.equal(c.dpop_private_key_jwk.kty, "EC")
  assert.equal(c.domain_id, "domain1")
  assert.match(c.session_id, /^[0-9a-f]{32}$/, "a session of its own is minted at import")
  assert.equal(x.accountIdentityOf(c).id, "iam::domain1:user:hw00000000000001")
})

test("importedAccountCredential reads the fields agent2api repeats under pluginSecret", async () => {
  const a = await account(2)
  const nested = { ...a }
  for (const k of ["access_key_id", "secret_access_key", "security_token", "refresh_token", "domain_id", "user_name"]) delete nested[k]
  nested.pluginSecret = a
  const got = x.importedAccountCredential(nested)
  assert.equal(got.why, undefined)
  assert.equal(got.cred.access_key_id, "AK2")
  assert.equal(got.cred.refresh_token, a.refresh_token)
})

test("importedAccountsIn takes an array, one account, or { accounts }", async () => {
  const [a, b] = [await account(1), await account(2)]
  assert.equal(x.importedAccountsIn(JSON.stringify([a, b])).entries.length, 2)
  assert.equal(x.importedAccountsIn(JSON.stringify(a)).entries.length, 1)
  assert.equal(x.importedAccountsIn(JSON.stringify({ accounts: [a, b] })).entries.length, 2)
})

test("importedAccountsIn skips what this card cannot use, and says why", async () => {
  const good = await account(1)
  const { entries, skipped } = x.importedAccountsIn(JSON.stringify([
    good,
    { ...(await account(2)), provider: "workbuddy" },
    { access_key_id: "AK" },
    { ...(await account(3)), refresh_token: "", refreshToken: "", expires_at: new Date(Date.now() - 1000).toISOString() },
  ]))
  assert.equal(entries.length, 1)
  assert.equal(skipped.length, 3)
  assert.match(skipped[0].why, /not a CodeArts account/)
  assert.match(skipped[1].why, /no temporary credentials/)
  assert.match(skipped[2].why, /no refresh token/)
  assert.deepEqual(x.importedAccountsIn("{ broken").skipped.map((s) => s.why), ["not JSON"])
})

// ---- magpie's auth.import --------------------------------------------------

test("auth.import renews each account and returns one sign-in result per account", async () => {
  const fetcher = stsFetcher()
  const { client, saved } = mockClient()
  const plugin = await CodeArtsAuthPlugin({ client }, { fetch: fetcher })
  const results = await plugin.auth.import([JSON.stringify([await account(1), await account(2)])])
  assert.equal(results.length, 2)
  for (const r of results) {
    assert.equal(r.type, "success")
    assert.notEqual(r.refresh, undefined, "one-time tokens are spent here, so a new refresh goes back")
    assert.equal(typeof r.expires, "number")
    assert.match(r.accountId, /^iam::domain\d:user:hw0000000000000\d$/)
  }
  const first = JSON.parse(results[0].access)
  assert.equal(first.access_key_id, "AK-renewed-1", "the refreshed credential, not the file's")
  assert.equal(first.code_verifier, "verifier-1")
  assert.equal(saved.length, 0, "the host keeps what the hook returns; the plugin writes nothing")
})

test("auth.import reports a spent refresh token as a failed account", async () => {
  const plugin = await CodeArtsAuthPlugin({ client: {} }, { fetch: stsFetcher({ reject: true }) })
  const results = await plugin.auth.import(JSON.stringify(await account(1)))
  assert.equal(results.length, 1)
  assert.equal(results[0].type, "failed")
  assert.match(results[0].error, /export the account again/)
})

test("auth.import takes a single account by itself", async () => {
  const plugin = await CodeArtsAuthPlugin({ client: {} }, { fetch: stsFetcher() })
  const results = await plugin.auth.import(JSON.stringify(await account(5)))
  assert.equal(results.length, 1)
  assert.equal(results[0].type, "success")
})

// ---- the account-file page (a sign-in) -------------------------------------

test("serves a picker and imports every chosen file, each under its own hash key", () =>
  withImportServer(async () => {
    const { client, saved } = mockClient()
    const plugin = await CodeArtsAuthPlugin({ client }, { fetch: stsFetcher() })
    const m = await importMethodOf(plugin)
    const flow = await m.authorize()
    assert.equal(flow.method, "auto")
    assert.match(flow.url, /^http:\/\/127\.0\.0\.1:\d+\/import\?t=[0-9a-f]+$/)
    const page = await (await fetch(flow.url)).text()
    assert.match(page, /type="file"/)
    assert.equal((await fetch(flow.url.replace(/t=.*/, "t=nope"))).status, 404)

    const done = flow.callback()
    const [a, b] = [await account(1), await account(2)]
    const res = await upload(flow.url, [
      { name: "accounts-1.json", text: JSON.stringify([a, b]) },
    ])
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Imported 2 accounts/)
    const out = await done
    assert.equal(out.type, "success")
    assert.equal(out.accountId, "iam::domain1:user:hw00000000000001")
    assert.equal(JSON.parse(out.access).access_key_id, "AK-renewed-1")
    assert.equal(saved.length, 2)
    for (const s of saved) assert.match(s.path.id, /^codearts-token#[0-9a-f]{8}$/)
    assert.equal(saved[0].body.type, "oauth")
    assert.equal(saved[0].body.accountId, "iam::domain1:user:hw00000000000001")
    assert.equal(saved[1].body.accountId, "iam::domain2:user:hw00000000000002")
  }))

test("a bad file is skipped and the rest import", () =>
  withImportServer(async () => {
    const { client, saved, toasts } = mockClient()
    const plugin = await CodeArtsAuthPlugin({ client }, { fetch: stsFetcher() })
    const m = await importMethodOf(plugin)
    const flow = await m.authorize()
    const done = flow.callback()
    const res = await upload(flow.url, [
      { name: "good.json", text: JSON.stringify(await account(1)) },
      { name: "bad.json", text: "{ broken" },
    ])
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Imported 1 account, skipped 1/)
    assert.equal((await done).type, "success")
    assert.equal(saved.length, 1)
    assert.match(toasts[0].body.message, /skipped 1/)
  }))

test("a file with no account imports nothing", () =>
  withImportServer(async () => {
    const { client } = mockClient()
    const plugin = await CodeArtsAuthPlugin({ client }, { fetch: stsFetcher() })
    const m = await importMethodOf(plugin)
    const flow = await m.authorize()
    const done = flow.callback()
    const res = await upload(flow.url, [{ name: "a.json", text: JSON.stringify({ refreshToken: "r" }) }])
    assert.equal(res.status, 400)
    assert.match(await res.text(), /No account imported/)
    assert.equal((await done).type, "failed")
  }))

test("starting a second import closes the page the first left open", () =>
  withImportServer(async () => {
    const { client } = mockClient()
    const plugin = await CodeArtsAuthPlugin({ client }, { fetch: stsFetcher() })
    const m = await importMethodOf(plugin)
    const first = await m.authorize()
    const firstDone = first.callback()
    const second = await m.authorize()
    assert.match(second.url, /^http:\/\/127\.0\.0\.1:\d+\/import\?t=/)
    assert.equal((await firstDone).type, "failed")
    const done = second.callback()
    const res = await upload(second.url, [{ name: "a.json", text: JSON.stringify(await account(1)) }])
    assert.equal(res.status, 200)
    assert.equal((await done).type, "success")
  }))

test("re-importing the same account lands on the same record key", () =>
  withImportServer(async () => {
    const { client, saved } = mockClient()
    const plugin = await CodeArtsAuthPlugin({ client }, { fetch: stsFetcher() })
    const m = await importMethodOf(plugin)
    for (const round of [1, 2]) {
      const flow = await m.authorize()
      const done = flow.callback()
      await upload(flow.url, [{ name: `account-${round}.json`, text: JSON.stringify(await account(1)) }])
      await done
    }
    assert.equal(saved.length, 2)
    assert.equal(saved[0].path.id, saved[1].path.id, "the identity's hash names the record")
  }))
