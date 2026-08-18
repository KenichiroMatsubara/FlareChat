# Open a Contact Page with a single-use link

A Contact Page is reached by a short-lived single-use link that is exchanged for a time-bounded session covering that Contact's own events, Tasks, and comments. ADR 0139 removed the login, so the link is the whole credential and its granularity is the authorization design.

A durable per-Contact link was rejected because links are forwarded, especially on LINE, and one forwarded durable link would be permanent access to everything about that person; reissuing it only produces another forwardable link. A link per Contact and Scheduled Event was rejected because the product owes a Contact a page listing its Tasks, and issuing a link for every Task and event would turn the Channel into notification noise. Single use is what survives forwarding: the message can be passed on, but the link inside it cannot be used twice.

A Channel Handle records whether it addresses one Contact alone or a shared group or room, which LINE and Discord both state rather than leave to inference. A Contact Page link is delivered only to a handle that addresses its Contact alone. A person reachable only through a shared handle therefore has no page and is administered by the Account, because a link sent into a group makes every member of that group act as that Contact — correct when the Contact is the group, a disclosure when it is not.
