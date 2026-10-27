import { parseMetadata, writeMetadata } from "@uswriting/exiftool";
import zeroperlWasmUrl from "@6over3/zeroperl-ts/zeroperl.wasm?url";
import type { RemoveMetadataResult } from "../common/ipc_channels";
import type { ExifData, Settings } from "../domain";
import { cleanExifData } from "../domain";
import {
	QUICKTIME_DATE_REMOVAL_ARGS,
	RAW_IDENTIFYING_TAG_DELETES,
	RESOLUTION_PRESERVE_ARGS,
} from "../domain/exif/exif";
import { generateCleanedPath } from "../domain/files/cleaned_path";
import { refuseUnsafeRafWrite } from "../domain/files/file_processing_outcome";
import {
	isMediaFile,
	isRafFile,
	isRawFile,
	isTiffFile,
} from "../domain/files/file_types";
import { classifyInspectionDiagnostics } from "../domain/exif/exiftool_diagnostics";
import { webFileStore } from "./web_file_store";

// Pure-Perl polyfill for mro::get_linear_isa (needed by Perl 5.42's overload.pm
// when ExifTool writes PDFs/BigInts inside static ZeroPerl WASM) and safe END cleanup.
const EXIFTOOL_WASM_CONFIG_BYTES = new TextEncoder().encode(`
$INC{"mro.pm"} = "/zeroperl/lib/5.42.0/mro.pm";
*mro::get_linear_isa = sub {
	my ($classname) = @_;
	my @lin = ($classname);
	my %stored = ($classname => 1);
	no strict "refs";
	for my $parent (@{$classname . "::ISA"}) {
		for (@{mro::get_linear_isa($parent)}) {
			push @lin, $_ unless $stored{$_}++;
		}
	}
	return \\@lin;
};
INIT {
	no warnings "redefine";
	*main::Cleanup = sub () {};
}
1;
`);

const EXIFTOOL_CONFIG_FILE = {
	name: "exif.cfg",
	data: EXIFTOOL_WASM_CONFIG_BYTES,
};

let cachedWasmBytes: ArrayBuffer | null = null;
let wasmFetchPromise: Promise<ArrayBuffer> | null = null;

export function setCustomWasmBuffer(bytes: ArrayBuffer): void {
	cachedWasmBytes = bytes;
}

async function fetchZeroPerlWasm(): Promise<Response> {
	if (cachedWasmBytes !== null) {
		return new Response(cachedWasmBytes.slice(0), {
			headers: { "Content-Type": "application/wasm" },
		});
	}
	if (wasmFetchPromise === null) {
		wasmFetchPromise = fetch(zeroperlWasmUrl).then(async (res) => {
			if (!res.ok) {
				throw new Error(
					`Failed to load ExifTool WebAssembly (${res.status} ${res.statusText})`,
				);
			}
			const buffer = await res.arrayBuffer();
			cachedWasmBytes = buffer;
			return buffer;
		});
	}
	const bytes = await wasmFetchPromise;
	return new Response(bytes.slice(0), {
		headers: { "Content-Type": "application/wasm" },
	});
}

// Serialize all WASM ExifTool operations through a single queue
// because ZeroPerl shares a single WASI MemoryFileSystem instance.
let executionQueue: Promise<unknown> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
	const next = executionQueue.then(task, task);
	executionQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

function sanitizeFileNameForWasm(name: string): string {
	const base = name.replace(/\\/g, "/").split("/").at(-1) ?? "file";
	const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
	return cleaned.length > 0 ? cleaned : "file";
}

function formatWasmError(
	rawError: string | undefined,
	fileName: string,
): string {
	if (!rawError) {
		return "ExifTool failed to process the file";
	}
	return rawError
		.replace(
			new RegExp(`/${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
			fileName,
		)
		.replace(/^Error:\s*/i, "")
		.trim();
}

export async function preloadWasmEngine(): Promise<void> {
	await fetchZeroPerlWasm();
}

export async function wasmReadMetadata(filePath: string): Promise<ExifData> {
	return runSerialized(async () => {
		const binary = webFileStore.getBinaryForExiftool(filePath);
		if (binary === null) {
			throw new Error(`File not found in browser memory: ${filePath}`);
		}

		const safeName = sanitizeFileNameForWasm(binary.name);
		const fileInput =
			binary.data instanceof File
				? new File([binary.data], safeName, { type: binary.data.type })
				: { name: safeName, data: binary.data };

		const result = await parseMetadata<Record<string, unknown>[]>(fileInput, {
			config: EXIFTOOL_CONFIG_FILE,
			args: ["-config", "/exif.cfg", "-q", "-q", "-json", "-G1:2:4"],
			transform: (stdout) => JSON.parse(stdout) as Record<string, unknown>[],
			fetch: fetchZeroPerlWasm,
		});

		if (!result.success || result.data === undefined) {
			throw new Error(formatWasmError(result.error, safeName));
		}

		const firstRecord = result.data[0];
		if (firstRecord === undefined) {
			return {};
		}

		const verdict = classifyInspectionDiagnostics({
			record: firstRecord,
			purpose: "display",
		});
		if (verdict.fatal) {
			throw new Error(verdict.detail);
		}

		return cleanExifData({ raw: firstRecord });
	});
}

export async function wasmRemoveMetadata({
	filePath,
	settings,
}: {
	filePath: string;
	settings: Settings;
}): Promise<RemoveMetadataResult> {
	if (isRafFile({ filename: filePath })) {
		return refuseUnsafeRafWrite({ filePath });
	}

	return runSerialized(async () => {
		const binary = webFileStore.getBinaryForExiftool(filePath);
		if (binary === null) {
			return {
				success: false,
				error: `File not found in browser memory: ${filePath}`,
			};
		}

		const isRaw = isRawFile({ filename: filePath });
		const wasForcedCopy = isRaw && !settings.saveAsCopy;
		const saveAsCopy = settings.saveAsCopy || wasForcedCopy;
		const outputPath = saveAsCopy
			? generateCleanedPath({
					filePath,
					exists: (candidate) => webFileStore.hasPath(candidate),
				})
			: filePath;

		const extraArgs: string[] = ["-config", "/exif.cfg", "-q", "-q", "-all="];
		if (isMediaFile({ filename: filePath })) {
			extraArgs.push(...QUICKTIME_DATE_REMOVAL_ARGS);
		}
		if (isTiffFile({ filename: filePath })) {
			extraArgs.push("-CommonIFD0=");
		}
		if (isRawFile({ filename: filePath })) {
			extraArgs.push(...RAW_IDENTIFYING_TAG_DELETES);
			extraArgs.push(...QUICKTIME_DATE_REMOVAL_ARGS);
		}

		const preserveTags: string[] = [];
		if (settings.preserveOrientation) preserveTags.push("-Orientation");
		if (settings.preserveColorProfile) preserveTags.push("-ICC_Profile");
		if (settings.preserveResolution) {
			preserveTags.push(...RESOLUTION_PRESERVE_ARGS);
		}
		if (preserveTags.length > 0) {
			extraArgs.push("-TagsFromFile", "@", ...preserveTags);
		}
		if (settings.preserveTimestamps) {
			extraArgs.push("-P");
		}

		const safeName = sanitizeFileNameForWasm(binary.name);
		const fileInput =
			binary.data instanceof File
				? new File([binary.data], safeName, { type: binary.data.type })
				: { name: safeName, data: binary.data };

		const writeResult = await writeMetadata(
			fileInput,
			{},
			{
				config: EXIFTOOL_CONFIG_FILE,
				args: extraArgs,
				fetch: fetchZeroPerlWasm,
			},
		);

		if (!writeResult.success || writeResult.data === undefined) {
			return {
				success: false,
				error: formatWasmError(writeResult.error, safeName),
			};
		}

		const cleanedBytes = new Uint8Array(writeResult.data);
		webFileStore.setCleanedOutput({
			sourcePath: filePath,
			outputPath,
			bytes: cleanedBytes,
		});

		return {
			success: true,
			outputPath,
			wasForcedCopy,
			wroteFile: true,
			outputSize: cleanedBytes.byteLength,
		};
	});
}
