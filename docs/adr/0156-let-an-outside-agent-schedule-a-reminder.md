# Let an outside agent schedule a reminder

The MCP server of ADR 0152 offers both sending now and scheduling for later: `channel.send` delivers immediately, and a scheduled reminder records a Job to deliver at a stated time. Scheduling is the one that matters, because a reminder is about the future and an outside agent's session ends — a caller that can only send now can only notify now, and would have to stay awake until the moment it meant to remind someone.

Nothing new carries it. ADR 0073 already makes a durable Job row the source of truth for every asynchronous unit of work, and the attendance reminders already deliver on a schedule, so a reminder from outside is one Job with one delivery. It therefore does not wait for the release that adds agent Triggers.

A scheduled reminder is bounded exactly as an immediate send is: the Access Token's Tool Grant, its Contact List, and ADR 0141's Suppression Window, evaluated when the Job runs rather than when it was accepted.
