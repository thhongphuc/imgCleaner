import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: path.resolve(__dirname, "src/web"),
	publicDir: path.resolve(__dirname, "src/web/public"),
	plugins: [react()],
	assetsInclude: ["**/*.wasm"],
	resolve: {
		alias: {
			"node:fs/promises": path.resolve(
				__dirname,
				"src/web/node_fs_promises_stub.ts",
			),
		},
	},
	optimizeDeps: {
		exclude: ["@6over3/zeroperl-ts", "@uswriting/exiftool"],
	},
	build: {
		outDir: path.resolve(__dirname, "dist-web"),
		emptyOutDir: true,
		target: "es2022",
		chunkSizeWarningLimit: 1000,
	},
	server: {
		port: 5173,
		fs: {
			allow: [__dirname],
		},
	},
});
