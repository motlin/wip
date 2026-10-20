import {createFileRoute} from "@tanstack/react-router";

/**
 * The single SSE stream for the whole app. Every server push (task queue,
 * merge status, project list, children, todos, background refresh errors)
 * multiplexes over this connection as {channel, data} envelopes, so the
 * browser's six-connections-per-origin cap never starves mutation POSTs.
 */
export const Route = createFileRoute("/api/events")({
	server: {
		handlers: {
			GET: async () => {
				const {createEventsResponse} = await import("../../lib/events-stream.js");
				return createEventsResponse();
			},
		},
	},
});
