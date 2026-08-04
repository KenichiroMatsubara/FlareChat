/**
 * LINE destination IDs are routing credentials, not display data. API
 * responses expose only enough of the prefix to distinguish nearby entries.
 */
export const displayLineDestinationId = (value: string): string =>
  value.length > 5 ? `${value.slice(0, 5)}…` : value;
