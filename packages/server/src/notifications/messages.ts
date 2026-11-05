import type { NotificationEvent } from "./preferences.js";
import type { NotificationRecipient, RobotMessage } from "./port.js";

const EVENT_LABELS: Record<NotificationEvent, { en: string; zh: string }> = {
  "question-assigned": {
    en: "Questions waiting for answers",
    zh: "问题等待回答",
  },
  "answer-submitted": {
    en: "Answers waiting for resolution",
    zh: "回答等待处理",
  },
  "restatement-ready": {
    en: "Restatements waiting for acknowledgement",
    zh: "重述等待确认",
  },
  "question-reopened": {
    en: "Questions waiting for attention",
    zh: "问题等待处理",
  },
  "concern-raised": {
    en: "Concerns waiting for resolution",
    zh: "专家关切等待处理",
  },
  "evaluation-finished": { en: "Evaluation finished", zh: "评估已完成" },
  "job-submitted": { en: "Drafts waiting for acceptance", zh: "草稿等待验收" },
  "gate-ready": { en: "Approval waiting", zh: "等待审批" },
  "gate-invalidated": { en: "Stage approval superseded", zh: "阶段审批已失效" },
  "script-effect-review": {
    en: "Uploader script effect review pending",
    zh: "等待上传人审阅脚本影响",
  },
};

export type RecipientMention = "userid" | "mobile" | "name";

/** A post mentions by WeCom userid, else by mobile number, else names the person only. */
export function recipientMention(
  recipient: NotificationRecipient,
): RecipientMention {
  return recipient.wecomUserId !== null
    ? "userid"
    : recipient.mobile !== null
      ? "mobile"
      : "name";
}

/**
 * What a Delivery or reminder keeps about its recipients: how each was
 * mentioned, never the userid or mobile number the chat mentioned them by.
 */
export function recordedRecipients(
  recipients: NotificationRecipient[],
  mentions = true,
) {
  return recipients.map((recipient) => ({
    personId: recipient.personId,
    name: recipient.name,
    count: recipient.count,
    mention: mentions ? recipientMention(recipient) : ("name" as const),
  }));
}

function boundedMetadata(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) return `${result}…`;
    result += character;
  }
  return result;
}

export function notificationMessage(input: {
  workflowNames: string[];
  events: NotificationEvent[];
  recipients: NotificationRecipient[];
  href: string;
  language: "en" | "zh";
  reminder?: boolean;
}): RobotMessage {
  const { language, recipients } = input;
  const title = boundedMetadata(
    `${input.reminder ? (language === "zh" ? "提醒 · " : "Reminder · ") : ""}${input.workflowNames.join(", ")}`,
    384,
  );
  const waiting = boundedMetadata(
    [...new Set(input.events)]
      .map((event) => EVENT_LABELS[event][language])
      .join("; "),
    384,
  );
  const lines = [title, waiting];
  const footer = input.href;
  // WeCom permits 2048 UTF-8 bytes. Keep the link, all structured mentions,
  // and full recipients in the Delivery even when display names overflow.
  for (const [index, recipient] of recipients.entries()) {
    const line = `${recipient.name
      .replace(/[\r\n]/gu, " ")
      .replace(/</gu, "〈")
      .replace(/>/gu, "〉")
      .slice(0, 80)}: ${recipient.count}`;
    if (
      Buffer.byteLength(
        [...lines, line, `+${recipients.length - index}`, footer].join("\n"),
      ) > 2048
    ) {
      lines.push(`+${recipients.length - index}`);
      break;
    }
    lines.push(line);
  }
  return {
    msgtype: "text",
    text: {
      content: [...lines, footer].join("\n"),
      mentioned_list: [
        ...new Set(
          recipients.flatMap((person) =>
            recipientMention(person) === "userid" ? [person.wecomUserId!] : [],
          ),
        ),
      ],
      mentioned_mobile_list: [
        ...new Set(
          recipients.flatMap((person) =>
            recipientMention(person) === "mobile" ? [person.mobile!] : [],
          ),
        ),
      ],
    },
  };
}
