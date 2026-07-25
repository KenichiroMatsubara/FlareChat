# Warn when registration deadline is defaulted

Mail Automation extracts an explicit Registration Deadline from the Source Message when possible and otherwise uses the Automation Rule's relative default, such as three days before the event at 23:59 in its time zone. A defaulted deadline does not block the Scheduled Event, but creates an Automation Warning and sends an operator LINE notification so the assumption is visible and editable in the GUI.
