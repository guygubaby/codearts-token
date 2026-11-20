// The package's OpenCode 1.x plugins, as OpenCode 1.x and magpie's host
// load them: its plugin functions and nothing else (1.x refuses a
// package whose exports include anything but plugins). OpenCode 2.x
// loads opencode2.mjs, which runs these.
//
// This fork serves the CodeArts card only, on provider id `codearts-token`.
// The upstream package's OfficeAce card is not exported here: it belongs to
// @magpie-community/opencode-codearts-auth, and this package's point is the
// account-file sign-in for CodeArts.
export { CodeArtsAuthPlugin } from "./index.mjs"
