package main

import (
	"encoding/binary"
	"math/bits"
	"net/netip"
	"strings"
)

// parseWindowsIPv4Routes extracts destination prefixes from `route print -4`.
// It intentionally ignores the gateway/interface columns: the observation is
// limited to whether the endpoint has a local route for the resource.
func parseWindowsIPv4Routes(output string) []netip.Prefix {
	var routes []netip.Prefix
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		destination, err := netip.ParseAddr(fields[0])
		if err != nil || !destination.Is4() {
			continue
		}
		mask, err := netip.ParseAddr(fields[1])
		if err != nil || !mask.Is4() {
			continue
		}
		prefix, ok := ipv4MaskPrefix(mask)
		if !ok {
			continue
		}
		routes = append(routes, netip.PrefixFrom(destination, prefix).Masked())
	}
	return routes
}

func ipv4MaskPrefix(mask netip.Addr) (int, bool) {
	if !mask.Is4() {
		return 0, false
	}
	bytes := mask.As4()
	value := binary.BigEndian.Uint32(bytes[:])
	inverted := ^value
	if inverted&(inverted+1) != 0 {
		return 0, false
	}
	return bits.OnesCount32(value), true
}

func containsIPv4Route(routes []netip.Prefix, address netip.Addr) bool {
	if !address.Is4() {
		return false
	}
	for _, prefix := range routes {
		if prefix.Bits() > 0 && prefix.Contains(address) {
			return true
		}
	}
	return false
}
