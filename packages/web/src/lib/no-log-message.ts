export function noLogMessage(): string {
	return "No log is stored for this commit. Tests have not written one since the server started, or the log was cleared. Rerun the test to generate a log.";
}
