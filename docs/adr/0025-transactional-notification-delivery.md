# Group Notifications by the Committed Action

Status: accepted. Inbox inserts enqueue a durable notification action in the
same database transaction, identified by Postgres's epoch-aware transaction
ID. The worker groups that action's recipients into one Delivery per Group
robot, so publishing a Round produces one post even though it creates many
inbox items. A small SQL trigger captures every producer, including MCP and
worker actions, without requiring each caller to remember an external channel.
The Activity log carries the same action ID to identify an item's requester.
Records predating this migration retain a null action ID: their original
requester cannot be recovered reliably, so only owners and Administrators
can remind those items. Current capabilities are rechecked when resolving
recipients and immediately before a queued post is sent; stale recipients
and completed items are removed, and an empty Delivery is cancelled.

The notification port accepts only a prepared metadata message. Channel
adapters perform network I/O after the action commits; their failures cannot
roll back sign-off. Deliveries retain their prepared recipients, message,
robot label, and authenticated encrypted webhook snapshot. Webhook-wide
database reservations pace every worker and workflow sharing a robot, while
expiring claims permit recovery after worker loss. WeCom has no idempotent
send primitive: an acknowledgement lost after a successful post can produce
a duplicate on retry, although ordinary action replay queues no second post.

Per-producer synchronous calls were rejected because they make channel
availability part of a gate and multiply a Round into individual posts.
Grouping by timestamps was rejected because simultaneous unrelated actions
would merge and one slow action could split. Reminder limits use the logical
waiting item across all its recipients and serialize with its Workflow
version's writers, preserving one reminder per item per hour.
