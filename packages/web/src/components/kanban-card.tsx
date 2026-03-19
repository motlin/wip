import {useRouter} from '@tanstack/react-router';
import {ArrowRight, Play, Loader2} from 'lucide-react';
import {useState} from 'react';
import {pushChild, testChild} from '../lib/server-fns';
import type {ClassifiedChild} from '../lib/server-fns';

interface KanbanCardProps {
	child: ClassifiedChild;
}

export function KanbanCard({child}: KanbanCardProps) {
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handlePush = async () => {
		setLoading(true);
		setError(null);
		const result = await pushChild({data: {
			projectDir: child.projectDir,
			upstreamRemote: child.upstreamRemote,
			sha: child.sha,
			shortSha: child.shortSha,
			subject: child.subject,
			branch: child.branch,
		}});
		setLoading(false);
		if (result.ok) {
			router.invalidate();
		} else {
			setError(result.message);
		}
	};

	const handleTest = async () => {
		setLoading(true);
		setError(null);
		const result = await testChild({data: {
			project: child.project,
			projectDir: child.projectDir,
			sha: child.sha,
			shortSha: child.shortSha,
		}});
		setLoading(false);
		if (result.ok) {
			router.invalidate();
		} else {
			setError(result.message);
		}
	};

	const action = child.category === 'ready_to_push'
		? {label: 'Push', icon: ArrowRight, handler: handlePush, className: 'bg-green-600 hover:bg-green-700 text-white'}
		: child.category === 'ready_to_test'
			? {label: 'Test', icon: Play, handler: handleTest, className: 'bg-yellow-600 hover:bg-yellow-700 text-white'}
			: null;

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm transition-shadow hover:shadow-md">
			<div className="flex items-start justify-between gap-2">
				<span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300">
					{child.shortSha}
				</span>
				<span className="text-xs text-text-500">{child.date}</span>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{child.subject}</p>
			<div className="mt-2 flex items-center justify-between">
				<span className="text-xs font-medium text-text-300">{child.project}</span>
				{action && (
					<button
						type="button"
						onClick={action.handler}
						disabled={loading}
						className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
							loading ? 'cursor-not-allowed opacity-60' : action.className
						}`}
					>
						{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <action.icon className="h-3 w-3" />}
						{loading ? 'Running...' : action.label}
					</button>
				)}
			</div>
			{error && (
				<p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>
			)}
		</div>
	);
}
