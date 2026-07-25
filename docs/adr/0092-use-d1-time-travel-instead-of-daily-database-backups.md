# Use D1 Time Travel instead of daily database backups

The initial deployment does not export daily copies of Control D1 or Organization D1 databases to R2.

It relies on the Workers Paid D1 Time Travel window for recovery within thirty days and on the encrypted cold-history archives in ADR 0085 for completed Delivery Records and audit history older than twelve months. Google Drive remains the durable owner of published attachments.

This avoids duplicating entire databases into R2 and consuming additional storage and scheduled work. Recovery of external-delivery idempotency remains a separate concern and must not assume that an in-place database restore is safe by itself.
