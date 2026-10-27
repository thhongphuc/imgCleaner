import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setCustomWasmBuffer } from "../../src/web/wasm_exiftool_engine";
import { createWebApi } from "../../src/web/web_api";
import { webFileStore } from "../../src/web/web_file_store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const WASM_PATH = path.resolve(
	__dirname,
	"../../node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm",
);

describe("Client-side WebAssembly imgCleaner API", () => {
	beforeAll(async () => {
		const g = globalThis as Record<string, unknown>;
		if (g.window === undefined) g.window = {};
		if (g.document === undefined) g.document = {};
		const wasmBuf = await readFile(WASM_PATH);
		setCustomWasmBuffer(
			wasmBuf.buffer.slice(
				wasmBuf.byteOffset,
				wasmBuf.byteOffset + wasmBuf.byteLength,
			),
		);
	});

	beforeEach(() => {
		webFileStore.clear();
	});

	it("reads and strips metadata from JPEG, PNG, PDF, and WebP in WebAssembly", async () => {
		const api = createWebApi();
		await api.settings.set({
			saveAsCopy: true,
			preserveOrientation: true,
			preserveColorProfile: true,
			preserveResolution: true,
		});

		for (const fixtureName of [
			"sample.jpg",
			"sample.png",
			"sample.pdf",
			"sample.webp",
		]) {
			const buf = await readFile(path.join(FIXTURES_DIR, fixtureName));
			const file = new File([buf], fixtureName);
			const virtualPath = api.files.getPathForFile(file);

			const beforeMeta = await api.exif.readMetadata(virtualPath);
			expect(Object.keys(beforeMeta).length).toBeGreaterThan(0);

			const removeRes = await api.exif.removeMetadata(virtualPath);
			expect(removeRes.success).toBe(true);
			if (removeRes.success) {
				expect(removeRes.outputPath).toContain("_cleaned");
				const afterMeta = await api.exif.readMetadata(removeRes.outputPath);
				expect(Object.keys(afterMeta).length).toBeLessThan(
					Object.keys(beforeMeta).length,
				);
			}
		}

		expect(webFileStore.getCleanedCount()).toBe(4);
	}, 30000);

	it("refuses unsafe RAF files just like desktop", async () => {
		const api = createWebApi();
		const buf = await readFile(path.join(FIXTURES_DIR, "sample.raf"));
		const file = new File([buf], "sample.raf");
		const virtualPath = api.files.getPathForFile(file);

		const removeRes = await api.exif.removeMetadata(virtualPath);
		expect(removeRes.success).toBe(false);
		if (!removeRes.success && "failureKind" in removeRes) {
			expect(removeRes.failureKind).toBe("refused");
		}
	});
});
