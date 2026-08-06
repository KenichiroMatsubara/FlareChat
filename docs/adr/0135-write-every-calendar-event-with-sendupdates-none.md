# Write every Calendar event with `sendUpdates=none`

Every Google Calendar write Mail Automation makes — the initial insert from ADR 0125, the additive invitation from ADR 0128's Event Refresh exit, the merge from ADR 0130, and the hand invitation behind the recipient-snapshot endpoint — now sends `sendUpdates=none`. Google never mails an invited Member on the automation's behalf. This supersedes ADR 0133's gate and the notifying half of ADR 0125 and ADR 0128; the roster is still written onto the event as attendees, since that is what a later Attendance Registration resolves against, only the mail Google would otherwise send on that write is suppressed.

ADR 0133 read `sendUpdates=all` as a second channel alongside a Member-facing LINE message, both gated on the same Significant Change judgement so a Member never received one without the other. With Calendar mail switched off entirely, that judgement has nothing left to gate on the Calendar side, so `isSignificantChange` and the field set it read are removed rather than kept as a check nothing calls. A LINE message remains a separate delivery, driven by an Agent Rule's own tool call rather than by a Calendar write, and is unaffected by this change.

A Member who wants to know about a Scheduled Event still finds it by opening Google Calendar, where the invitation and any later edit already appear as an attendee entry; only the unsolicited notification mail Google would send about it is gone.

## Consequences

An Organization that relied on Google's calendar mail to tell Members about a new or moved meeting must reach them through another channel, such as a permitted LINE Destination List, since Mail Automation itself sends none.

A human Admin who edits a Scheduled Event by hand through Google Calendar's own UI still controls Google's own "notify guests" prompt for that edit; this ADR governs only writes Mail Automation itself makes.
