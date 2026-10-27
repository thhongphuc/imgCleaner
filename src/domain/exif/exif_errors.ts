// Pure domain logic — zero dependencies, zero I/O, no mutation.

import { assertNever } from "../../common/types";

export type MetadataEngineBackend = "exiftool";

export type MetadataEngineError =
	| {
			readonly code: "engine-unavailable";
			readonly backend?: MetadataEngineBackend;
	  }
	| {
			readonly code: "engine-error";
			readonly detail: string;
			readonly backend?: MetadataEngineBackend;
	  };

export type ExifError = MetadataEngineError;

export function formatMetadataEngineError(error: MetadataEngineError): string {
	switch (error.code) {
		case "engine-unavailable":
			if (error.backend === "exiftool") {
				return "ExifTool is not running. Reload the app to recover.";
			}
			return "Metadata engine is not running. Reload the app to recover.";
		case "engine-error":
			if (error.backend === "exiftool") {
				return `ExifTool failed: ${error.detail}`;
			}
			return `Metadata engine failed: ${error.detail}`;
		default:
			return assertNever({ value: error });
	}
}

export const formatExifError = formatMetadataEngineError;
