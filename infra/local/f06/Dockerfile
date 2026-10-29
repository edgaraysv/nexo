FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates iproute2 nftables openvpn openssl procps stress-ng \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/nexo-vpn-entrypoint
RUN chmod 0755 /usr/local/bin/nexo-vpn-entrypoint
ENTRYPOINT ["/usr/local/bin/nexo-vpn-entrypoint"]
