package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const runtimeDataVersionMarker = ".runtime-version"

func (controller RuntimeController) dataVersionIncompatibility(active ActiveRuntime) *Outcome {
	data, err := readBoundedFile(filepath.Join(controller.DataRoot, runtimeDataVersionMarker), 128)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	dataVersion := strings.TrimSpace(string(data))
	if err != nil || !versionPattern.MatchString(dataVersion) {
		return dataVersionFailureOutcome(active, "")
	}
	if compareVersions(dataVersion, active.Version) <= 0 {
		return nil
	}
	return dataVersionFailureOutcome(active, dataVersion)
}

func dataVersionFailureOutcome(active ActiveRuntime, dataVersion string) *Outcome {
	message := "AkuBrowser data belongs to a newer runtime version. Run the installer downgrade reset to archive it and create a fresh database."
	if dataVersion == "" {
		message = "AkuBrowser data compatibility metadata is invalid. Run the installer data reset to create a fresh database."
	}
	return &Outcome{
		Status:  "error",
		Runtime: runtimeState(active, "data-version-incompatible", "stopped"),
		Update:  updateState(active),
		Error: protocolError(
			"data_version_incompatible",
			message,
			false,
			"reset_data",
		),
	}
}
