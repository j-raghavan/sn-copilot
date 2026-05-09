// Shared HTTP error formatter for provider clients. The body-text
// read is best-effort — a thrown text() (rare, but observed on
// unparseable bodies) must not mask the original status code.

export const throwHttpError = async (
  provider: string,
  res: Response,
): Promise<never> => {
  const body = await res.text().catch(() => '');
  throw new Error(
    `${provider}: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
  );
};
