// Browser-only stub for `node:fs/promises` imported statically by `@6over3/zeroperl-ts`.
// In browser environments, `wasm_exiftool_engine.ts` always supplies a custom `fetch`
// callback to `ZeroPerl.create()`, so `readFile` is never invoked at runtime.
export async function readFile(): Promise<Uint8Array> {
	throw new Error("node:fs/promises is not available in the browser");
}
export default { readFile };
