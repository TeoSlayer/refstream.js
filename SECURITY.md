# Security policy

For the encryption boundary, endpoint trust, file transports and retained data,
read [Security and end-to-end encryption](docs/security.md).

## Report privately

Use [GitHub's private vulnerability reporting](https://github.com/TeoSlayer/refstream.js/security/advisories/new)
for suspected vulnerabilities. Include the affected version or commit, impact
and a minimal reproduction using your own disposable data. Do not put a real
invitation, terminal transcript, file URL with credentials, or session snapshot
in a public issue.

Relevant areas include encrypted relay payloads, input/read permissions,
cross-session access, file authorization, preview rendering and resource bounds.
An explicitly authorized recipient reading or copying shared output is within
the documented trust boundary.

## Versions and scope

Refstream is an alpha library. Fixes are developed on `main` and released as
new versions; no long-term support policy is promised for older alpha releases.
The project has automated security tests and has not undergone an independent
cryptographic audit. Known protocol limits, including the absence of forward
secrecy, are documented in the [security model](docs/security.md#protocol-details).

The reference relay is maintained with
[Shell.online](https://github.com/TeoSlayer/shell.online). Report deployment-specific
issues through [that repository's private reporting](https://github.com/TeoSlayer/shell.online/security/advisories/new).
Use your own sessions when testing and do not disrupt the public relay.
