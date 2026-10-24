export type MockCall = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Route = { match: (url: string, method: string) => boolean; respond: (call: MockCall) => { status?: number; json?: unknown; text?: string; bytes?: Uint8Array } };

/** Minimal recorded fetch mock for provider contract tests (no network). */
export function createMockFetch() {
  const routes: Route[] = [];
  const calls: MockCall[] = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep string */
      }
    }
    const call = { url, method, headers, body };
    calls.push(call);
    const route = routes.find((r) => r.match(url, method));
    if (!route) return new Response(JSON.stringify({ error: `no mock for ${method} ${url}` }), { status: 599 });
    const r = route.respond(call);
    if (r.bytes) return new Response(r.bytes, { status: r.status ?? 200 });
    if (r.status === 204 || r.status === 304) return new Response(null, { status: r.status });
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch: fetchImpl,
    calls,
    on(method: string, pattern: string | RegExp, respond: Route['respond']) {
      routes.unshift({
        match: (url, m) => m === method.toUpperCase() && (typeof pattern === 'string' ? url.startsWith(pattern) : pattern.test(url)),
        respond,
      });
      return this;
    },
  };
}
