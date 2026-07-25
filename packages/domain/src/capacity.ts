export const CAPACITY_WARNING_THRESHOLD = 0.8;
export const CAPACITY_CRITICAL_THRESHOLD = 0.95;

export type CapacityWarning = 'warning_80_percent' | 'warning_95_percent';

export const capacityWarning = (ratio: number): CapacityWarning | null => {
  if (ratio >= CAPACITY_CRITICAL_THRESHOLD) return 'warning_95_percent';
  if (ratio >= CAPACITY_WARNING_THRESHOLD) return 'warning_80_percent';
  return null;
};
