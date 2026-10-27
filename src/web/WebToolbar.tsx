import { useEffect, useState } from "react";
import { App } from "../renderer/App";
import { preloadWasmEngine } from "./wasm_exiftool_engine";
import {
	setupWebDirectoryDropSupport,
	subscribeBatchProgress,
} from "./web_api";
import { webFileStore } from "./web_file_store";
import "./web_toolbar.css";

export function WebAppShell(): React.JSX.Element {
	const [wasmReady, setWasmReady] = useState(false);
	const [cleanedCount, setCleanedCount] = useState(0);
	const [isProcessing, setIsProcessing] = useState(false);

	useEffect(() => {
		let active = true;
		preloadWasmEngine()
			.then(() => {
				if (active) setWasmReady(true);
			})
			.catch(() => {
				if (active) setWasmReady(true);
			});

		const cleanupDrop = setupWebDirectoryDropSupport();
		const unsubscribeStore = webFileStore.subscribe(() => {
			setCleanedCount(webFileStore.getCleanedCount());
		});
		const unsubscribeProgress = subscribeBatchProgress((progress) => {
			setIsProcessing(progress.active);
		});

		const handleDocumentClick = (e: MouseEvent): void => {
			const target = e.target as HTMLElement | null;
			if (target?.closest(".status-bar__button")) {
				webFileStore.clear();
			}
		};
		document.addEventListener("click", handleDocumentClick);

		return () => {
			active = false;
			cleanupDrop();
			unsubscribeStore();
			unsubscribeProgress();
			document.removeEventListener("click", handleDocumentClick);
		};
	}, []);

	function handleDownloadAll(): void {
		webFileStore.downloadAllCleaned();
	}

	return (
		<div className="web-shell">
			<header className="web-toolbar">
				<div className="web-toolbar__brand">
					<span className="web-toolbar__title">imgCleaner</span>
					<span className="web-toolbar__badge">
						<span
							className={`web-toolbar__dot${wasmReady ? "" : " web-toolbar__dot--loading"}`}
						/>
						{wasmReady
							? "100% Client-Side (ExifTool WASM) • Files never leave your device"
							: "Loading ExifTool WebAssembly..."}
					</span>
				</div>
				<div className="web-toolbar__actions">
					{cleanedCount > 0 && (
						<button
							type="button"
							className="web-toolbar__download-btn"
							onClick={handleDownloadAll}
							disabled={isProcessing}
							title={
								cleanedCount === 1
									? "Download cleaned file"
									: `Download all ${cleanedCount} cleaned files as ZIP`
							}
						>
							<svg
								width="14"
								height="14"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M8 2v8" />
								<path d="M4.5 6.5 8 10l3.5-3.5" />
								<path d="M2.5 13h11" />
							</svg>
							{cleanedCount === 1
								? "Download Cleaned File"
								: `Download All (${cleanedCount}) .ZIP`}
						</button>
					)}
				</div>
			</header>
			<App />
		</div>
	);
}
