# Fairly share background capacity between Organizations

The deployment apportions its estimated background-processing capacity among active Organizations. Each Organization receives a protected share, while temporarily unused shares may be borrowed by Organizations with queued work.

An Organization that exhausts its current allocation has only its own background work paused. It must not starve another Organization or the deployment's protected interactive capacity. Allocation and borrowing decisions are recorded so an administrator can explain why work was delayed.
