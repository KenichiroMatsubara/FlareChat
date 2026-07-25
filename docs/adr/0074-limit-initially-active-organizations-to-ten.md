# Limit initially active Organizations to ten

One deployment initially permits at most ten Organizations to have automation active concurrently. An additional Organization may be created and configured, but activation is rejected with an explicit capacity status until another Organization suspends automation or the deployment limit is raised.

The limit is provisional deployment configuration rather than a compiled constant, preallocated database-slot count, or infrastructure limit. Organization registration still provisions its own D1 database automatically. The value may be raised after observed Gmail polling, Worker CPU, D1, Queue, and R2 consumption demonstrates that the deployment remains practical near its cost target.
