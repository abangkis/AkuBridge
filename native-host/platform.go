package main

import "fmt"

const legacyWindowsArchitecture = "windows-x64"

type RuntimePlatform struct {
	Architecture      string
	RuntimeExecutable string
	RuntimeRoot       string
	DataRoot          string
	UpdateManifestURL string
}

func platformUpdateManifestURL(architecture string) string {
	if architecture == legacyWindowsArchitecture {
		// Keep the stable name so installed 0.7.8 Windows hosts can update.
		return "https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuBrowserRuntimeUpdate.json"
	}
	return fmt.Sprintf(
		"https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuBrowserRuntimeUpdate-%s.json",
		architecture,
	)
}

func runtimeExecutableOrDefault(name string) string {
	if name != "" {
		return name
	}
	return "AkuSidecar.exe"
}

func architectureOrDefault(architecture string) string {
	if architecture != "" {
		return architecture
	}
	return legacyWindowsArchitecture
}
