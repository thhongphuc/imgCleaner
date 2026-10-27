import { zipSync } from "fflate";

export interface StoredFileRecord {
	readonly virtualPath: string;
	readonly name: string;
	readonly folder: string | null;
	readonly originalFile: File;
	cleanedBytes?: Uint8Array | undefined;
	cleanedOutputPath?: string | undefined;
	mimeType: string;
}

type StoreListener = () => void;

class WebFileStore {
	private readonly files = new Map<string, StoredFileRecord>();
	private readonly folders = new Map<string, string[]>();
	private readonly fileToPath = new WeakMap<File, string>();
	private readonly listeners = new Set<StoreListener>();

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	registerLooseFile(file: File): string {
		const existing = this.fileToPath.get(file);
		if (existing !== undefined && this.files.has(existing)) {
			return existing;
		}

		const relativePath =
			typeof file.webkitRelativePath === "string" &&
			file.webkitRelativePath.length > 0
				? file.webkitRelativePath.replace(/\\/g, "/")
				: "";

		if (relativePath.includes("/")) {
			const rootFolder = relativePath.split("/")[0] ?? "Folder";
			return this.registerFolderFileEntry(rootFolder, relativePath, file);
		}

		const virtualPath = this.allocateUniquePath(file.name);
		this.files.set(virtualPath, {
			virtualPath,
			name: file.name,
			folder: null,
			originalFile: file,
			mimeType: file.type || "application/octet-stream",
		});
		this.fileToPath.set(file, virtualPath);
		this.notify();
		return virtualPath;
	}

	registerFolderFileEntry(
		rootFolder: string,
		relativePath: string,
		file: File,
	): string {
		const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
		const virtualPath = normalized.startsWith(`${rootFolder}/`)
			? normalized
			: `${rootFolder}/${normalized}`;
		const parts = virtualPath.split("/");
		const name = parts.at(-1) ?? file.name;

		this.files.set(virtualPath, {
			virtualPath,
			name,
			folder: rootFolder,
			originalFile: file,
			mimeType: file.type || "application/octet-stream",
		});
		this.fileToPath.set(file, virtualPath);

		const folderList = this.folders.get(rootFolder) ?? [];
		if (!folderList.includes(virtualPath)) {
			folderList.push(virtualPath);
			this.folders.set(rootFolder, folderList);
		}
		this.notify();
		return virtualPath;
	}

	registerFolderBatch(
		rootFolder: string,
		entries: ReadonlyArray<{ relativePath: string; file: File }>,
	): string {
		if (!this.folders.has(rootFolder)) {
			this.folders.set(rootFolder, []);
		}
		for (const entry of entries) {
			this.registerFolderFileEntry(rootFolder, entry.relativePath, entry.file);
		}
		this.notify();
		return rootFolder;
	}

	private allocateUniquePath(baseName: string): string {
		const cleanName =
			baseName.replace(/\\/g, "/").split("/").at(-1) ?? baseName;
		if (!this.files.has(cleanName)) {
			return cleanName;
		}
		const dotIdx = cleanName.lastIndexOf(".");
		const stem = dotIdx > 0 ? cleanName.slice(0, dotIdx) : cleanName;
		const ext = dotIdx > 0 ? cleanName.slice(dotIdx) : "";
		let counter = 2;
		let candidate = `${stem}_${counter}${ext}`;
		while (this.files.has(candidate)) {
			counter++;
			candidate = `${stem}_${counter}${ext}`;
		}
		return candidate;
	}

	hasPath(virtualPath: string): boolean {
		if (this.files.has(virtualPath)) return true;
		for (const record of this.files.values()) {
			if (record.cleanedOutputPath === virtualPath) return true;
		}
		return false;
	}

	isFolder(virtualPath: string): boolean {
		return this.folders.has(virtualPath);
	}

	getFolderFiles(folderPath: string): string[] {
		return [...(this.folders.get(folderPath) ?? [])];
	}

	getRecord(virtualPath: string): StoredFileRecord | undefined {
		const direct = this.files.get(virtualPath);
		if (direct !== undefined) return direct;
		for (const record of this.files.values()) {
			if (record.cleanedOutputPath === virtualPath) {
				return record;
			}
		}
		return undefined;
	}

	getBinaryForExiftool(virtualPath: string): {
		name: string;
		data: File | Uint8Array;
	} | null {
		const direct = this.files.get(virtualPath);
		if (direct !== undefined) {
			if (
				direct.cleanedOutputPath === virtualPath &&
				direct.cleanedBytes !== undefined
			) {
				return { name: direct.name, data: direct.cleanedBytes };
			}
			return { name: direct.name, data: direct.originalFile };
		}

		for (const record of this.files.values()) {
			if (
				record.cleanedOutputPath === virtualPath &&
				record.cleanedBytes !== undefined
			) {
				const outName = virtualPath.split("/").at(-1) ?? record.name;
				return { name: outName, data: record.cleanedBytes };
			}
		}
		return null;
	}

	setCleanedOutput({
		sourcePath,
		outputPath,
		bytes,
	}: {
		sourcePath: string;
		outputPath: string;
		bytes: Uint8Array;
	}): void {
		const record = this.files.get(sourcePath);
		if (record !== undefined) {
			record.cleanedBytes = bytes;
			record.cleanedOutputPath = outputPath;
			this.notify();
		}
	}

	getCleanedCount(): number {
		let count = 0;
		for (const record of this.files.values()) {
			if (record.cleanedBytes !== undefined) {
				count++;
			}
		}
		return count;
	}

	downloadSingleFile(targetPath: string): boolean {
		const record = this.getRecord(targetPath);
		if (record === undefined) return false;

		const isCleanedTarget =
			record.cleanedBytes !== undefined &&
			(targetPath === record.cleanedOutputPath ||
				targetPath === record.virtualPath);

		if (isCleanedTarget && record.cleanedBytes !== undefined) {
			const outPath = record.cleanedOutputPath ?? record.virtualPath;
			const downloadName = outPath.split("/").at(-1) ?? record.name;
			const copy = new Uint8Array(record.cleanedBytes.byteLength);
			copy.set(record.cleanedBytes);
			const blob = new Blob([copy], { type: record.mimeType });
			triggerBrowserDownload(blob, downloadName);
			return true;
		}

		triggerBrowserDownload(record.originalFile, record.name);
		return true;
	}

	downloadAllCleaned(): number {
		const cleanedRecords = Array.from(this.files.values()).filter(
			(
				r,
			): r is StoredFileRecord & {
				cleanedBytes: Uint8Array;
			} => r.cleanedBytes !== undefined,
		);

		if (cleanedRecords.length === 0) {
			return 0;
		}

		const first = cleanedRecords[0];
		if (cleanedRecords.length === 1 && first !== undefined) {
			this.downloadSingleFile(first.cleanedOutputPath ?? first.virtualPath);
			return 1;
		}

		const zipEntries: Record<string, Uint8Array> = {};
		const usedNames = new Set<string>();

		for (const record of cleanedRecords) {
			const preferredPath = (
				record.cleanedOutputPath ?? record.virtualPath
			).replace(/^\/+/, "");
			let entryName = preferredPath;
			let counter = 2;
			while (usedNames.has(entryName)) {
				const dot = preferredPath.lastIndexOf(".");
				const stem = dot > 0 ? preferredPath.slice(0, dot) : preferredPath;
				const ext = dot > 0 ? preferredPath.slice(dot) : "";
				entryName = `${stem}_${counter}${ext}`;
				counter++;
			}
			usedNames.add(entryName);
			zipEntries[entryName] = record.cleanedBytes;
		}

		const zipped = zipSync(zipEntries, { level: 6 });
		const zipCopy = new Uint8Array(zipped.byteLength);
		zipCopy.set(zipped);
		const blob = new Blob([zipCopy], { type: "application/zip" });
		triggerBrowserDownload(blob, "imgcleaner-cleaned.zip");
		return cleanedRecords.length;
	}

	clear(): void {
		this.files.clear();
		this.folders.clear();
		this.notify();
	}
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 5000);
}

export const webFileStore = new WebFileStore();
