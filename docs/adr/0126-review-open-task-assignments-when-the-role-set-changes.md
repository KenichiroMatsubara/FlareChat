# Review Open Task Assignments When the Role Set Changes

A change to an Organization's Operational Task Roles now opens a Task Reassignment Review, and an Admin may ask the AI for one proposed role per incomplete Task. Until now the role a Task carried was decided once, at extraction, by the role set that existed that day. An Organization that later split 幹事 into two roles, or renamed one so its description finally said what it means, was left with every earlier Task pointing at the old arrangement and no way forward but editing each Task by hand — which the GUI does not even offer.

The review is raised by the role set changing, not by a schedule or a button that is always live. A reassignment costs an AI request over every open Task, and asking for one when nothing has changed spends an Organization's quota to be told what it already knows. Tying the offer to the change also states, in the GUI, why the offer exists: the roles moved, so the Tasks routed by them deserve a second look.

What is recorded is a revision counter rather than the time of the last change. Two role edits and a review can land inside one millisecond, and comparing timestamps then reports a review as settled while a change made after it sits unreviewed. Counting the changes and remembering the count that was reviewed cannot lose that race.

Only incomplete Tasks are proposed. A completed Task is the record of work someone already did under the roles that existed then; moving it would rewrite that record to describe an assignment that never happened, and it notifies nobody because there is nothing left to do.

Nothing is written until an Admin accepts. The AI reads role display names and descriptions as meaning — the same seam extraction already uses — and that is a judgment an Organization must be able to overrule before its Members are told to do something new. The proposal therefore carries the current role, the proposed role, and the model's own reason, and the ones that would actually move are the ones offered pre-accepted. Accepting a proposal takes the assignee from the role's current holder rather than from the proposal, so the AI never names a person.

Accepting nothing still closes the review. An Admin who looked and decided the Tasks are fine has answered the question, and re-asking on the next page load would make the offer noise rather than a signal.

## Consequences

A review is one AI request over up to a hundred open Tasks, paid by the Organization each time an Admin asks. An Organization that edits several roles in a row will see the review stay open across all of them and can wait until the editing is done before spending the request.

Accepting a proposal for a Task whose new role, deadline, and title already belong to another Task of the same Source Message collides with the uniqueness the extraction relies on. That Task is reported as skipped and left where it was, rather than failing the Tasks accepted alongside it.

The proposals are not stored. Closing the page before accepting them discards the answer and the next review pays for a new request, which keeps a stale proposal from being applied against a role set that has moved on again.
