# M-VPN-08 P3 synthetic runner

This directory contains the reproducible local P3 harness for the Go
revocation flow. It is **synthetic fixture only**: it never contacts
production, AWS/SSM, system OpenVPN, or any host service.

## Prerequisites

- Docker.
- Local fixture image `nexo-mvpn08-openvpn:local` built from
  OpenVPN `2.6.14-0+deb12u2`. The runner checks `OpenVPN 2.6.14` and records
  the image ID.
- `golang:1.27.3-bookworm`.
- Writable host base directory `/tmp/opencode/mvpn08` (override with
  `NEXO_MVPN08_P3_BASE`).
- By default each run creates a unique root and evidence directory:
  - root: `<base>/roots/<run-id>`;
  - evidence: `<base>/evidence/<run-id>`;
  - state pointer directory: `<base>/current-run` (parsed files, never
    `source`d).
  Previous roots and evidence are preserved.
- `NEXO_MVPN08_P3_HOST_ROOT` can force a root, but it must be empty; the runner
  refuses to overwrite a prepared/non-empty root.
- `NEXO_MVPN08_P3_EVIDENCE_DIR` can force an evidence directory, but it must be
  empty; a non-empty evidence directory is rejected before running.
- Before preparing a new run, the runner parses `current-run`; an invalid state
  or a previous run whose container still exists is rejected. Run `cleanup` for
  that previous run first.

## One-command run

```bash
bash product/agent/internal/vpnruntime/testdata/mvpn08-p3/run.sh all
```

All Docker runs use the locally available images with `--pull=never`; the
repository checkout is mounted read-only at `/src`, and only the fixture root
is writable.

This executes, in order:

1. `prepare`: generates a synthetic PKI, CRL, target and control client
   records/certificates under the fixture root.
2. `fixture`: starts exactly one isolated Docker container with
   `--network none --cap-add NET_ADMIN --device=/dev/net/tun`, runs
   OpenVPN 2.6.14 server with a Unix management socket and
   `management-client-user root`, starts target and control clients, and
   waits until both are present in `status 3`. It sends only `status 3`.
   The container is labelled with a runner identity and run id. If the
   fixture image lacks group `nobody` (observed image has `nogroup`), the
   disposable container creates a local `nobody` group with `groupadd` or
   `addgroup`; it never installs packages or uses the network.
3. `p3`: runs `TestP3RevocationEndToEnd` against the same fixture root and
   Unix socket, with `--network none` on the Go container.
4. evidence: copies sanitized logs, OpenVPN version, image ID, Go image ID,
   `git rev-parse HEAD`, brief `git status` of `product/agent`, a content/path
   SHA-256 fingerprint of the exact `product/agent` tree including untracked
   files, Go test output and exit code. Relevant files include
   `git-head.txt`, `git-status-product-agent.txt`,
   `product-agent-tree.sha256`, `product-agent-source.tar`,
   `product-agent-source.tar.sha256`, `go-image-id.txt`,
   `fixture-image-id.txt`, `openvpn-version.txt`, `status.txt`,
   `go-test.log` and `go-test.exit`. The source archive contains only
   `product/agent` (modes/symlinks preserved) and is not a repository-wide
   archive. It excludes only private material: `.p12`, `.pfx`, `.env`, and
   `.pem`/`.key` files that actually contain a private-key block. Public
   `.pem`/`.key` fixtures and all Go/test inputs are preserved, so the tested
   artifact can be reconstructed.
   Logs, `status.txt` and `p3.json` are collected by a local
   `golang:1.27.3-bookworm` helper container run as root with
   `--pull=never --network none --user 0:0`, mounting `P3_ROOT:/p3root:ro` and
   `EVIDENCE_DIR:/evidence` (writable). The helper redacts multiline
   private-key blocks, including markers with log prefixes and
   `OpenVPN Static key V1` blocks, writes readable `0644` outputs, and fails
   closed if a required artifact is missing/empty or a key block cannot be
   closed. If this collection fails, cleanup removes neither the container nor
   the run state.
   Before `p3`, traceability must succeed: HEAD, status, tree hash, source tar,
   tar hash and both image IDs are mandatory; failure aborts without running
   P3. Evidence packing requires non-empty logs/status/p3.json plus
   `go-test.log`, `go-test.exit`, the traceability files and both image
   identities. A present `go-test.exit` value of `1` is acceptable when P3
   failed; a missing/empty artifact is not.
5. cleanup: parses/validates `current-run`, verifies the runner label/run-id,
   and removes only the owned fixture container. A container with the configured
   name but no matching runner label/run-id is never copied or deleted. If
   `docker rm -f` fails, cleanup returns an error and preserves the run-id and
   current-run state for recovery; `all` then exits non-zero even if P3 passed.
   If the state is valid but the container does not exist, cleanup removes only
   the matching run marker and current-run pointer, preserving root/evidence.

## Separate steps

```bash
bash product/agent/internal/vpnruntime/testdata/mvpn08-p3/run.sh prepare
bash product/agent/internal/vpnruntime/testdata/mvpn08-p3/run.sh fixture
bash product/agent/internal/vpnruntime/testdata/mvpn08-p3/run.sh p3
bash product/agent/internal/vpnruntime/testdata/mvpn08-p3/run.sh cleanup
```

The fixture container is named `nexo-mvpn08-p3-<run-id>` by default. `fixture`
leaves it running so `p3` can execute; `cleanup` removes only that owned
container. If the name already exists or the `current-run` state is invalid or
still has an existing container, `fixture`/`prepare` refuse to continue.

## Direct Go commands

The same steps can be run manually with the exact commands recorded in
`<base>/evidence/<run-id>/commands.txt`; the wrapper exists only to make the
OpenVPN daemon/client lifecycle and evidence collection unambiguous.

## Limits

- Synthetic CA/CRL/clients and a real OpenVPN 2.6.14 daemon inside an isolated
  container.
- Final `status 3` is the agreed observation. It does **not** prove data-plane
  traffic.
- The runner must not be pointed at a shared or production management socket.
- P3 PASS requires both `T_accept − T0 ≤ 2 s` and
  `T_caída − T0 ≤ 10 s`, measured by the Go harness from one monotonic T0.
