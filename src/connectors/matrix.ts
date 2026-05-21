import sdk from "matrix-js-sdk";
import { config } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";

const { createClient, RoomEvent, ClientEvent } = sdk;

export class MatrixConnector {
  private client: ReturnType<typeof createClient>;
  private ownUserId = "";

  constructor(private orchestrator: Orchestrator) {
    const { homeserver, user, accessToken, password } = config.matrix;

    if (accessToken) {
      this.client = createClient({
        baseUrl: homeserver!,
        userId: user!,
        accessToken,
      });
    } else {
      this.client = createClient({
        baseUrl: homeserver!,
      });
    }

    void password; // used in start() below if no access token
  }

  async start(): Promise<void> {
    const { accessToken, password, user } = config.matrix;

    if (!accessToken && password) {
      await this.client.login("m.login.password", {
        user: user!,
        password,
      });
    }

    await this.client.startClient({ initialSyncLimit: 10 });

    this.client.once(ClientEvent.Sync, (state) => {
      if (state === "PREPARED") {
        this.ownUserId = this.client.getUserId() ?? user ?? "";
        console.log(`[Matrix] Connected as ${this.ownUserId}`);
      }
    });

    this.client.on(
      RoomEvent.Timeline,
      (event, room, toStartOfTimeline) => {
        if (toStartOfTimeline) return;
        if (event.getType() !== "m.room.message") return;
        if (event.getSender() === this.ownUserId) return;

        const content = event.getContent() as {
          msgtype?: string;
          body?: string;
        };
        if (content.msgtype !== "m.text") return;

        const body = content.body ?? "";
        const roomId = room?.roomId ?? event.getRoomId() ?? "";
        const isDM = this.isDMRoom(roomId);
        const isMentioned = this.ownUserId
          ? body.includes(this.ownUserId) ||
            body.includes(
              this.ownUserId.replace(/@/, "").split(":")[0] ?? ""
            )
          : false;

        if (!isDM && !isMentioned) return;

        const sender = event.getSender() ?? "unknown";
        const threadId = (event.getContent() as Record<string, unknown>)[
          "m.relates_to"
        ] as { event_id?: string } | undefined;
        const threadEventId = threadId?.event_id;

        // Strip mention from message body
        const text = body
          .replace(new RegExp(this.ownUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "")
          .trim();

        this.orchestrator
          .handle({
            userId: sender,
            roomId,
            threadId: threadEventId,
            text: text || body,
          })
          .then((response) => {
            void this.sendMessage(roomId, response, event.getId());
          })
          .catch((err: unknown) => {
            console.error("[Matrix] Orchestrator error:", err);
          });
      }
    );
  }

  private isDMRoom(roomId: string): boolean {
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    return room.getInvitedAndJoinedMemberCount() === 2;
  }

  private async sendMessage(
    roomId: string,
    text: string,
    replyToEventId?: string
  ): Promise<void> {
    const content: Record<string, unknown> = {
      msgtype: "m.text",
      body: text,
    };

    if (replyToEventId) {
      content["m.relates_to"] = {
        "m.in_reply_to": { event_id: replyToEventId },
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.client.sendEvent(roomId, "m.room.message" as any, content);
  }
}
