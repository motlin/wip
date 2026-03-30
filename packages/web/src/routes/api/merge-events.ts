import {createFileRoute} from '@tanstack/react-router';

export const Route = createFileRoute('/api/merge-events')({
	// @ts-expect-error TanStack Start server handlers not yet in published types
	server: {
		handlers: {
			GET: async () => {
				const {emitter, checkAllProjects} = await import('../../lib/merge-queue.js');

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

						function onStatus(event: unknown) {
							send(event);
						}

						emitter.on('mergeStatus', onStatus);

						// Trigger background computation on connect
						checkAllProjects().catch(() => {});

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
							emitter.off('mergeStatus', onStatus);
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
