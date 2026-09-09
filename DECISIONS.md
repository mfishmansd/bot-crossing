# Decisions

Things that are settled, and why. If a PR argues with one of these, the PR is not wrong — but
it needs to argue with the reason rather than work around it.

Written down because the same questions kept arriving one PR at a time, and answering them
per-PR was producing a codebase with three answers to each.

## Bot Crossing writes one flag to a harness, and nothing else

`data/colony.json` is the colony's own file and the only one the browser writes. The server
makes exactly one write outside it: `isArchived` on Claude Code's own session record, so a
thread archived here lands in Claude Code's Archived list rather than only leaving the map.

That write is known to be awkward. The desktop app serves from the copy of its records it
loaded at launch, so the thread stays put in its own list until the app restarts, and the app
rewrites the record from memory the next time it touches the thread. The answer is to re-assert
the flag on every scan and stop there: no `ps` sweep to guess whether the app has re-read the
file, and no *pending* state on the astronaut. It boards the ship either way, and the app
catches up on its next launch.

An adapter for a harness with no archived state of its own simply leaves `setArchived` out.
Nothing else — not a transcript, not a session record, not a second key — is ever written.

## Nothing is read from or executed inside another application's bundle

Only files under the user's own home directory.

This is not a style preference. An adapter that fell back to
`/Applications/ChatGPT.app/Contents/Resources/codex` and ran it set off a Gatekeeper malware
alert on the maintainer's machine and moved both Codex.app and ChatGPT.app to the Trash —
nothing was wrong with either, but OpenAI's macOS signing certificate had been revoked after the
Axios npm compromise, and macOS's answer to *executing* a binary under a revoked cert is to
block it and bin the app. It also cost five seconds on the first scan while macOS decided.

`claude-code.mjs` used to mention `/Claude.app/Contents/MacOS/Claude`, but that was matching a
string in `ps` output to spot a running process, never launching anything. That code is gone
now anyway; the scan starts no subprocess at all. The `cursor` command is found on `PATH` or not
at all — never inside `Cursor.app`.

## Opening a thread may run a command; nothing else may

Opening is the one place a subprocess is allowed, because there is no other way to hand a
session back on a machine with no desktop app. It goes through a URL the OS resolves, or a
binary the user already has on `PATH` — never a path we guessed inside an app.

## There is one way for an adapter to say "open this"

`openThread(ref)` and `newSession(dir)` return `{ ok, url, command }`, either may be async, and
the server decides what to do with it:

- **macOS and Windows** — the URL goes to the OS opener. A scheme the harness's app registers is
  always answered there, so nothing is probed.
- **Linux** — the scheme is checked with `xdg-mime` first, because `xdg-open` on a scheme nobody
  claims exits quietly and used to reach the page as "Opened". Failing that, `command` runs in a
  terminal. Failing that, the page is told the truth.

`command` is `{ argv, cwd }` with an absolute `argv[0]` for a CLI that needs a terminal. A
plain argument list — `[bin, ...args]` — is the other shape: a launcher the adapter would rather
run than its URL, on any platform, detached. Cursor's `cursor <dir>` opens a folder as a
workspace where `cursor://file/<dir>` brings the app up and opens nothing. No harness knowledge
reaches `launch()` — that seam is the reason `server/harnesses/` is swappable at all.

## `sizeBytes` is bytes

Every harness has a transcript file; not all of them report tokens, and a CLI-only session
often has no token count at all. The field is a shared log scale across the whole map, so
mixing units would make one harness's buildings taller than another's for the same work.

## Thread ids are prefixed

`claude-code:<uuid>`, `codex:<uuid>`, `cursor:<uuid>`, `git-repos:<path>#<branch>`. Two UUIDs
will not collide, but the colony keys its archive list and saved layout on this string, and it
is worth being unambiguous rather than merely lucky. `colony.json` v1 files are migrated on read — only Claude Code ever wrote a bare
id, so the rewrite is unambiguous.

## A harness that cannot read its own store says so

Optional `diagnostic()` on an adapter returns a sentence, or `''`. Without it the failure mode
is a harness that reports `detected: true`, throws inside `scanThreads` on every poll, and looks
perfectly healthy in the HUD while contributing nothing.
