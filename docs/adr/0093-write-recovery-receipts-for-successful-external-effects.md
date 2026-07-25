# Write Recovery Receipts for successful external effects

Every successful Calendar, Drive, Gmail-send, or LINE external effect produces a small immutable encrypted Recovery Receipt in private R2 in addition to its Organization D1 Delivery Record. The receipt contains the Organization, idempotency key, external resource or request identifier, effect type, destination fingerprint, and success timestamp, but not the full message body or attachment.

Recovery Receipts are retained for thirty-five days, exceeding the thirty-day D1 Time Travel window. After restoring an Organization D1 database, automation remains suspended while receipts newer than the restore point rebuild missing idempotency state and Delivery Records. Only then may pending Jobs be reconsidered.

Failure to persist a receipt after an external success is a partial success. Mail Automation records the uncertainty where possible, stops automatic retry of that effect, and raises an Operations warning rather than risking a duplicate.
