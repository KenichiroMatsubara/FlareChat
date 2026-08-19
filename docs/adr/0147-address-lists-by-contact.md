# Address lists by Contact

Calendar Recipient List and LINE Destination List both became named sets of Channel Handles once ADR 0139 dissolved Member Address and LINE Destination into one term. They merge into a Contact List, a named set of Contacts, and delivery resolves the handle from the Channel the Automation is sending on.

Naming handles instead would break on the first Contact who gains a Channel. Adding Discord to one person would mean editing every list that person appears on, so the moment the platform delivers on more than one Channel the rosters stop following the people they describe. Addressing a specific group or room is unaffected, because ADR 0139 already lets a Contact be a group, a room, or a channel.

A Contact holding more than one handle on the same Channel names one of them primary per Channel; a Channel with no primary is skipped for that Contact rather than guessed at. The Operations Destination List stays separate from Contact Lists, so that editing the roster cannot silently redirect the warnings that would report the mistake.
