#!/usr/bin/env bash
# Reproducible M-VPN-08 P3 runner. Synthetic fixture only.
#
# Usage:
#   ./run.sh all        # prepare + start fixture + run Go P3 + evidence + cleanup
#   ./run.sh prepare    # generate PKI/CRL/client records under P3_ROOT
#   ./run.sh fixture    # start the isolated OpenVPN 2.6.14 fixture
#   ./run.sh p3         # run TestP3RevocationEndToEnd against the running fixture
#   ./run.sh cleanup    # copy evidence and remove only the fixture container
#
# Prerequisites: Docker, the local fixture image
# nexo-mvpn08-openvpn:local, and golang:1.27.3-bookworm.
# The script never touches production, AWS/SSM, system OpenVPN, or host services.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../../.." && pwd)"

P3_BASE="${NEXO_MVPN08_P3_BASE:-/tmp/opencode/mvpn08}"
mkdir -p "$P3_BASE"
P3_BASE="$(cd "$P3_BASE" && pwd)"
P3_STATE_DIR="${NEXO_MVPN08_P3_STATE_DIR:-$P3_BASE/current-run}"
FIXED_ROOT="${NEXO_MVPN08_P3_HOST_ROOT:-}"
P3_ROOT="$FIXED_ROOT"
EVIDENCE_DIR="${NEXO_MVPN08_P3_EVIDENCE_DIR:-}"
RUN_ID="${NEXO_MVPN08_P3_RUN_ID:-}"
FIXTURE_IMAGE="${NEXO_MVPN08_FIXTURE_IMAGE:-nexo-mvpn08-openvpn:local}"
GO_IMAGE="${NEXO_MVPN08_GO_IMAGE:-golang:1.27.3-bookworm}"
CONTAINER="${NEXO_MVPN08_P3_CONTAINER:-}"
RUN_ID_FILE=""
CLEANUP_ACTIVE=0
RUNNER_LABEL_KEY="nexo.mvpn08.p3.runner"
RUNNER_LABEL_VALUE="true"
RUN_ID_LABEL_KEY="nexo.mvpn08.p3.run"

ENV_ID="${NEXO_MVPN08_P3_ENV:-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6}"
TENANT_ID="${NEXO_MVPN08_P3_TENANT:-cccccccc-cccc-4ccc-8ccc-cccccccccccc}"
TARGET_REQUEST="${NEXO_MVPN08_P3_TARGET_REQUEST:-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}"
TARGET_DEVICE="${NEXO_MVPN08_P3_TARGET_DEVICE:-11111111-1111-4111-8111-111111111111}"
CONTROL_REQUEST="${NEXO_MVPN08_P3_CONTROL_REQUEST:-dddddddd-dddd-4ddd-8ddd-dddddddddddd}"
CONTROL_DEVICE="${NEXO_MVPN08_P3_CONTROL_DEVICE:-22222222-2222-4222-8222-222222222222}"

TARGET_CN="nexo:$TARGET_DEVICE"
CONTROL_CN="nexo:$CONTROL_DEVICE"

log() {
	printf '[mvpn08-p3] %s\n' "$*"
}

new_run_id() {
	printf '%s-%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$$" "$RANDOM"
}

require_local_images() {
	local image
	for image in "$GO_IMAGE" "$FIXTURE_IMAGE"; do
		if ! docker image inspect "$image" >/dev/null 2>&1; then
			log "required local Docker image is missing: $image (no pull attempted)"
			return 1
		fi
	done
}

write_state() {
	mkdir -p "$P3_STATE_DIR"
	printf '%s\n' "$RUN_ID" > "$P3_STATE_DIR/run-id"
	printf '%s\n' "$P3_ROOT" > "$P3_STATE_DIR/root"
	printf '%s\n' "$EVIDENCE_DIR" > "$P3_STATE_DIR/evidence"
	printf '%s\n' "$CONTAINER" > "$P3_STATE_DIR/container"
}

read_state_value() {
	local file="$1" value
	[[ -f "$file" ]] || return 1
	value="$(cat "$file")" || return 1
	[[ -n "$value" ]] || return 1
	[[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
	printf '%s' "$value"
}

parse_state() {
	local run_id root evidence container entries expected
	entries="$(find "$P3_STATE_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort)" || return 1
	expected=$'container\nevidence\nroot\nrun-id'
	[[ "$entries" == "$expected" ]] || return 1
	run_id="$(read_state_value "$P3_STATE_DIR/run-id")" || return 1
	root="$(read_state_value "$P3_STATE_DIR/root")" || return 1
	evidence="$(read_state_value "$P3_STATE_DIR/evidence")" || return 1
	container="$(read_state_value "$P3_STATE_DIR/container")" || return 1
	[[ "$run_id" =~ ^[A-Za-z0-9._:-]+$ ]] || return 1
	[[ "$root" == /* && "$evidence" == /* ]] || return 1
	[[ "$container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1
	STATE_RUN_ID="$run_id"
	STATE_P3_ROOT="$root"
	STATE_EVIDENCE_DIR="$evidence"
	STATE_CONTAINER="$container"
	return 0
}

load_state() {
	parse_state || return 1
	RUN_ID="$STATE_RUN_ID"
	P3_ROOT="$STATE_P3_ROOT"
	EVIDENCE_DIR="$STATE_EVIDENCE_DIR"
	CONTAINER="$STATE_CONTAINER"
	RUN_ID_FILE="$P3_ROOT/runner-run-id"
	return 0
}

ensure_state() {
	load_state || { log "no valid current-run state; run '$0 prepare' first"; return 1; }
}

prepare_root() {
	[[ -n "$P3_ROOT" && -n "$EVIDENCE_DIR" ]] || { log "run state is not initialized"; return 1; }
	mkdir -p "$P3_ROOT" "$EVIDENCE_DIR"
	P3_ROOT="$(cd "$P3_ROOT" && pwd)"
	EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd)"
	RUN_ID_FILE="$P3_ROOT/runner-run-id"
}

docker_container_exists() {
	[[ -n "${1:-}" ]] || return 1
	docker inspect "$1" >/dev/null 2>&1
}

container_exists() {
	docker_container_exists "$CONTAINER"
}

current_run_id() {
	[[ -f "$RUN_ID_FILE" ]] || return 1
	cat "$RUN_ID_FILE"
}

container_owned() {
	local run_id
	run_id="$(current_run_id)" || return 1
	[[ -n "$run_id" ]] || return 1
	[[ -n "$RUN_ID" && "$run_id" == "$RUN_ID" ]] || return 1
	[[ "$(docker inspect -f "{{ index .Config.Labels \"$RUNNER_LABEL_KEY\" }}" "$CONTAINER" 2>/dev/null)" == "$RUNNER_LABEL_VALUE" ]] || return 1
	[[ "$(docker inspect -f "{{ index .Config.Labels \"$RUN_ID_LABEL_KEY\" }}" "$CONTAINER" 2>/dev/null)" == "$run_id" ]] || return 1
	return 0
}

check_previous_run() {
	if [[ -e "$P3_STATE_DIR" && ! -d "$P3_STATE_DIR" ]]; then
		log "current-run path exists but is not a directory; refusing to overwrite"
		return 1
	fi
	[[ -d "$P3_STATE_DIR" ]] || return 0
	parse_state || {
		log "existing current-run state is invalid; refusing to overwrite"
		return 1
	}
	if docker_container_exists "$STATE_CONTAINER"; then
		log "previous run $STATE_RUN_ID still has container $STATE_CONTAINER; run '$0 cleanup' first"
		return 1
	fi
	return 0
}

prepare() {
	require_local_images || return 1
	check_previous_run || return 1
	if [[ -z "$RUN_ID" ]]; then
		RUN_ID="$(new_run_id)"
	fi
	if [[ -n "$FIXED_ROOT" ]]; then
		P3_ROOT="$FIXED_ROOT"
	else
		P3_ROOT="$P3_BASE/roots/$RUN_ID"
	fi
	if [[ -z "$EVIDENCE_DIR" ]]; then
		EVIDENCE_DIR="$P3_BASE/evidence/$RUN_ID"
	fi
	if [[ -d "$EVIDENCE_DIR" ]] && [[ -n "$(ls -A "$EVIDENCE_DIR" 2>/dev/null)" ]]; then
		log "evidence directory $EVIDENCE_DIR already contains files; refusing to overwrite"
		return 1
	fi
	CONTAINER="${NEXO_MVPN08_P3_CONTAINER:-nexo-mvpn08-p3-$RUN_ID}"
	[[ "$RUN_ID" =~ ^[A-Za-z0-9._:-]+$ ]] || { log "invalid run id"; return 1; }
	[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { log "invalid container name"; return 1; }
	RUN_ID_FILE="$P3_ROOT/runner-run-id"
	if [[ -d "$P3_ROOT" ]] && [[ -n "$(ls -A "$P3_ROOT" 2>/dev/null)" ]]; then
		log "root $P3_ROOT already contains data; refusing to overwrite; use a new run id or an empty root"
		return 1
	fi
	prepare_root
	log "preparing synthetic PKI and client records under $P3_ROOT (run $RUN_ID)"
	docker run --rm --user 0:0 --network none --pull=never \
		-v "$REPO_ROOT":/src:ro \
		-v "$P3_ROOT":/p3root \
		-w /src/product/agent \
		"$GO_IMAGE" \
		env NEXO_MVPN08_P3_ROOT=/p3root \
			NEXO_MVPN08_P3_ENV="$ENV_ID" \
			NEXO_MVPN08_P3_TENANT="$TENANT_ID" \
			NEXO_MVPN08_P3_TARGET_REQUEST="$TARGET_REQUEST" \
			NEXO_MVPN08_P3_TARGET_DEVICE="$TARGET_DEVICE" \
			NEXO_MVPN08_P3_CONTROL_REQUEST="$CONTROL_REQUEST" \
			NEXO_MVPN08_P3_CONTROL_DEVICE="$CONTROL_DEVICE" \
		go test -tags p3integration ./internal/vpnruntime -run TestP3Prepare -v
	if [[ ! -f "$P3_ROOT/p3.json" ]]; then
		log "prepare did not create $P3_ROOT/p3.json"
		return 1
	fi
	write_state
}

capture_image_identity() {
	prepare_root
	if ! docker run --rm --network none --pull=never --entrypoint /bin/sh "$FIXTURE_IMAGE" -c 'openvpn --version' | sed -n '1p' > "$EVIDENCE_DIR/openvpn-version.txt"; then
		log "could not capture OpenVPN version"
		return 1
	fi
	if ! docker image inspect --format '{{.Id}}' "$FIXTURE_IMAGE" > "$EVIDENCE_DIR/fixture-image-id.txt"; then
		log "could not capture fixture image id"
		return 1
	fi
	if [[ ! -s "$EVIDENCE_DIR/openvpn-version.txt" || ! -s "$EVIDENCE_DIR/fixture-image-id.txt" ]]; then
		log "empty OpenVPN version or fixture image id"
		return 1
	fi
	if ! grep -q 'OpenVPN 2\.6\.14' "$EVIDENCE_DIR/openvpn-version.txt"; then
		log "fixture image is not pinned to OpenVPN 2.6.14"
		return 1
	fi
}

capture_traceability() {
	prepare_root
	if ! git -C "$REPO_ROOT" rev-parse HEAD > "$EVIDENCE_DIR/git-head.txt"; then
		log "could not capture git HEAD"
		return 1
	fi
	if ! git -C "$REPO_ROOT" status --porcelain -- product/agent > "$EVIDENCE_DIR/git-status-product-agent.txt"; then
		log "could not capture git status"
		return 1
	fi
	if [[ ! -s "$EVIDENCE_DIR/git-status-product-agent.txt" ]]; then
		if ! printf '%s\n' '(clean)' > "$EVIDENCE_DIR/git-status-product-agent.txt"; then
			log "could not write clean git status marker"
			return 1
		fi
	fi
	if ! (
		cd "$REPO_ROOT"
		find product/agent -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
	) > "$EVIDENCE_DIR/product-agent-tree.sha256"; then
		log "could not capture product/agent tree hash"
		return 1
	fi
	if ! (
		cd "$REPO_ROOT"
		private_excludes=()
		while IFS= read -r -d '' file; do
			relative="${file#"$REPO_ROOT"/}"
			case "$file" in
				*.pem|*.key)
					if grep -Iq -- '-----BEGIN .*PRIVATE KEY-----' "$file"; then
						private_excludes+=(--exclude="$relative")
					fi
					;;
				*.p12|*.pfx|*/.env)
					private_excludes+=(--exclude="$relative")
					;;
			esac
		done < <(find "$REPO_ROOT/product/agent" -type f -print0)
		tar --format=posix --numeric-owner "${private_excludes[@]}" \
			-cf "$EVIDENCE_DIR/product-agent-source.tar" product/agent
	); then
		log "could not capture product/agent source archive"
		return 1
	fi
	if ! sha256sum "$EVIDENCE_DIR/product-agent-source.tar" > "$EVIDENCE_DIR/product-agent-source.tar.sha256"; then
		log "could not capture source archive hash"
		return 1
	fi
	if ! docker image inspect --format '{{.Id}}' "$GO_IMAGE" > "$EVIDENCE_DIR/go-image-id.txt"; then
		log "could not capture Go image id"
		return 1
	fi
	if ! capture_image_identity; then
		return 1
	fi
	for artifact in \
		git-head.txt \
		git-status-product-agent.txt \
		product-agent-tree.sha256 \
		product-agent-source.tar \
		product-agent-source.tar.sha256 \
		go-image-id.txt \
		fixture-image-id.txt \
		openvpn-version.txt; do
		if [[ ! -s "$EVIDENCE_DIR/$artifact" ]]; then
			log "required traceability artifact missing or empty: $EVIDENCE_DIR/$artifact"
			return 1
		fi
	done
}

start_fixture() {
	require_local_images || return 1
	ensure_state
	prepare_root
	if container_exists; then
		if container_owned; then
			log "fixture container $CONTAINER already exists and is owned by this runner; run '$0 cleanup' first"
		else
			log "refusing to touch existing container $CONTAINER: runner label/run-id does not match"
		fi
		return 1
	fi
	if [[ ! -f "$P3_ROOT/p3.json" ]]; then
		log "run '$0 prepare' first"
		return 1
	fi
	capture_image_identity
	rm -f "$P3_ROOT/READY"
	printf '%s\n' "$RUN_ID" > "$RUN_ID_FILE"
	log "starting isolated OpenVPN fixture container $CONTAINER (run $RUN_ID)"
	if ! docker run -d --name "$CONTAINER" --user 0:0 \
		--pull=never \
		--network none \
		--cap-add NET_ADMIN \
		--device=/dev/net/tun \
		--label "$RUNNER_LABEL_KEY=$RUNNER_LABEL_VALUE" \
		--label "$RUN_ID_LABEL_KEY=$RUN_ID" \
		-e NEXO_MVPN08_P3_ENV="$ENV_ID" \
		-e TARGET_CN="$TARGET_CN" \
		-e CONTROL_CN="$CONTROL_CN" \
		-v "$P3_ROOT":/p3root \
		-v "$SCRIPT_DIR":/runner:ro \
		"$FIXTURE_IMAGE" \
		bash /runner/fixture.sh; then
		cleanup || true
		return 1
	fi

	for _ in $(seq 1 90); do
		if [[ -f "$P3_ROOT/READY" ]]; then
			log "fixture is ready and both synthetic peers are present in status"
			return 0
		fi
		if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" | grep -q true; then
			log "fixture container exited before readiness"
			docker logs "$CONTAINER" || true
			cleanup || true
			return 1
		fi
		sleep 1
	done
	log "timed out waiting for fixture readiness"
	docker logs "$CONTAINER" || true
	cleanup || true
	return 1
}

run_p3() {
	require_local_images || return 1
	ensure_state
	prepare_root
	if ! container_exists || ! docker inspect -f '{{.State.Running}}' "$CONTAINER" | grep -q true; then
		log "fixture container $CONTAINER is not running; run '$0 fixture' first"
		return 1
	fi
	if ! container_owned; then
		log "refusing to run P3 against $CONTAINER: runner label/run-id does not match"
		return 1
	fi
	if ! capture_traceability; then
		log "traceability capture failed; refusing to run P3"
		return 1
	fi
	log "running TestP3RevocationEndToEnd against the live fixture"
	set +e
	docker run --rm --user 0:0 --network none --pull=never \
		-v "$REPO_ROOT":/src:ro \
		-v "$P3_ROOT":/p3root \
		-w /src/product/agent \
		"$GO_IMAGE" \
		env NEXO_MVPN08_P3=1 NEXO_MVPN08_P3_ROOT=/p3root \
		go test -tags p3integration ./internal/vpnruntime -run TestP3RevocationEndToEnd -v \
		| tee "$EVIDENCE_DIR/go-test.log"
	local -a pipeline_status=("${PIPESTATUS[@]}")
	local code=${pipeline_status[0]:-1}
	local tee_status=${pipeline_status[1]:-1}
	set -e
	if ! printf '%s\n' "$code" > "$EVIDENCE_DIR/go-test.exit"; then
		log "could not write go-test.exit"
		return 1
	fi
	if (( tee_status != 0 )); then
		log "could not write go-test.log"
	fi
	if (( code != 0 )); then
		return "$code"
	fi
	if (( tee_status != 0 )); then
		return 1
	fi
	return 0
}

copy_evidence() {
	prepare_root
	if ! container_exists; then
		log "refusing evidence copy: fixture container $CONTAINER does not exist"
		return 1
	fi
	if ! container_owned; then
		log "refusing evidence copy: runner label/run-id does not match $CONTAINER"
		return 1
	fi
	if ! docker run --rm --pull=never --network none --user 0:0 \
		-v "$P3_ROOT":/p3root:ro \
		-v "$EVIDENCE_DIR":/evidence \
		-v "$SCRIPT_DIR":/runner:ro \
		"$GO_IMAGE" \
		bash /runner/copy-evidence.sh; then
		log "evidence collection failed; preserving container and run state"
		return 1
	fi
	for artifact in server.log target.log control.log status.txt p3.json; do
		if [[ ! -s "$EVIDENCE_DIR/$artifact" ]]; then
			log "required evidence missing or empty: $EVIDENCE_DIR/$artifact"
			return 1
		fi
	done
	printf 'run_id=%s\nstate=%s\nfixture_image=%s\nopenvpn_required=2.6.14\nroot=%s\nevidence=%s\nnetwork=none\nmanagement=unix-only\n' \
		"$RUN_ID" "$P3_STATE_DIR" "$FIXTURE_IMAGE" "$P3_ROOT" "$EVIDENCE_DIR" > "$EVIDENCE_DIR/scope.txt" || return 1
	cat > "$EVIDENCE_DIR/commands.txt" <<EOF || return 1
prepare: docker run --rm --user 0:0 --network none --pull=never -v "$REPO_ROOT":/src:ro -v "$P3_ROOT":/p3root -w /src/product/agent "$GO_IMAGE" env NEXO_MVPN08_P3_ROOT=/p3root NEXO_MVPN08_P3_ENV=$ENV_ID NEXO_MVPN08_P3_TENANT=$TENANT_ID NEXO_MVPN08_P3_TARGET_REQUEST=$TARGET_REQUEST NEXO_MVPN08_P3_TARGET_DEVICE=$TARGET_DEVICE NEXO_MVPN08_P3_CONTROL_REQUEST=$CONTROL_REQUEST NEXO_MVPN08_P3_CONTROL_DEVICE=$CONTROL_DEVICE go test -tags p3integration ./internal/vpnruntime -run TestP3Prepare -v
fixture: docker run -d --name $CONTAINER --user 0:0 --pull=never --network none --cap-add NET_ADMIN --device=/dev/net/tun --label $RUNNER_LABEL_KEY=$RUNNER_LABEL_VALUE --label $RUN_ID_LABEL_KEY=$RUN_ID -e NEXO_MVPN08_P3_ENV=$ENV_ID -e TARGET_CN=$TARGET_CN -e CONTROL_CN=$CONTROL_CN -v "$P3_ROOT":/p3root -v "$SCRIPT_DIR":/runner:ro $FIXTURE_IMAGE bash /runner/fixture.sh
p3: docker run --rm --user 0:0 --network none --pull=never -v "$REPO_ROOT":/src:ro -v "$P3_ROOT":/p3root -w /src/product/agent "$GO_IMAGE" env NEXO_MVPN08_P3=1 NEXO_MVPN08_P3_ROOT=/p3root go test -tags p3integration ./internal/vpnruntime -run TestP3RevocationEndToEnd -v
evidence_copy: docker run --rm --pull=never --network none --user 0:0 -v "$P3_ROOT":/p3root:ro -v "$EVIDENCE_DIR":/evidence -v "$SCRIPT_DIR":/runner:ro "$GO_IMAGE" bash /runner/copy-evidence.sh
traceability: git -C "$REPO_ROOT" rev-parse HEAD; git -C "$REPO_ROOT" status --porcelain -- product/agent; (cd "$REPO_ROOT" && find product/agent -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum); source snapshot excludes only *.p12,*.pfx,.env and *.pem/*.key containing a private-key block, then tar --format=posix --numeric-owner -cf "$EVIDENCE_DIR/product-agent-source.tar" product/agent; sha256sum "$EVIDENCE_DIR/product-agent-source.tar"; docker image inspect "$GO_IMAGE" "$FIXTURE_IMAGE"
EOF
	for artifact in \
		server.log \
		target.log \
		control.log \
		status.txt \
		p3.json \
		go-test.log \
		go-test.exit \
		git-head.txt \
		git-status-product-agent.txt \
		product-agent-tree.sha256 \
		product-agent-source.tar \
		product-agent-source.tar.sha256 \
		go-image-id.txt \
		fixture-image-id.txt \
		openvpn-version.txt \
		scope.txt \
		commands.txt; do
		if [[ ! -s "$EVIDENCE_DIR/$artifact" ]]; then
			log "required evidence missing or empty: $EVIDENCE_DIR/$artifact"
			return 1
		fi
	done
	log "evidence copied to $EVIDENCE_DIR"
}

remove_state_pointer() {
	local entries expected
	entries="$(find "$P3_STATE_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort)"
	expected=$'container\nevidence\nroot\nrun-id'
	if [[ "$entries" != "$expected" ]]; then
		log "current-run directory contains unexpected entries; preserving it"
		return 1
	fi
	rm -f "$P3_STATE_DIR/run-id" "$P3_STATE_DIR/root" \
		"$P3_STATE_DIR/evidence" "$P3_STATE_DIR/container"
	rmdir "$P3_STATE_DIR" 2>/dev/null || true
}

cleanup() {
	if [[ ! -d "$P3_STATE_DIR" ]]; then
		if [[ -e "$P3_STATE_DIR" || -n "${NEXO_MVPN08_P3_CONTAINER:-}" || -n "$RUN_ID" ]]; then
			log "current-run state is missing or invalid; refusing cleanup"
			return 1
		fi
		log "no current run state; nothing to clean"
		return 0
	fi
	if ! ensure_state; then
		log "current-run state is invalid; refusing cleanup"
		return 1
	fi
	if container_exists; then
		if ! container_owned; then
			log "refusing to remove container $CONTAINER: runner label/run-id does not match"
			return 1
		fi
		if ! copy_evidence; then
			log "evidence collection failed; preserving container and run state for recovery"
			return 1
		fi
		log "removing only fixture container $CONTAINER"
		if ! docker rm -f "$CONTAINER" >/dev/null 2>&1; then
			log "failed to remove container $CONTAINER; preserving run state for recovery"
			return 1
		fi
		remove_state_pointer || return 1
		rm -f "$RUN_ID_FILE"
		return 0
	fi
	if [[ -f "$RUN_ID_FILE" ]]; then
		local marker
		marker="$(cat "$RUN_ID_FILE")" || { log "cannot read run marker; preserving state"; return 1; }
		if [[ "$marker" != "$RUN_ID" ]]; then
			log "run marker does not match current-run state; preserving state"
			return 1
		fi
	fi
	remove_state_pointer || return 1
	rm -f "$RUN_ID_FILE"
}

cleanup_on_exit() {
	if [[ "$CLEANUP_ACTIVE" == "1" ]]; then
		cleanup || true
	fi
}

all() {
	# Install cleanup before any preparation/creation so startup or
	# readiness failures cannot leave the named fixture behind. The flag
	# prevents touching a previous run's state if prepare fails before the
	# new state is committed.
	trap cleanup_on_exit EXIT
	prepare
	CLEANUP_ACTIVE=1
	start_fixture
	local p3_status=0
	run_p3 || p3_status=$?
	local copy_status=0
	copy_evidence || copy_status=$?
	local cleanup_status=0
	cleanup || cleanup_status=$?
	trap - EXIT
	if (( p3_status != 0 )); then
		return "$p3_status"
	fi
	if (( copy_status != 0 )); then
		return "$copy_status"
	fi
	if (( cleanup_status != 0 )); then
		return "$cleanup_status"
	fi
	log "P3 run finished; review $EVIDENCE_DIR"
}

case "${1:-all}" in
	prepare) prepare ;;
	fixture) start_fixture ;;
	p3) run_p3 ;;
	cleanup) cleanup ;;
	all) all ;;
	*)
		printf 'usage: %s [all|prepare|fixture|p3|cleanup]\n' "$0" >&2
		exit 2
		;;
esac
