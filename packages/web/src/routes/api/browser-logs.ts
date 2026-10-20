import {createFileRoute} from "@tanstack/react-router";
import {z} from "zod";

const BrowserLogEntrySchema = z.object({
	level: z.enum(["log", "error", "warn", "info", "debug"]),
	message: z.string(),
	timestamp: z.string(),
});

const BrowserLogBodySchema = z.union([
	z.array(BrowserLogEntrySchema),
	BrowserLogEntrySchema.transform((entry) => [entry]),
]);

export const Route = createFileRoute("/api/browser-logs")({
	server: {
		handlers: {
			POST: async ({request}: {request: Request}) => {
				const {writeBrowserLogs} = await import("../../lib/browser-log-writer.js");
				const body: unknown = await request.json();
				const parsed = BrowserLogBodySchema.safeParse(body);
				if (!parsed.success) {
					return new Response("Invalid browser log payload", {status: 400});
				}
				writeBrowserLogs(parsed.data);
				return new Response(null, {status: 204});
			},
		},
	},
});
