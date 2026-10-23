import {createRepoResourceLock, createSystemProbe, createWorkQueue, type CostClass, type WorkQueue} from "@wip/shared";

/**
 * Process-wide queue for CLI commands that run git/test subprocesses. Same cost-class caps and
 * `repo:<project>` exclusion as the web server's queue, plus the on-disk repo lock so the CLI and
 * a running server never work on one repo at the same time.
 */
let queue: WorkQueue | undefined;

function getQueue(): WorkQueue {
	queue ??= createWorkQueue({
		globalConcurrency: 2,
		probe: createSystemProbe(),
		resourceLock: createRepoResourceLock(),
	});
	return queue;
}

let nextKey = 1;

/** Run `fn` as a queued job holding the repo's lock; resolves with its result and rethrows its error. */
export async function runInRepoQueue<T>(
	project: string,
	kind: string,
	costClass: CostClass,
	fn: () => Promise<T>,
): Promise<T> {
	let finish!: {resolve: (value: T) => void; reject: (reason: unknown) => void};
	const outcome = new Promise<T>((resolve, reject) => {
		finish = {resolve, reject};
	});
	getQueue().enqueue({
		coalesceKey: `cli:${kind}:${project}:${nextKey++}`,
		resources: [`repo:${project}`],
		kind,
		project,
		costClass,
		priority: "foreground",
		run: async () => {
			try {
				finish.resolve(await fn());
			} catch (error) {
				finish.reject(error);
			}
		},
	});
	return outcome;
}
