async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
}

export async function isAuthorized(
  request: Request,
  expectedToken: string | undefined
): Promise<boolean> {
  if (
    typeof expectedToken !== "string" ||
    expectedToken.length < 24 ||
    expectedToken.trim().length < 24 ||
    expectedToken !== expectedToken.trim()
  ) return false;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;

  const actual = await digest(header.slice(7));
  const expected = await digest(expectedToken);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}
