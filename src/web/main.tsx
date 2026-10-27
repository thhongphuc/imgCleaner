import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createWebApi } from "./web_api";
import { WebAppShell } from "./WebToolbar";
import "../renderer/styles/reset.css";
import "../renderer/styles/tokens.css";
import "../renderer/styles/app.css";
import "../renderer/styles/drop_zone.css";
import "../renderer/styles/empty_state.css";
import "../renderer/styles/error_boundary.css";
import "../renderer/styles/file_list.css";
import "../renderer/styles/file_table.css";
import "../renderer/styles/folder_row.css";
import "../renderer/styles/status_bar.css";
import "../renderer/styles/status_icon.css";
import "../renderer/styles/toast.css";
import "../renderer/styles/type_pill.css";

if (typeof window !== "undefined" && typeof window.api === "undefined") {
	window.api = createWebApi();
}

const rootEl = document.getElementById("root");
if (!rootEl) {
	throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
	<StrictMode>
		<WebAppShell />
	</StrictMode>,
);
