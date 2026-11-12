import type {ReactElement} from "react";
import type {Category} from "@wip/shared";
import {
	isGitChildPullRequest,
	isGitChildBranch,
	isGitChildPrRefsMissing,
	isGitChildRemoteOnly,
	isGitChildUpstreamCi,
} from "@wip/shared/git-child-discriminators.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {CommitCard} from "./commit-card.js";
import {BranchCard} from "./branch-card.js";
import {PullRequestCard} from "./pull-request-card.js";
import {UpstreamCiCard} from "./upstream-ci-card.js";
import {PrRefsMissingCard, RemoteOnlyCard} from "./remote-only-card.js";

/** A git child's card, by its kind. */
export function gitChildCard(child: GitChildResult, category: Category): ReactElement {
	if (isGitChildUpstreamCi(child)) {
		return <UpstreamCiCard key={`${child.remote}-${child.sha}`} item={child} category={category} />;
	}
	if (isGitChildPrRefsMissing(child)) {
		return <PrRefsMissingCard key={`pr-refs-${child.project}`} item={child} category={category} />;
	}
	if (isGitChildRemoteOnly(child)) return <RemoteOnlyCard key={child.sha} commit={child} category={category} />;
	if (isGitChildPullRequest(child)) return <PullRequestCard key={child.sha} pr={child} category={category} />;
	if (isGitChildBranch(child)) return <BranchCard key={child.sha} branch={child} category={category} />;
	return <CommitCard key={child.sha} commit={child} category={category} />;
}
