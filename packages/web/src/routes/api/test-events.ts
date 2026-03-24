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
						let closed = false;

						function send(data: unknown) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
							} catch {
								cleanup();
							}
						}

						// Send current state on connect
						for (const job of getAllActiveJobs()) {
							send({id: job.id, sha: job.sha, project: job.project, shortSha: job.shortSha, subject: job.subject, branch: job.branch, status: job.status, message: job.message});
						}

						function onJob(event: unknown) {
							send(event);
						}

						emitter.on('job', onJob);

						// Clean up when client disconnects (detected when enqueue throws)
						const keepalive = setInterval(() => {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(': keepalive\n\n'));
							} catch {
								cleanup();
							}
						}, 15000);

						function cleanup() {
							if (closed) return;
							closed = true;
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
