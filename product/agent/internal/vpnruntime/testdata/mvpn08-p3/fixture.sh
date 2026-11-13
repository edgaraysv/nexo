#!/usr/bin/env bash
# Runs only inside the isolated fixture container. Starts the synthetic
# OpenVPN 2.6.14 server plus target/control clients, waits for both in
# status 3, and stays alive until the container is removed.
set -euo pipefail

: "${NEXO_MVPN08_P3_ENV:?}"
: "${TARGET_CN:?}"
: "${CONTROL_CN:?}"

ROOT=/p3root
ENV_DIR="$ROOT/$NEXO_MVPN08_P3_ENV"
PKI="$ENV_DIR/pki"
CLIENTS="$ROOT/clients"

log() {
	printf '[mvpn08-fixture] %s\n' "$*"
}

cleanup() {
	for pid_name in server target control; do
		if [[ -f "$ROOT/$pid_name.pid" ]]; then
			pid="$(cat "$ROOT/$pid_name.pid" 2>/dev/null || true)"
			if [[ -n "$pid" ]]; then
				kill "$pid" 2>/dev/null || true
			fi
		fi
	done
}
trap cleanup EXIT TERM INT

VERSION="$(openvpn --version | head -n1)"
log "$VERSION"
if [[ "$VERSION" != "OpenVPN 2.6.14 "* ]]; then
	log "unexpected OpenVPN version; refusing to continue"
	exit 1
fi

command -v getent >/dev/null || { log "getent is required to verify nobody/nogroup"; exit 1; }
getent passwd nobody >/dev/null || { log "user nobody is missing from the fixture image"; exit 1; }
if ! getent group nobody >/dev/null; then
	# The observed fixture image has nogroup but no nobody group. The product
	# configuration keeps "group nobody"; create only a local group alias in
	# this disposable container, without network access or package install.
	if command -v groupadd >/dev/null; then
		groupadd --system nobody
	elif command -v addgroup >/dev/null; then
		# Debian addgroup supports --system; BusyBox uses -S.
		addgroup --system nobody || addgroup -S nobody
	else
		log "group nobody is missing and neither groupadd nor addgroup exists"
		exit 1
	fi
fi
getent group nobody >/dev/null || { log "could not create group nobody"; exit 1; }
getent group nogroup >/dev/null || log "warning: group nogroup is missing"

for required in \
	"$PKI/ca.crt" "$PKI/server.crt" "$PKI/server.key" \
	"$PKI/crl.pem" "$PKI/tls-crypt.key" \
	"$CLIENTS/ca.crt" "$CLIENTS/target.crt" "$CLIENTS/target.key" \
	"$CLIENTS/control.crt" "$CLIENTS/control.key"; do
	if [[ ! -f "$required" ]]; then
		log "missing fixture file: $required"
		exit 1
	fi
done

ip link set lo up

cat > "$ROOT/server.conf" <<EOF
dev tun0
proto udp
local 127.0.0.1
port 1194
topology subnet
server 10.246.8.0 255.255.255.0
ca $PKI/ca.crt
cert $PKI/server.crt
key $PKI/server.key
crl-verify $PKI/crl.pem
tls-crypt $PKI/tls-crypt.key
management $ENV_DIR/mgmt.sock unix
management-client-user root
dh none
user nobody
group nobody
persist-key
persist-tun
keepalive 10 60
verb 3
explicit-exit-notify 1
EOF

for side in target control; do
	if [[ "$side" == "target" ]]; then
		client_dev=tun1
	else
		client_dev=tun2
	fi
	cat > "$ROOT/$side.conf" <<EOF
client
dev $client_dev
proto udp
remote 127.0.0.1 1194
nobind
persist-key
persist-tun
ca $CLIENTS/ca.crt
cert $CLIENTS/$side.crt
key $CLIENTS/$side.key
tls-crypt $PKI/tls-crypt.key
remote-cert-tls server
route-nopull
verb 3
EOF
done

if grep -Eq '^[[:space:]]*management[[:space:]].*\btcp\b' "$ROOT/server.conf"; then
	log "TCP management is forbidden in this fixture"
	exit 1
fi

log "starting synthetic OpenVPN server"
openvpn --config "$ROOT/server.conf" --log "$ROOT/server.log" --writepid "$ROOT/server.pid" --daemon

for _ in $(seq 1 100); do
	if [[ -S "$ENV_DIR/mgmt.sock" ]]; then
		break
	fi
	sleep 0.1
done
if [[ ! -S "$ENV_DIR/mgmt.sock" ]]; then
	log "management Unix socket was not created"
	cat "$ROOT/server.log" || true
	exit 1
fi

log "starting synthetic target and control clients"
openvpn --config "$ROOT/target.conf" --log "$ROOT/target.log" --writepid "$ROOT/target.pid" --daemon
openvpn --config "$ROOT/control.conf" --log "$ROOT/control.log" --writepid "$ROOT/control.pid" --daemon

log "waiting for target and control in status 3 (no disconnect command)"
python3 /runner/status.py \
	--socket "$ENV_DIR/mgmt.sock" \
	--target "$TARGET_CN" \
	--control "$CONTROL_CN" \
	--timeout 60 \
	| tee "$ROOT/status.txt"

touch "$ROOT/READY"
log "fixture READY"
while true; do
	sleep 1
done
