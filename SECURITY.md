# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/Amahdip/vidscope/security/advisories/new)
("Report a vulnerability" on the repository's Security tab), not in a public issue. Say what an
attacker can do, how to reproduce it, and which version or commit you tested.

You will get an acknowledgement within a few days. Fixes are made on `main`; there are no
maintained release branches.

## What to expect from Vidscope

- The local server (`bin/vidscope.js`) listens on 127.0.0.1 by default, answers only requests
  addressed to localhost (a guard against DNS rebinding), and serves only the files named on
  its command line or opened through its file menu.
- Files dropped onto the page, or opened from a static host, are read in the browser and never
  uploaded.
- Parsers treat every file as untrusted input: a malformed or hostile file should produce an
  error or a warning in the viewer, never a hang of the page or access to anything else. A file
  that breaks this is a security bug.
- `vidscope audit` fetches URLs you give it with HTTP range requests, and refuses a server that
  would send a whole large file instead.
