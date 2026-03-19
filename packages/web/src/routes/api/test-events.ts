import {createFileRoute} from '@tanstack/react-router';

export const Route = createFileRoute('/api/test-events')({
	server: {
		handlers: {
			GET: async () => {
				const {emitter} = await import('../../lib/test-queue.js');
				const {getAllActiveJobs} = await import('../../lib/test-queue.js');

				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();

						function send(data: unknown) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
						}

						// Send current state on connect
						for (const job of getAllActiveJobs()) {
							send({id: job.id, sha: job.sha, project: job.project, shortSha: job.shortSha, status: job.status, message: job.message});
						}

						function onJob(event: unknown) {
							send(event);
						}

						emitter.on('job', onJob);

						// Clean up when client disconnects (detected when enqueue throws)
						const keepalive = setInterval(() => {
							try {
								controller.enqueue(encoder.encode(': keepalive\n\n'));
							} catch {
								cleanup();
							}
						}, 15000);

						function cleanup() {
							emitter.off('job', onJob);
							clearInterval(keepalive);
							try { controller.close(); } catch {}
						}
					},
				});

				return new Response(stream, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'Connection': 'keep-alive',
					},
				});
			},
		},
	},
});
