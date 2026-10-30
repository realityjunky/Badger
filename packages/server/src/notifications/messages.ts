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
  "job-submitted": { en: "Drafts waiting for acceptance", zh: "草稿等待验收" },
  "gate-ready": { en: "Approval waiting", zh: "等待审批" },
  "gate-invalidated": { en: "Stage approval superseded", zh: "阶段审批已失效" },
};

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
            person.wecomUserId === null ? [] : [person.wecomUserId],
          ),
        ),
      ],
      mentioned_mobile_list: [
        ...new Set(
          recipients.flatMap((person) =>
            person.wecomUserId !== null || person.mobile === null
              ? []
              : [person.mobile],
          ),
        ),
      ],
    },
  };
}
