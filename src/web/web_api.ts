import stringsJson from "../domain/i18n/strings.json";
import type { ClassifiedFile } from "../common/ipc_channels";
import type { I18nStringsDictionary, Settings, ThemeMode } from "../domain";
import {
	ACCENT_COLOR_FALLBACK,
	DEFAULT_SETTINGS,
	isSupportedFile,
	SUPPORTED_EXTENSIONS,
} from "../domain";
import type { ElectronApi } from "../common/api_types";
import { wasmReadMetadata, wasmRemoveMetadata } from "./wasm_exiftool_engine";
import { webFileStore } from "./web_file_store";

const SETTINGS_STORAGE_KEY = "imgcleaner.web.settings.v1";

type SettingsListener = (settings: Settings) => void;
type LanguageListener = (locale: string) => void;
type ThemeListener = (payload: { shouldUseDarkColors: boolean }) => void;
type ThemeModeListener = (mode: ThemeMode) => void;
type ToggleListener = () => void;
type FileOpenListener = (filePaths: string[]) => void;
type BatchProgressListener = (state: {
	active: boolean;
	processed: number;
	total: number;
}) => void;

const settingsListeners = new Set<SettingsListener>();
const languageListeners = new Set<LanguageListener>();
const themeListeners = new Set<ThemeListener>();
const themeModeListeners = new Set<ThemeModeListener>();
const toggleListeners = new Set<ToggleListener>();
const fileOpenListeners = new Set<FileOpenListener>();
const batchProgressListeners = new Set<BatchProgressListener>();

let batchTotal = 0;
let batchProcessed = 0;
let batchActive = false;

export function subscribeBatchProgress(
	listener: BatchProgressListener,
): () => void {
	batchProgressListeners.add(listener);
	listener({
		active: batchActive,
		processed: batchProcessed,
		total: batchTotal,
	});
	return () => {
		batchProgressListeners.delete(listener);
	};
}

function notifyBatchProgress(): void {
	for (const listener of batchProgressListeners) {
		listener({
			active: batchActive,
			processed: batchProcessed,
			total: batchTotal,
		});
	}
}

function loadStoredSettings(): Settings {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return {
			preserveOrientation:
				typeof parsed.preserveOrientation === "boolean"
					? parsed.preserveOrientation
					: DEFAULT_SETTINGS.preserveOrientation,
			preserveColorProfile:
				typeof parsed.preserveColorProfile === "boolean"
					? parsed.preserveColorProfile
					: DEFAULT_SETTINGS.preserveColorProfile,
			preserveResolution:
				typeof parsed.preserveResolution === "boolean"
					? parsed.preserveResolution
					: DEFAULT_SETTINGS.preserveResolution,
			saveAsCopy:
				typeof parsed.saveAsCopy === "boolean"
					? parsed.saveAsCopy
					: DEFAULT_SETTINGS.saveAsCopy,
			removeXattrs:
				typeof parsed.removeXattrs === "boolean"
					? parsed.removeXattrs
					: DEFAULT_SETTINGS.removeXattrs,
			preserveTimestamps:
				typeof parsed.preserveTimestamps === "boolean"
					? parsed.preserveTimestamps
					: DEFAULT_SETTINGS.preserveTimestamps,
			language:
				typeof parsed.language === "string" || parsed.language === null
					? parsed.language
					: DEFAULT_SETTINGS.language,
			themeMode:
				parsed.themeMode === "light" ||
				parsed.themeMode === "dark" ||
				parsed.themeMode === "system"
					? parsed.themeMode
					: DEFAULT_SETTINGS.themeMode,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

let currentSettings: Settings = loadStoredSettings();

function saveSettings(next: Settings): void {
	currentSettings = next;
	try {
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Ignore storage quota errors in private browsing
	}
}

function resolveBrowserLocale(): string {
	if (currentSettings.language !== null && currentSettings.language !== "") {
		return currentSettings.language;
	}
	const navLang = typeof navigator !== "undefined" ? navigator.language : "en";
	return navLang || "en";
}

function shouldUseDark(mode: ThemeMode): boolean {
	if (mode === "dark") return true;
	if (mode === "light") return false;
	if (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function"
	) {
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	}
	return false;
}

function pickFilesFromBrowser(options: {
	directory: boolean;
}): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.style.display = "none";

		if (options.directory) {
			input.setAttribute("webkitdirectory", "");
			input.setAttribute("directory", "");
		} else {
			input.accept = Array.from(SUPPORTED_EXTENSIONS).join(",");
		}

		let settled = false;
		const finish = (files: File[]): void => {
			if (settled) return;
			settled = true;
			if (input.parentNode) {
				input.parentNode.removeChild(input);
			}
			resolve(files);
		};

		input.addEventListener("change", () => {
			const files = input.files ? Array.from(input.files) : [];
			finish(files);
		});

		input.addEventListener("cancel", () => {
			finish([]);
		});

		document.body.appendChild(input);
		input.click();
	});
}

interface WebkitFileEntry {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly name: string;
	readonly fullPath: string;
	file?: (
		success: (file: File) => void,
		error?: (err: unknown) => void,
	) => void;
	createReader?: () => {
		readEntries: (
			success: (entries: WebkitFileEntry[]) => void,
			error?: (err: unknown) => void,
		) => void;
	};
}

async function readEntryFiles(
	entry: WebkitFileEntry,
): Promise<Array<{ relativePath: string; file: File }>> {
	if (entry.isFile && entry.file !== undefined) {
		const file = await new Promise<File | null>((resolve) => {
			entry.file?.(
				(f) => resolve(f),
				() => resolve(null),
			);
		});
		if (file === null) return [];
		const rel = entry.fullPath.replace(/^\/+/, "") || file.name;
		return [{ relativePath: rel, file }];
	}

	if (entry.isDirectory && entry.createReader !== undefined) {
		const reader = entry.createReader();
		const allEntries: WebkitFileEntry[] = [];
		while (true) {
			const batch = await new Promise<WebkitFileEntry[]>((resolve) => {
				reader.readEntries(
					(entries) => resolve(entries),
					() => resolve([]),
				);
			});
			if (batch.length === 0) break;
			allEntries.push(...batch);
		}
		const nested = await Promise.all(allEntries.map(readEntryFiles));
		return nested.flat();
	}

	return [];
}

export function setupWebDirectoryDropSupport(): () => void {
	const handleCaptureDrop = (e: DragEvent): void => {
		const items = e.dataTransfer?.items;
		if (!items || items.length === 0) return;

		const entries: WebkitFileEntry[] = [];
		let hasDirectory = false;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item) continue;
			const webkitEntry = (
				item as DataTransferItem & {
					webkitGetAsEntry?: () => WebkitFileEntry | null;
				}
			).webkitGetAsEntry?.();
			if (webkitEntry) {
				entries.push(webkitEntry);
				if (webkitEntry.isDirectory) {
					hasDirectory = true;
				}
			}
		}

		if (!hasDirectory) {
			return;
		}

		e.preventDefault();
		e.stopPropagation();

		void (async () => {
			const pathsToProcess: string[] = [];
			for (const entry of entries) {
				if (entry.isFile && entry.file !== undefined) {
					const found = await readEntryFiles(entry);
					for (const item of found) {
						pathsToProcess.push(webFileStore.registerLooseFile(item.file));
					}
				} else if (entry.isDirectory) {
					const folderFiles = await readEntryFiles(entry);
					const folderPath = webFileStore.registerFolderBatch(
						entry.name,
						folderFiles,
					);
					pathsToProcess.push(folderPath);
				}
			}
			if (pathsToProcess.length > 0) {
				for (const listener of fileOpenListeners) {
					listener(pathsToProcess);
				}
			}
		})();
	};

	window.addEventListener("drop", handleCaptureDrop, true);
	return () => {
		window.removeEventListener("drop", handleCaptureDrop, true);
	};
}

export function createWebApi(): ElectronApi {
	if (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function"
	) {
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		mediaQuery.addEventListener("change", () => {
			if (currentSettings.themeMode === "system") {
				const shouldUseDarkColors = shouldUseDark("system");
				for (const listener of themeListeners) {
					listener({ shouldUseDarkColors });
				}
			}
		});
	}

	if (
		typeof window !== "undefined" &&
		typeof window.addEventListener === "function"
	) {
		window.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === ",") {
				e.preventDefault();
				for (const listener of toggleListeners) {
					listener();
				}
			}
		});
	}

	return {
		exif: {
			readMetadata: async (filePath: string) => {
				return wasmReadMetadata(filePath);
			},
			removeMetadata: async (filePath: string) => {
				return wasmRemoveMetadata({
					filePath,
					settings: currentSettings,
				});
			},
		},
		i18n: {
			getLocale: async () => resolveBrowserLocale(),
			getStrings: async () => stringsJson as unknown as I18nStringsDictionary,
			onLanguageChanged: (callback) => {
				languageListeners.add(callback);
				return () => {
					languageListeners.delete(callback);
				};
			},
		},
		files: {
			basename: (filePath: string) => {
				const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
				return normalized.split("/").at(-1) ?? filePath;
			},
			getPathForFile: (file: File) => {
				return webFileStore.registerLooseFile(file);
			},
			chooseFiles: async () => {
				const selected = await pickFilesFromBrowser({ directory: false });
				return selected.map((file) => webFileStore.registerLooseFile(file));
			},
			chooseFolder: async () => {
				const selected = await pickFilesFromBrowser({ directory: true });
				if (selected.length === 0) return null;
				const first = selected[0];
				const rawRel =
					first &&
					typeof first.webkitRelativePath === "string" &&
					first.webkitRelativePath.length > 0
						? first.webkitRelativePath.replace(/\\/g, "/")
						: "";
				const rootFolder = rawRel.split("/")[0] || "SelectedFolder";
				const entries = selected.map((file) => ({
					relativePath:
						typeof file.webkitRelativePath === "string" &&
						file.webkitRelativePath.length > 0
							? file.webkitRelativePath.replace(/\\/g, "/")
							: `${rootFolder}/${file.name}`,
					file,
				}));
				return webFileStore.registerFolderBatch(rootFolder, entries);
			},
			notifyFilesAdded: (count: number) => {
				batchTotal += count;
				batchActive = true;
				notifyBatchProgress();
			},
			notifyFileProcessed: () => {
				batchProcessed += 1;
				notifyBatchProgress();
			},
			notifyAllFilesProcessed: () => {
				batchActive = false;
				notifyBatchProgress();
			},
			onFileOpenAddFiles: (callback) => {
				fileOpenListeners.add(callback);
				return () => {
					fileOpenListeners.delete(callback);
				};
			},
		},
		theme: {
			get: async () => ({
				shouldUseDarkColors: shouldUseDark(currentSettings.themeMode),
			}),
			set: async (mode: ThemeMode) => {
				saveSettings({ ...currentSettings, themeMode: mode });
				const shouldUseDarkColors = shouldUseDark(mode);
				for (const listener of themeListeners) {
					listener({ shouldUseDarkColors });
				}
				for (const listener of themeModeListeners) {
					listener(mode);
				}
				return { success: true };
			},
			getAccentColor: async () => ({
				color: ACCENT_COLOR_FALLBACK,
			}),
			onChanged: (callback) => {
				themeListeners.add(callback);
				return () => {
					themeListeners.delete(callback);
				};
			},
			onAccentColorChanged: () => {
				return () => {};
			},
			onThemeModeChanged: (callback) => {
				themeModeListeners.add(callback);
				return () => {
					themeModeListeners.delete(callback);
				};
			},
		},
		settings: {
			get: async () => ({ ...currentSettings }),
			set: async (partial: Partial<Settings>) => {
				const previousLanguage = currentSettings.language;
				const next: Settings = {
					...currentSettings,
					...partial,
				};
				saveSettings(next);
				for (const listener of settingsListeners) {
					listener({ ...next });
				}
				if (
					partial.language !== undefined &&
					partial.language !== previousLanguage
				) {
					const newLocale = resolveBrowserLocale();
					for (const listener of languageListeners) {
						listener(newLocale);
					}
				}
				return { success: true, error: null };
			},
			onChanged: (callback) => {
				settingsListeners.add(callback);
				return () => {
					settingsListeners.delete(callback);
				};
			},
			onToggle: (callback) => {
				toggleListeners.add(callback);
				return () => {
					toggleListeners.delete(callback);
				};
			},
		},
		platform: {
			isMac: false,
		},
		reveal: {
			showInFolder: async (filePath: string) => {
				const ok = webFileStore.downloadSingleFile(filePath);
				if (!ok) {
					return {
						success: false,
						error: `File is no longer available in browser memory: ${filePath}`,
					};
				}
				return { success: true };
			},
			showContextMenu: async (paths) => {
				webFileStore.downloadSingleFile(paths.cleanedPath);
				return { success: true };
			},
		},
		folder: {
			classify: async (paths: string[]) => {
				const files: ClassifiedFile[] = [];
				const folders: string[] = [];

				for (const p of paths) {
					if (webFileStore.isFolder(p)) {
						folders.push(p);
						continue;
					}
					const record = webFileStore.getRecord(p);
					if (record !== undefined) {
						files.push({
							path: record.virtualPath,
							size: record.originalFile.size,
						});
					}
				}
				return { files, folders };
			},
			expand: async (dirPath: string) => {
				const allInFolder = webFileStore.getFolderFiles(dirPath);
				const supported: string[] = [];
				let skippedCount = 0;

				for (const filePath of allInFolder) {
					if (isSupportedFile({ filename: filePath })) {
						supported.push(filePath);
					} else {
						skippedCount++;
					}
				}
				return { files: supported, skippedCount };
			},
		},
	};
}
