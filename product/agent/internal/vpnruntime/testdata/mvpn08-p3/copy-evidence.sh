#!/usr/bin/env bash
# Runs inside the local GO_IMAGE helper container. Copies root-owned P3
# evidence to the host evidence directory with multiline private-key redaction.
set -euo pipefail

sanitize() {
	local source="$1"
	local destination="$2"
	local temporary
	if [[ ! -f "$source" || ! -s "$source" ]]; then
		printf 'missing or empty evidence source: %s\n' "$source" >&2
		return 1
	fi
	temporary="$(mktemp /evidence/.sanitize.XXXXXX)" || return 1
	if ! awk '
		/-----BEGIN .*PRIVATE KEY-----|-----BEGIN OpenVPN Static key V1-----/ {
			in_key = 1
			print "[REDACTED KEY BEGIN]"
			next
		}
		/-----END .*PRIVATE KEY-----|-----END OpenVPN Static key V1-----/ {
			in_key = 0
			print "[REDACTED KEY END]"
			next
		}
		{
			if (!in_key) {
				print
			}
		}
		END {
			if (in_key) {
				exit 3
			}
		}
	' "$source" > "$temporary"; then
		rm -f "$temporary"
		printf 'private-key sanitizer failed for %s\n' "$source" >&2
		return 1
	fi
	chmod 0644 "$temporary" || { rm -f "$temporary"; return 1; }
	mv -f "$temporary" "$destination" || { rm -f "$temporary"; return 1; }
}

copy_json() {
	local source=/p3root/p3.json
	local destination=/evidence/p3.json
	local temporary
	if [[ ! -f "$source" || ! -s "$source" ]]; then
		printf 'missing or empty evidence source: %s\n' "$source" >&2
		return 1
	fi
	temporary="$(mktemp /evidence/.p3-json.XXXXXX)" || return 1
	cp "$source" "$temporary" || { rm -f "$temporary"; return 1; }
	chmod 0644 "$temporary" || { rm -f "$temporary"; return 1; }
	mv -f "$temporary" "$destination" || { rm -f "$temporary"; return 1; }
}

for log_name in server target control; do
	sanitize "/p3root/$log_name.log" "/evidence/$log_name.log"
done
sanitize /p3root/status.txt /evidence/status.txt
copy_json

for required in \
	/evidence/server.log \
	/evidence/target.log \
	/evidence/control.log \
	/evidence/status.txt \
	/evidence/p3.json; do
	if [[ ! -s "$required" ]]; then
		printf 'required evidence missing or empty: %s\n' "$required" >&2
		exit 1
	fi
done
