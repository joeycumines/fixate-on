/** Session identity accepted by both installed SDK argument shapes. */
export function verifierSessionID(input: unknown): string {
  const value = input as {sessionID?: string; path?: {id?: string}};
  return value.sessionID ?? value.path?.id ?? '';
}

export function verifierSessionInfo(
  input: unknown,
  directory = process.cwd(),
): {id: string; location: {directory: string}} {
  return {id: verifierSessionID(input), location: {directory}};
}
