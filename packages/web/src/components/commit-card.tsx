import {useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';
import type {CommitItem} from '@wip/shared';
import {Diff, GitBranch, Loader2} from 'lucide-react';
import {createBranch} from '../lib/server-fns';

export function CommitCard({commit}: {commit: CommitItem}) {
	const queryClient = useQueryClient();
	const [branchName, setBranchName] = useState(commit.suggestedBranch ?? '');
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreateBranch = async () => {
		if (!branchName.trim()) return;
		setCreating(true);
		setError(null);
		const result = await createBranch({data: {project: commit.project, sha: commit.sha, branchName: branchName.trim()}});
		setCreating(false);
		if (result.ok) {
			queryClient.invalidateQueries({queryKey: ['children', commit.project]});
		} else {
			setError(result.message);
		}
	};

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-start justify-between gap-2">
				<a
					href={`https://github.com/${commit.remote}`}
					target="_blank"
					rel="noopener noreferrer"
					className="truncate text-xs font-medium text-text-300 hover:text-text-100 transition-colors"
				>
					{commit.remote}
				</a>
				<div className="flex items-center gap-1.5 shrink-0">
					<a
						href={`/diff/${commit.project}/${commit.sha}`}
						target="_blank"
						rel="noopener noreferrer"
						title="View diff"
						className="rounded p-0.5 text-text-500 transition-colors hover:text-text-200 hover:bg-bg-200"
					>
						<Diff className="h-3.5 w-3.5" />
					</a>
					{commit.date && (
						<span className="text-xs text-text-500">{commit.date}</span>
					)}
				</div>
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">
				<span className="font-mono text-xs text-text-400 mr-1.5">{commit.shortSha}</span>
				{commit.subject}
			</p>
			<div className="mt-2 border-t border-border-300/20 pt-2">
				<div className="flex items-center gap-1.5">
					<GitBranch className="h-3.5 w-3.5 shrink-0 text-text-400" />
					<input
						type="text"
						value={branchName}
						onChange={(e) => setBranchName(e.target.value)}
						onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); }}
						placeholder="branch-name"
						className="min-w-0 flex-1 rounded border border-border-300/50 bg-bg-100 px-2 py-1 font-mono text-xs text-text-100 outline-none focus:border-blue-500"
					/>
					<button
						type="button"
						onClick={handleCreateBranch}
						disabled={creating || !branchName.trim()}
						className={`inline-flex items-center gap-1 shrink-0 rounded px-2 py-1 text-xs font-medium transition-colors ${
							creating || !branchName.trim() ? 'cursor-not-allowed opacity-60 text-text-400' : 'bg-blue-600 hover:bg-blue-700 text-white'
						}`}
					>
						{creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
						Create Branch
					</button>
				</div>
				{error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
			</div>
		</div>
	);
}
