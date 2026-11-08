/**
 * One `/changes` response's public generation authority. Both carriers are retained for compatibility with older
 * servers, but when both are present they must agree before any row, head, or completion marker is accepted.
 */
export const coherentLibraryGeneration = (
  response: Response,
  bodyGeneration: unknown,
): string | null | undefined => {
  const body = typeof bodyGeneration === 'string' && bodyGeneration.length ? bodyGeneration : null;
  const header = response.headers.get('x-den-generation');
  return body && header && body !== header ? undefined : (body ?? header);
};
