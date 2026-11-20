# codearts-token

A **CodeArts (华为云码道)** account-file sign-in for magpie, on a provider id of
its own: **`codearts-token`**. It can be installed beside the official
[`@magpie-community/opencode-codearts-auth`](https://github.com/magpie-community/plugins/tree/main/packages/codearts)
without either plugin replacing the other.

One sign-in method: **account file (browser)** — a page opens with the browser's
own multi-select file picker. Choose one or more account JSON files, click
**Import**, and each file becomes its own account. magpie's own **Import
accounts from a file…** (Providers → CodeArts Token) is served too, by the same
parser.

This is what the fork adds; the card's models, credit rates, usage, renewals
and daily check-in are the upstream card's, unchanged.

## Install into magpie

From a terminal:

```sh
magpie plugin add guygubaby/codearts-token
```

Or in the app: **Plugins → Add a plugin** and pick this repository. The
official CodeArts plugin can stay installed: its card is `codearts`, this one
is `codearts-token`.

## Sign in

1. Open **Providers → CodeArts Token**.
2. Choose **Sign in**, then **CodeArts Token account file (browser)**.
3. In the page that opens, select one or more `.json` account files and click
   **Import**.
4. The page shows how many accounts were imported; close it and return to
   magpie.

The page is served by the plugin for that one sign-in only: a random token in
the URL, closed after the upload or after five minutes. Starting another import
closes the previous page and frees the port. `CODEARTS_IMPORT_PORT` (3432 by
default), `CODEARTS_IMPORT_HOST` (127.0.0.1) and `CODEARTS_IMPORT_BIND` point it
elsewhere.

## Account file

An **agent2api** export: an array of accounts, one account by itself, or
`{ "accounts": [ … ] }`. Each account carries the STS triple it was issued, the
refresh token, and the PKCE verifier and DPoP key those were signed with:

```json
[
  {
    "provider": "codearts",
    "access_key_id": "HST…",
    "secret_access_key": "…",
    "security_token": "hQ…",
    "refresh_token": "eyJ…",
    "expires_at": "2026-11-19T13:54:48.885Z",
    "domain_id": "01a1f3a8…",
    "user_name": "hw018728884571536",
    "oauth_context": {
      "dpop_key_pair": { "private_key_jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "d": "…" } },
      "pkce_pair": { "code_verifier": "…" }
    }
  }
]
```

Read from each entry: `access_key_id` (or `accessToken`), `secret_access_key`,
`security_token`, `refresh_token` (or `refreshToken`), `expires_at` (an ISO
string, or `expiresAt` in ms or s), `oauth_context.dpop_key_pair.private_key_jwk`,
`oauth_context.pkce_pair.code_verifier`, `domain_id`, `user_name`. The same
fields repeated under `pluginSecret` are read as well; an entry with
`provider` other than `codearts` is skipped.

An account is named by its identity: the URN in the refresh token's
`user_profile` claim (`iam::<domain>:user:<name>`), the same value a browser
sign-in with the official plugin gives — so re-importing an account updates its
record instead of adding a second one. The card shows the account's phone once
a renewal has read it from Huawei Cloud IAM.

### Renewed on import

Each account is **renewed with Huawei Cloud when it is imported**, the way the
official card's sign-in renews one. A Huawei Cloud refresh token is spent once,
so the file's copy (and the tool it came from) is signed out of that account
and has to export it again. This also brings an account whose temporary
credentials have already expired back to life: the refresh token and the
DPoP key are what a renewal signs with.

A refresh token STS turns away for good (`ExpiredRefreshToken`, `STS5.1806` —
spent, or past its 30 days) is reported as a failed account, with the reason;
the rest of the file still imports.

### What reaches magpie

Every imported account is written under `codearts-token#<8 hex of its
identity>`, so importing the same account again lands on the same record. The
first account is also the sign-in's own result. Imported credentials are
mainland (`cn-north-4`, the station agent2api exports are from); the code the
upstream package has for the international station is kept, unused.

Each account holds its own refresh token and is renewed alone. OfficeAce is not
part of this package: it has its own card and its own sign-in in the official
plugin.

## Development

```sh
bun test          # or: node --test
```

`import.test.mjs` covers the parser, the import page and magpie's import hook.
`node scripts/sync-upstream.mjs [--dry-run]` re-applies the fork onto the newest
upstream `packages/codearts` — the fork's own pieces live in `scripts/patch/`
and are re-applied by anchor — runs the tests, and pushes only when they pass.

## Unofficial

This package is not affiliated with, authorized or endorsed by Huawei, Huawei
Cloud or CodeArts; their names and marks belong to their owners. It talks to
the non-public APIs the CodeArts client uses and identifies itself the way that
client does, which may not be allowed by Huawei Cloud's terms of service and
may change at any time. Use it at your own risk, including the risk of
restrictions on your account.
