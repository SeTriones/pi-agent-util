import { createRequire } from "node:module";
import { resolve } from "node:path";

// Use the same host-provided modules as Pi's extension loader.
const require = createRequire(
	process.env.PI_PACKAGE_DIR ? resolve(process.env.PI_PACKAGE_DIR, "package.json") : import.meta.url,
);
const { createJiti } = require("jiti");
const host = createJiti(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": host.esmResolve("@earendil-works/pi-coding-agent"),
		"@earendil-works/pi-tui": host.esmResolve("@earendil-works/pi-tui"),
	},
});
await jiti.import(new URL("./ui.test.ts", import.meta.url).href);
