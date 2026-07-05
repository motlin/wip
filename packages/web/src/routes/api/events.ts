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
				const {emitter: taskEmitter, getAllActiveTasks} = await import("../../lib/task-queue.js");
				const {emitter: mergeEmitter} = await import("../../lib/merge-queue.js");
				const {projectEmitter} = await import("../../lib/project-events.js");
				const {childrenEmitter} = await import("../../lib/children-events.js");
				const {todoEmitter} = await import("../../lib/todo-events.js");
				const {getSchedulerState, onRefreshError, onSchedulerStateChange} =
					await import("../../lib/refresh-scheduler.js");
				const {ensureBackgroundRefresh} = await import("../../lib/background-refresh.js");
				const {getProjects} = await import("../../lib/server-fns.js");
				const {log} = await import("@wip/shared/services/logger-pino.js");
				ensureBackgroundRefresh();

				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						let closed = false;

						function send(channel: string, data: unknown) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify({channel, data})}\n\n`));
							} catch {
								cleanup();
							}
						}

						// Current state on connect
						for (const task of getAllActiveTasks()) {
							send("task", {
								id: task.id,
								taskType: task.taskType,
								sha: task.sha,
								project: task.project,
								shortSha: task.shortSha,
								subject: task.subject,
								branch: task.branch,
								status: task.status,
								message: task.message,
							});
						}
						getProjects()
							.then((projects) => send("projects", projects))
							.catch((error: unknown) => {
								log.general.error({error}, "events stream: initial project send failed");
							});
						send("refresh-state", getSchedulerState());

						const onTask = (event: unknown) => send("task", event);
						const onMerge = (event: unknown) => send("merge", event);
						const onProjects = (event: unknown) => send("projects", event);
						const onChildren = (event: unknown) => send("children", event);
						const onTodos = (event: unknown) => send("todos", event);
						taskEmitter.on("task", onTask);
						mergeEmitter.on("mergeStatus", onMerge);
						projectEmitter.on("projects", onProjects);
						childrenEmitter.on("children", onChildren);
						todoEmitter.on("todos", onTodos);
						const unsubscribeErrors = onRefreshError((event) => send("refresh-error", event));
						const unsubscribeSchedulerState = onSchedulerStateChange((state) =>
							send("refresh-state", state),
						);

						const keepalive = setInterval(() => {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(": keepalive\n\n"));
							} catch {
								cleanup();
							}
						}, 15000);

						function cleanup() {
							if (closed) return;
							closed = true;
							taskEmitter.off("task", onTask);
							mergeEmitter.off("mergeStatus", onMerge);
							projectEmitter.off("projects", onProjects);
							childrenEmitter.off("children", onChildren);
							todoEmitter.off("todos", onTodos);
							unsubscribeErrors();
							unsubscribeSchedulerState();
							clearInterval(keepalive);
							try {
								controller.close();
							} catch {}
						}
					},
				});

				return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			},
		},
	},
});
