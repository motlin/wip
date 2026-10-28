/**
 * Builds the single SSE response for the whole app. The route handler in
 * routes/api/events.ts delegates here so the stream lifecycle can be tested
 * without the TanStack Start wrapper.
 */
export async function createEventsResponse(): Promise<Response> {
	const {emitter: taskEmitter, getAllActiveTasks} = await import("./task-queue.js");
	const {actionEmitter} = await import("./action-events.js");
	const {emitter: mergeEmitter} = await import("./merge-queue.js");
	const {projectEmitter} = await import("./project-events.js");
	const {childrenEmitter} = await import("./children-events.js");
	const {todoEmitter} = await import("./todo-events.js");
	const {githubEmitter} = await import("./github-events.js");
	const {getSchedulerState, onRefreshError, onSchedulerStateChange} = await import("./refresh-scheduler.js");
	const {ensureBackgroundRefresh} = await import("./background-refresh.js");
	const {getProjects} = await import("./server-fns.js");
	const {readyBufferEmitter} = await import("./ready-buffer-events.js");
	const {currentReadyBuffer} = await import("./ready-buffer-instance.js");
	const {log} = await import("@wip/shared/services/logger-pino.js");
	ensureBackgroundRefresh();

	// Set once start() has registered listeners; called when the client disconnects.
	let releaseOnCancel: (() => void) | undefined;

	const stream = new ReadableStream({
		cancel() {
			releaseOnCancel?.();
		},
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false as boolean;
			const disposers: Array<() => void> = [];

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
				.then((projects) => {
					send("projects", projects);
					return undefined;
				})
				.catch((error: unknown) => {
					log.general.error({error}, "events stream: initial project send failed");
				});
			send("refresh-state", getSchedulerState());
			const readyBuffer = currentReadyBuffer();
			if (readyBuffer) send("ready-buffer", readyBuffer.state());

			// A failed initial send already ran cleanup(); register nothing then.
			if (closed) return;

			const onTask = (event: unknown) => {
				send("task", event);
			};
			const onMerge = (event: unknown) => {
				send("merge", event);
			};
			const onProjects = (event: unknown) => {
				send("projects", event);
			};
			const onChildren = (event: unknown) => {
				send("children", event);
			};
			const onTodos = (event: unknown) => {
				send("todos", event);
			};
			const onIssues = (event: unknown) => {
				send("issues", event);
			};
			const onProjectItems = (event: unknown) => {
				send("projectItems", event);
			};
			const onAction = (event: unknown) => {
				send("action", event);
			};
			const onReadyBuffer = (event: unknown) => {
				send("ready-buffer", event);
			};
			taskEmitter.on("task", onTask);
			actionEmitter.on("action", onAction);
			mergeEmitter.on("mergeStatus", onMerge);
			projectEmitter.on("projects", onProjects);
			childrenEmitter.on("children", onChildren);
			todoEmitter.on("todos", onTodos);
			githubEmitter.on("issues", onIssues);
			githubEmitter.on("projectItems", onProjectItems);
			readyBufferEmitter.on("state", onReadyBuffer);
			disposers.push(
				() => readyBufferEmitter.off("state", onReadyBuffer),
				() => taskEmitter.off("task", onTask),
				() => actionEmitter.off("action", onAction),
				() => mergeEmitter.off("mergeStatus", onMerge),
				() => projectEmitter.off("projects", onProjects),
				() => childrenEmitter.off("children", onChildren),
				() => todoEmitter.off("todos", onTodos),
				() => githubEmitter.off("issues", onIssues),
				() => githubEmitter.off("projectItems", onProjectItems),
			);
			disposers.push(
				onRefreshError((event) => {
					send("refresh-error", event);
				}),
				onSchedulerStateChange((state) => {
					send("refresh-state", state);
				}),
			);

			const keepalive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					cleanup();
				}
			}, 15000);
			disposers.push(() => {
				clearInterval(keepalive);
			});

			function cleanup() {
				if (closed) return;
				closed = true;
				for (const dispose of disposers) dispose();
				try {
					controller.close();
				} catch {
					// stream already closed
				}
			}
			releaseOnCancel = cleanup;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
