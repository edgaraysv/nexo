//go:build !linux

package vpnruntime

import "errors"

type NativeHost struct{}

func NewNativeHost() *NativeHost { return &NativeHost{} }
func (*NativeHost) Inspect(DesiredEnvironment, Link) (string, bool, error) {
	return "", false, errors.New("vpn node runtime requires linux")
}
func (*NativeHost) Ensure(DesiredEnvironment, Link) (string, error) {
	return "", errors.New("vpn node runtime requires linux")
}
func (*NativeHost) Suspend(DesiredEnvironment) (string, error) {
	return "", errors.New("vpn node runtime requires linux")
}
func (*NativeHost) Retire(DesiredEnvironment) (string, error) {
	return "", errors.New("vpn node runtime requires linux")
}
func (*NativeHost) CleanupUnknown(map[string]struct{}) error {
	return errors.New("vpn node runtime requires linux")
}
