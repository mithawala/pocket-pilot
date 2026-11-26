// Generated from types/*.ts — do not edit.
// Regenerate with: npm run generate:typescript
/**
 * Adds a duration to an ISO 8601 timestamp and returns the result in canonical
 * ISO 8601 form.
 */
export function addMillisecondsToTimestamp(timestamp, duration) {
    return new Date(Date.parse(timestamp) + duration).toISOString();
}
