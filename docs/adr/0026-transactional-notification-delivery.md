# Group Notifications by the Committed Action

Status: accepted. Inbox inserts enqueue a durable notification action in the
same database transaction. The action's identity is a random UUID: the
column default draws it for the transaction's first inbox or audit insert
and keeps it in the transaction-local setting `badger.notification_action`,
so every later insert in that transaction shares it and the next transaction
draws a new one. The worker groups that action's recipients into one
Delivery per Group robot, so publishing a Round produces one post even
though it creates many inbox items. A small SQL trigger captures every
producer, including MCP and worker actions, without requiring each caller to
remember an external channel. The Activity log carries the same action ID to
identify an item's requester. Records predating this migration retain a null
action ID: their original requester cannot be recovered reliably, so only
owners and Administrators can remind those items. Current capabilities are
rechecked when resolving recipients and immediately before a queued post is
sent; stale recipients and completed items are removed, and an empty
Delivery is cancelled.

The notification port accepts only a prepared metadata message. Channel
adapters perform network I/O after the action commits; their failures cannot
roll back sign-off. Deliveries retain their prepared recipients, message,
robot label, and authenticated encrypted webhook snapshot. Webhook-wide
database reservations pace every worker and workflow sharing a robot, while
expiring claims permit recovery after worker loss. A rate-limited response
pauses the robot for WeCom's one-minute window and draws on its own attempt
limit, not on the retries meant for failures. A worker whose settings cannot
decrypt or link a post records a failed attempt with the reason, so a
misconfigured worker shows in the log rather than staying silent, while a
correctly configured worker can still send the post. WeCom has no idempotent
send primitive: an acknowledgement lost after a successful post can produce
a duplicate on retry, although ordinary action replay queues no second post.

Per-producer synchronous calls were rejected because they make channel
availability part of a gate and multiply a Round into individual posts.
Grouping by timestamps was rejected because simultaneous unrelated actions
would merge and one slow action could split. The transaction ID was rejected
as the identity because it belongs to the cluster, not to the records: the
documented recovery restores a dump into a fresh cluster, whose counter
restarts while restored rows keep their old identities. A new action could
then reuse a restored, already processed identity and never be posted, and
the restored actors who shared it would become its requesters. Reminder
limits use the logical waiting item across all its recipients and serialize
with its Workflow version's writers, preserving one reminder per item per
hour.
