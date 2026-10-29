#!/bin/sh
set -eu

case "${NEXO_ENVIRONMENT_ID:-}" in
  ????????-????-4???-[89ab]???-????????????) ;;
  *) echo "invalid environment id" >&2; exit 64 ;;
esac

root="/var/lib/nexo/environments/${NEXO_ENVIRONMENT_ID}"
test -f "${root}/openvpn.conf"
test -f "${root}/firewall.nft"
mkdir -p "${root}/pki"
if [ ! -f "${root}/pki/ca.crt" ]; then
  umask 077
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 -subj "/CN=NEXO Local F06 CA ${NEXO_ENVIRONMENT_ID}" -keyout "${root}/pki/ca.key" -out "${root}/pki/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -sha256 -nodes -subj "/CN=${NEXO_ENVIRONMENT_ID}" -keyout "${root}/pki/server.key" -out "${root}/pki/server.csr" >/dev/null 2>&1
  openssl x509 -req -sha256 -days 2 -in "${root}/pki/server.csr" -CA "${root}/pki/ca.crt" -CAkey "${root}/pki/ca.key" -CAcreateserial -out "${root}/pki/server.crt" >/dev/null 2>&1
  openvpn --genkey secret "${root}/pki/tls-crypt.key"
  chmod 0600 "${root}/pki/"*.key
fi

nft -f "${root}/firewall.nft"
openvpn --config "${root}/openvpn.conf" --writepid /run/openvpn.pid --log /run/openvpn.log &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' TERM INT
if ! wait "$pid"; then
  cat /run/openvpn.log >&2
  exit 1
fi
