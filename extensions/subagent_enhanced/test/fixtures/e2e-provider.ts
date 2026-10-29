import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", {
					agent: "worker",
					description: "Task A",
					prompt: "Return A",
				}),
				fauxToolCall("subagent", {
					agent: "worker",
					description: "Task B",
					prompt: "Return B",
				}),
			],
			{ stopReason: "toolUse" },
		),
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 5000));
			return fauxAssistantMessage("Result A");
		},
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 5000));
			return fauxAssistantMessage("Result B");
		},
		fauxAssistantMessage("Parent done"),
	]);
	pi.registerProvider("faux", {
		baseUrl: "http://faux",
		apiKey: "faux",
		api: faux.api,
		models: faux.models,
	});
	pi.on("session_start", async () => {
		await pi.setModel(faux.getModel());
	});
	pi.on("session_shutdown", () => faux.unregister());
}
