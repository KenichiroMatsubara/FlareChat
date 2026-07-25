# Extract each message once

Each Source Message is analyzed exactly once using the AI Connection and Extraction Policy of the highest-priority matching Automation Rule, called the Primary Rule. Other matches contribute only Routing Policies, Run Schedules, and deliveries; the GUI exposes a total rule order and warns about potentially overlapping Selection Policies so extraction cannot vary by evaluation order.
