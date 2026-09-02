/** The current time, written once (ADR 0169). */
export const now = (): string => new Date().toISOString();

export const expiresIn = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
