# Keep Jobs in D1 and use Queues as wake-up hints

Superseded by ADR 0081.

Every asynchronous unit of work is represented by a durable Job row in D1. Its state, next-attempt time, ownership, idempotency key, and terminal outcome remain authoritative regardless of Queue state.

A Queue message contains only the small identifier needed to wake an eligible Job. It is replaceable and may be delivered more than once or expire without changing the Job's truth. Scheduled recovery scans find due D1 Jobs and enqueue or execute them again, so the free Queue retention window cannot erase pending work.
