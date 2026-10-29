//go:build windows

package keystore

import (
	"errors"
	"syscall"
	"unsafe"
)

type blob struct {
	size uint32
	data *byte
}

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var protectData = crypt32.NewProc("CryptProtectData")
var unprotectData = crypt32.NewProc("CryptUnprotectData")
var localFree = kernel32.NewProc("LocalFree")

func call(proc *syscall.LazyProc, value []byte) ([]byte, error) {
	if len(value) == 0 {
		return nil, errors.New("empty key")
	}
	in := blob{uint32(len(value)), &value[0]}
	var out blob
	r, _, e := proc.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 4, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, e
	}
	defer localFree.Call(uintptr(unsafe.Pointer(out.data)))
	return append([]byte(nil), unsafe.Slice(out.data, out.size)...), nil
}
func protect(value []byte) ([]byte, error)   { return call(protectData, value) }
func unprotect(value []byte) ([]byte, error) { return call(unprotectData, value) }
