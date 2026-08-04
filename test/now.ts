/**
 * The single instant every test runs at.
 *
 * Worker code reads the wall clock directly through `new Date()`, so a test
 * that asserts anything about a date — an upcoming Scheduled Event, an expiry,
 * a retention window — passes only until that date arrives in real life.
 * `test/clock.ts` freezes the clock here so those assertions state what the
 * code does rather than when the suite happened to run. Date fixtures are
 * written relative to this instant.
 *
 * This module registers nothing, so importing it never installs the clock.
 * That is what lets `test/clock.test.ts` detect a suite that lost its setup
 * file rather than quietly installing the clock for itself.
 */
export const TEST_NOW = '2026-08-01T00:00:00.000Z';
