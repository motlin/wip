declare module "@tanstack/react-start/server-entry" {
  const handler: { fetch: (request: Request) => Promise<Response> };
  export function createServerEntry(opts: {
    fetch: (request: Request) => Promise<Response> | Response;
  }): unknown;
  export default handler;
}
