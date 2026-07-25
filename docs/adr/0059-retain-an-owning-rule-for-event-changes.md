# Retain an owning rule for event changes

A Scheduled Event retains the Primary Rule that created it as its Owning Rule. Related follow-up messages use that rule's extraction behavior even if current rule priority would select another rule; unrelated new Event Candidates in the same Gmail thread use current matching, and only an Operator may explicitly reassign ownership.
