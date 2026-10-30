export interface NotificationRecipient {
  personId: string | null;
  name: string;
  count: number;
  wecomUserId: string | null;
  mobile: string | null;
}

export interface RobotMessage {
  msgtype: "text";
  text: {
    content: string;
    mentioned_list: string[];
    mentioned_mobile_list: string[];
  };
}

export type DeliveryResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      retryAfterMilliseconds?: number;
      rateLimited?: boolean;
    };

/** External channels implement this boundary; event producers never call a network. */
export interface NotificationChannel {
  post(webhookUrl: string, message: RobotMessage): Promise<DeliveryResult>;
}
