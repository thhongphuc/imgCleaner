// Pure domain logic — zero dependencies, zero I/O, no mutation.
//
// Business rule: an ExifTool-group Error entry is fatal in every purpose, always, with no
// prefix exemption. An ExifTool-group Warning entry is fatal under `purpose:
// "output-verification"` unconditionally (today's behaviour, deliberately unchanged); under
// `purpose: "display"` it is non-fatal only when its value carries ExifTool's own
// machine-emitted `[minor] ` marker -- severity is read from that marker, never from an
// allowlist of English warning phrases, because phrase allowlists rot across ExifTool
// versions. An unrecognised or unprefixed warning stays fatal (fail-closed default).

import { assertNever } from "../../common/types";

const MINOR_WARNING_PATTERN = /^\s*\[minor\]\s/i;

export type InspectionPurpose = "display" | "output-verification";

export type InspectionDiagnosticsVerdict =
	| { readonly fatal: true; readonly detail: string }
	| { readonly fatal: false; readonly suppressedWarnings: readonly string[] };

interface DiagnosticEntry {
	readonly tag: "Error" | "Warning";
	readonly value: string;
}

function collectDiagnosticEntries({
	record,
}: {
	record: Record<string, unknown>;
}): DiagnosticEntry[] {
	return Object.entries(record).flatMap(([key, value]) => {
		const parts = key.split(":");
		const tag = parts.at(-1);
		if (parts[0] !== "ExifTool" || (tag !== "Error" && tag !== "Warning")) {
			return [];
		}
		return [{ tag, value: String(value) }];
	});
}

export function classifyInspectionDiagnostics({
	record,
	purpose,
}: {
	record: Record<string, unknown>;
	purpose: InspectionPurpose;
}): InspectionDiagnosticsVerdict {
	const entries = collectDiagnosticEntries({ record });

	const error = entries.find((entry) => entry.tag === "Error");
	if (error !== undefined) {
		return { fatal: true, detail: error.value };
	}

	const warnings = entries.filter((entry) => entry.tag === "Warning");

	switch (purpose) {
		case "output-verification": {
			const warning = warnings[0];
			if (warning !== undefined) {
				return { fatal: true, detail: warning.value };
			}
			return { fatal: false, suppressedWarnings: [] };
		}
		case "display": {
			const nonMinor = warnings.find(
				(warning) => !MINOR_WARNING_PATTERN.test(warning.value),
			);
			if (nonMinor !== undefined) {
				return { fatal: true, detail: nonMinor.value };
			}
			return {
				fatal: false,
				suppressedWarnings: warnings.map((warning) => warning.value),
			};
		}
		default:
			return assertNever({ value: purpose });
	}
}
