#!/usr/bin/env python3
"""Read-only management status waiter for the synthetic M-VPN-08 fixture.

Only sends `status 3`. It never sends client-kill, kill, DISCONNECT, RESTART,
or any other command.
"""
import argparse
import socket
import sys
import time


def read_status(sock):
    stream = sock.makefile("rwb", buffering=0)
    greeting = stream.readline()
    if not greeting:
        raise RuntimeError("management connection closed before greeting")
    stream.write(b"status 3\n")
    rows = []
    while True:
        line = stream.readline()
        if not line:
            raise RuntimeError("management connection closed during status")
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        rows.append(text)
        if text == "END":
            return rows


def common_names(rows):
    names = set()
    for row in rows:
        fields = row.split("\t")
        if len(fields) > 1 and fields[0] == "CLIENT_LIST":
            names.add(fields[1])
    return names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    deadline = time.time() + args.timeout
    last_rows = []
    while time.time() < deadline:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5.0)
        try:
            sock.connect(args.socket)
            last_rows = read_status(sock)
        except (OSError, RuntimeError) as exc:
            print("STATUS_WAIT_ERROR=%s" % exc, file=sys.stderr)
            time.sleep(1.0)
            continue
        finally:
            sock.close()

        names = common_names(last_rows)
        if args.target in names and args.control in names:
            print("STATUS_LAST_BEGIN")
            for row in last_rows:
                print(row)
            print("STATUS_LAST_END")
            print("TARGET_AND_CONTROL_PRESENT")
            return 0
        time.sleep(1.0)

    print("STATUS_LAST_BEGIN")
    for row in last_rows:
        print(row)
    print("STATUS_LAST_END")
    print("TIMEOUT waiting for target=%s control=%s" % (args.target, args.control), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
