import type {ReactNode} from "react";
import * as Lucide from "lucide-react";

/**
 * Every icon in the app, drawn once in a shared SVG sprite (`<IconSprite />`,
 * rendered by the root document). Each use is `<svg><use href="#icon-…"/></svg>`,
 * so a queue of hundreds of cards does not repeat each icon's path data.
 */

const GITHUB_MARK_PATH =
	"M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

const LUCIDE_SPRITE = [
	["alarm-clock-off", Lucide.AlarmClockOff],
	["alert-circle", Lucide.AlertCircle],
	["alert-triangle", Lucide.AlertTriangle],
	["arrow-down", Lucide.ArrowDown],
	["arrow-left", Lucide.ArrowLeft],
	["arrow-right", Lucide.ArrowRight],
	["arrow-up-right", Lucide.ArrowUpRight],
	["ban", Lucide.Ban],
	["bot", Lucide.Bot],
	["check", Lucide.Check],
	["check-circle", Lucide.CheckCircle],
	["check-circle-2", Lucide.CheckCircle2],
	["circle-dot", Lucide.CircleDot],
	["clipboard-list", Lucide.ClipboardList],
	["clock", Lucide.Clock],
	["cloud", Lucide.Cloud],
	["copy", Lucide.Copy],
	["diff", Lucide.Diff],
	["external-link", Lucide.ExternalLink],
	["eye", Lucide.Eye],
	["file-text", Lucide.FileText],
	["flask-conical", Lucide.FlaskConical],
	["git-branch", Lucide.GitBranch],
	["git-merge", Lucide.GitMerge],
	["hard-drive", Lucide.HardDrive],
	["info", Lucide.Info],
	["layout-grid", Lucide.LayoutGrid],
	["loader-2", Lucide.Loader2],
	["moon", Lucide.Moon],
	["octagon-alert", Lucide.OctagonAlert],
	["pencil", Lucide.Pencil],
	["play", Lucide.Play],
	["refresh-cw", Lucide.RefreshCw],
	["save", Lucide.Save],
	["search-x", Lucide.SearchX],
	["sun", Lucide.Sun],
	["trash-2", Lucide.Trash2],
	["wrench", Lucide.Wrench],
	["x", Lucide.X],
	["x-circle", Lucide.XCircle],
] as const;

type SpriteIconId = (typeof LUCIDE_SPRITE)[number][0] | "github";

const SPRITE_SYMBOLS: ReadonlyArray<{id: SpriteIconId; viewBox: string; content: ReactNode}> = [
	...LUCIDE_SPRITE.map(([id, Icon]) => ({
		id,
		viewBox: "0 0 24 24",
		content: <Icon />,
	})),
	{id: "github", viewBox: "0 0 16 16", content: <path fill="currentColor" d={GITHUB_MARK_PATH} />},
];

/** The one definition of every icon; render once per document. */
export function IconSprite() {
	return (
		<svg width="0" height="0" style={{position: "absolute", overflow: "hidden"}} aria-hidden="true">
			{SPRITE_SYMBOLS.map(({id, viewBox, content}) => (
				<symbol key={id} id={`icon-${id}`} viewBox={viewBox}>
					{content}
				</symbol>
			))}
		</svg>
	);
}

export interface IconProps {
	className?: string;
	"aria-hidden"?: boolean | "true" | "false";
}

function SpriteIcon({id, className}: IconProps & {id: SpriteIconId}) {
	return (
		<svg className={className} width="24" height="24" aria-hidden="true">
			<use href={`#icon-${id}`} />
		</svg>
	);
}

export function AlarmClockOff({className}: IconProps) {
	return <SpriteIcon id="alarm-clock-off" className={className} />;
}

export function AlertCircle({className}: IconProps) {
	return <SpriteIcon id="alert-circle" className={className} />;
}

export function AlertTriangle({className}: IconProps) {
	return <SpriteIcon id="alert-triangle" className={className} />;
}

export function ArrowDown({className}: IconProps) {
	return <SpriteIcon id="arrow-down" className={className} />;
}

export function ArrowLeft({className}: IconProps) {
	return <SpriteIcon id="arrow-left" className={className} />;
}

export function ArrowRight({className}: IconProps) {
	return <SpriteIcon id="arrow-right" className={className} />;
}

export function ArrowUpRight({className}: IconProps) {
	return <SpriteIcon id="arrow-up-right" className={className} />;
}

export function Ban({className}: IconProps) {
	return <SpriteIcon id="ban" className={className} />;
}

export function Bot({className}: IconProps) {
	return <SpriteIcon id="bot" className={className} />;
}

export function Check({className}: IconProps) {
	return <SpriteIcon id="check" className={className} />;
}

export function CheckCircle({className}: IconProps) {
	return <SpriteIcon id="check-circle" className={className} />;
}

export function CheckCircle2({className}: IconProps) {
	return <SpriteIcon id="check-circle-2" className={className} />;
}

export function CircleDot({className}: IconProps) {
	return <SpriteIcon id="circle-dot" className={className} />;
}

export function ClipboardList({className}: IconProps) {
	return <SpriteIcon id="clipboard-list" className={className} />;
}

export function Clock({className}: IconProps) {
	return <SpriteIcon id="clock" className={className} />;
}

export function Cloud({className}: IconProps) {
	return <SpriteIcon id="cloud" className={className} />;
}

export function Copy({className}: IconProps) {
	return <SpriteIcon id="copy" className={className} />;
}

export function Diff({className}: IconProps) {
	return <SpriteIcon id="diff" className={className} />;
}

export function ExternalLink({className}: IconProps) {
	return <SpriteIcon id="external-link" className={className} />;
}

export function Eye({className}: IconProps) {
	return <SpriteIcon id="eye" className={className} />;
}

export function FileText({className}: IconProps) {
	return <SpriteIcon id="file-text" className={className} />;
}

export function FlaskConical({className}: IconProps) {
	return <SpriteIcon id="flask-conical" className={className} />;
}

export function GitBranch({className}: IconProps) {
	return <SpriteIcon id="git-branch" className={className} />;
}

export function GitMerge({className}: IconProps) {
	return <SpriteIcon id="git-merge" className={className} />;
}

export function HardDrive({className}: IconProps) {
	return <SpriteIcon id="hard-drive" className={className} />;
}

export function Info({className}: IconProps) {
	return <SpriteIcon id="info" className={className} />;
}

export function LayoutGrid({className}: IconProps) {
	return <SpriteIcon id="layout-grid" className={className} />;
}

export function Loader2({className}: IconProps) {
	return <SpriteIcon id="loader-2" className={className} />;
}

export function Moon({className}: IconProps) {
	return <SpriteIcon id="moon" className={className} />;
}

export function OctagonAlert({className}: IconProps) {
	return <SpriteIcon id="octagon-alert" className={className} />;
}

export function Pencil({className}: IconProps) {
	return <SpriteIcon id="pencil" className={className} />;
}

export function Play({className}: IconProps) {
	return <SpriteIcon id="play" className={className} />;
}

export function RefreshCw({className}: IconProps) {
	return <SpriteIcon id="refresh-cw" className={className} />;
}

export function Save({className}: IconProps) {
	return <SpriteIcon id="save" className={className} />;
}

export function SearchX({className}: IconProps) {
	return <SpriteIcon id="search-x" className={className} />;
}

export function Sun({className}: IconProps) {
	return <SpriteIcon id="sun" className={className} />;
}

export function Trash2({className}: IconProps) {
	return <SpriteIcon id="trash-2" className={className} />;
}

export function Wrench({className}: IconProps) {
	return <SpriteIcon id="wrench" className={className} />;
}

export function X({className}: IconProps) {
	return <SpriteIcon id="x" className={className} />;
}

export function XCircle({className}: IconProps) {
	return <SpriteIcon id="x-circle" className={className} />;
}

export function GitHubIcon({className}: IconProps) {
	return <SpriteIcon id="github" className={className} />;
}
