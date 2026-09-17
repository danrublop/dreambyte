# Security Policy

## Supported versions

Dreambyte is pre-1.0. Security fixes land on `main` and ship in the next release; only the
latest published release is supported.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/danrublop/dreambyte/security/advisories/new).
Include the affected version or commit, steps to reproduce, and the impact you observed.

You should get an acknowledgement within a few days. Once a fix is available we will publish
an advisory and credit you unless you prefer to stay anonymous.

## Scope

Of particular interest:

- Escapes from the scene sandbox (generated scene HTML reaching the app origin, the preload API,
  or Node.js)
- Handling of the `dreambyte://` protocol and file access outside the app's data directories
- Leakage of stored provider API keys
- The local MCP bridge/socket accepting unauthenticated callers

Vulnerabilities in third-party providers or dependencies should be reported upstream; tell us too
if Dreambyte's usage makes them exploitable.
