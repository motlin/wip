/** Replaces the current page with `url` (no back-button entry); its own module so tests can stub it. */
export function redirectTo(url: string): void
{
	window.location.replace(url);
}
