import type { Queryable } from "../database/database.js";
import { toIsoString } from "../util.js";
import type { RecipientMention } from "./messages.js";
import type { RobotMessage } from "./port.js";

interface DeliveryRow {
  id: string;
  robot_label: string;
  recipients: { name: string; count: number; mention: RecipientMention }[];
  content: RobotMessage;
  status: string;
  attempts: number;
  error: string | null;
  created_at: Date | string;
  sent_at: Date | string | null;
}

/**
 * The newest 100 Deliveries. Each shows its recipients' names, counts, and
 * how the post mentioned them, and the posted text, but never the userids
 * or mobile numbers the post's mention lists carried.
 */
export async function readDeliveryLog(tx: Queryable, workflowId: string) {
  const rows = await tx.query<DeliveryRow>(
    `select id, robot_label, recipients, content, status, attempts, error, created_at, sent_at
    from notification_deliveries where workflow_id = $1 order by created_at desc, id desc limit 100`,
    [workflowId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    robotLabel: row.robot_label,
    recipients: row.recipients.map(({ name, count, mention }) => ({
      name,
      count,
      mention,
    })),
    content: {
      msgtype: row.content.msgtype,
      text: { content: row.content.text.content },
    },
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: toIsoString(row.created_at),
    sentAt: row.sent_at === null ? null : toIsoString(row.sent_at),
  }));
}
