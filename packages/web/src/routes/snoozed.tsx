import {createFileRoute} from '@tanstack/react-router';
import {useSuspenseQuery, useQueryClient} from '@tanstack/react-query';
import {AlarmClockOff} from 'lucide-react';
import {unsnoozeChildFn} from '../lib/server-fns';
import type {SnoozedChild} from '../lib/server-fns';
import {snoozedQueryOptions} from '../lib/queries';

export const Route = createFileRoute('/snoozed')({
	loader: ({context: {queryClient}}) => queryClient.ensureQueryData(snoozedQueryOptions()),
	head: () => ({
		meta: [{title: 'WIP Snoozed'}],
	}),
	component: Snoozed,
});

function formatUntil(until: string | null): string {
	if (!until) return 'On Hold';
	const date = new Date(until);
	const now = new Date();
	const diffMs = date.getTime() - now.getTime();
	if (diffMs <= 0) return 'Expired';
	const hours = Math.floor(diffMs / (1000 * 60 * 60));
	if (hours < 1) return `${Math.ceil(diffMs / (1000 * 60))}m remaining`;
	if (hours < 24) return `${hours}h remaining`;
	const days = Math.floor(hours / 24);
	return `${days}d remaining`;
}

function Snoozed() {
	const {data: snoozed} = useSuspenseQuery(snoozedQueryOptions());

	const onHold = snoozed.filter((s) => s.until === null);
	const timed = snoozed.filter((s) => s.until !== null);

	return (
		<div className="mx-auto max-w-2xl p-6">
			<div className="mb-6 flex items-baseline justify-between">
				<h1 className="text-xl font-semibold">Snoozed</h1>
				<span className="text-sm text-text-500">{snoozed.length} items</span>
			</div>
			{snoozed.length === 0 ? (
				<p className="text-sm text-text-500">No snoozed items.</p>
			) : (
				<div className="flex flex-col gap-6">
					{onHold.length > 0 && (
						<section>
							<h2 className="mb-2 text-sm font-semibold text-text-300">
								On Hold
								<span className="ml-2 font-normal text-text-500">{onHold.length}</span>
							</h2>
							<div className="flex flex-col gap-2">
								{onHold.map((item) => (
									<SnoozedCard key={`${item.project}:${item.sha}`} item={item} />
								))}
							</div>
						</section>
					)}
					{timed.length > 0 && (
						<section>
							<h2 className="mb-2 text-sm font-semibold text-yellow-700 dark:text-yellow-400">
								Timed
								<span className="ml-2 font-normal text-text-500">{timed.length}</span>
							</h2>
							<div className="flex flex-col gap-2">
								{timed.map((item) => (
									<SnoozedCard key={`${item.project}:${item.sha}`} item={item} />
								))}
							</div>
						</section>
					)}
				</div>
			)}
		</div>
	);
}

function SnoozedCard({item}: {item: SnoozedChild}) {
	const queryClient = useQueryClient();

	const handleUnsnooze = async () => {
		// Optimistically remove from snoozed list
		queryClient.setQueryData<SnoozedChild[]>(['snoozed'], (old) => old?.filter((s) => !(s.sha === item.sha && s.project === item.project)));
		const result = await unsnoozeChildFn({data: {sha: item.sha, project: item.project}});
		if (result.ok) {
			queryClient.invalidateQueries({queryKey: ['children', item.project]});
		} else {
			queryClient.invalidateQueries({queryKey: ['snoozed']});
		}
	};

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm">
			<div className="flex items-start justify-between gap-2">
				<span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300">
					{item.shortSha || item.sha.slice(0, 7)}
				</span>
				<span className="text-xs text-text-500">{formatUntil(item.until)}</span>
			</div>
			{item.subject && (
				<p className="mt-1.5 text-sm leading-snug text-text-100">{item.subject}</p>
			)}
			<div className="mt-2 flex items-center justify-between">
				<span className="text-xs font-medium text-text-300">{item.project}</span>
				<button
					type="button"
					onClick={handleUnsnooze}
					className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
				>
					<AlarmClockOff className="h-3 w-3" />
					Wake
				</button>
			</div>
		</div>
	);
}
