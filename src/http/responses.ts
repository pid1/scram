export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Constant-time bearer check.
 *
 * `===` on secrets leaks length and prefix through timing. The comparison is
 * cheap enough that doing it properly costs nothing.
 */
export function authorised(req: Request, adminToken: string): boolean {
  if (!adminToken) return false;
  const header = req.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(adminToken);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
