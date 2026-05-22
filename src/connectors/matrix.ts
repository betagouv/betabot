import sdk from "matrix-js-sdk";
import { marked } from "marked";
import { config } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";

const { createClient, RoomEvent, RoomMemberEvent, ClientEvent } = sdk;

const WELCOME_MESSAGE = `Bonjour ! 👋 Je suis l'assistant de la communauté [beta.gouv.fr](https://beta.gouv.fr).

Je peux t'aider à :
- 👤 **Trouver un membre** de la communauté
- 🚀 **Chercher une startup** ou un produit
- 📁 **Explorer les dépôts** de code
- 📖 **Consulter la documentation** de l'incubateur
- 📅 **Vérifier l'agenda** de la communauté
- 🎥 **Retrouver des vidéos** et ressources
- 🏢 **Découvrir les incubateurs**

Pose-moi une question ou mentionne-moi dans un salon !`;

const ENCRYPTION_WARNING = `⚠️ Ce salon est chiffré et je ne supporte pas le chiffrement. Je ne pourrai pas lire vos messages ni y répondre correctement. Merci de m'inviter dans un salon non chiffré.`;

export class MatrixConnector {
  private client: ReturnType<typeof createClient>;
  private ownUserId = "";
  private synced = false;
  private activeBotThreads = new Set<string>();
  private dmRooms = new Set<string>();

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

    console.log("[Matrix] Starting client sync…");
    await this.client.startClient({ initialSyncLimit: 0, lazyLoadMembers: true });

    this.client.on(RoomMemberEvent.Membership, (event, member) => {
      if (!this.synced) return;
      if (member.userId !== this.ownUserId) return;
      if (member.membership !== "invite") return;

      const roomId = member.roomId;
      const isDirect =
        (event.getContent() as Record<string, unknown>).is_direct === true;
      if (isDirect) this.dmRooms.add(roomId);
      console.log(`[Matrix] Invited to ${roomId} isDirect=${isDirect}, joining…`);

      this.client
        .joinRoom(roomId)
        .then(() => {
          console.log(`[Matrix] Joined ${roomId}`);
          const msg = this.client.isRoomEncrypted(roomId)
            ? ENCRYPTION_WARNING
            : WELCOME_MESSAGE;
          return this.sendMessage(roomId, msg);
        })
        .catch((err: unknown) => {
          console.error(`[Matrix] Failed to join or welcome in ${roomId}:`, err);
        });
    });

    this.client.on(ClientEvent.Sync, (state) => {
      if (state === "PREPARED" && !this.ownUserId) {
        this.ownUserId = this.client.getUserId() ?? user ?? "";
        this.synced = true;
        console.log(`[Matrix] Connected as ${this.ownUserId}`);
      } else if (state !== "SYNCING") {
        console.log(`[Matrix] Sync state: ${state}`);
      }
    });

    this.client.on(
      RoomEvent.Timeline,
      (event, room, toStartOfTimeline) => {
        console.log(`[Matrix] Timeline event type=${event.getType()} sender=${event.getSender()} toStartOfTimeline=${toStartOfTimeline}`);
        if (toStartOfTimeline) return;
        if (event.getType() !== "m.room.message") return;
        if (event.getSender() === this.ownUserId) return;

        const content = event.getContent() as {
          msgtype?: string;
          body?: string;
          formatted_body?: string;
        };
        console.log(`[Matrix] Message content msgtype=${content.msgtype}`);
        if (content.msgtype !== "m.text") return;

        const body = content.body ?? "";
        const formattedBody = content.formatted_body ?? "";
        const roomId = room?.roomId ?? event.getRoomId() ?? "";
        const sender = event.getSender() ?? "unknown";
        const isDM = this.isDMRoom(roomId);
        const localPart = this.ownUserId
          ? (this.ownUserId.replace(/@/, "").split(":")[0] ?? "")
          : "";
        const isMentioned = this.ownUserId
          ? formattedBody.includes(this.ownUserId) ||
            body.toLowerCase().includes(this.ownUserId.toLowerCase()) ||
            (localPart !== "" && body.toLowerCase().includes(localPart.toLowerCase()))
          : false;

        const relates = (event.getContent() as Record<string, unknown>)[
          "m.relates_to"
        ] as { rel_type?: string; event_id?: string } | undefined;
        const threadRoot =
          relates?.rel_type === "m.thread"
            ? relates.event_id ?? event.getId()
            : event.getId();

        const isActiveBotThread = this.activeBotThreads.has(threadRoot ?? "");

        console.log(
          `[Matrix] Message from ${sender} in ${roomId} isDM=${isDM} isMentioned=${isMentioned} isActiveBotThread=${isActiveBotThread} ownUserId=${this.ownUserId || "(not set)"} body=${JSON.stringify(body.slice(0, 100))}`
        );

        if (!isDM && !isMentioned && !isActiveBotThread) {
          console.log("[Matrix] Ignoring: not a DM, not mentioned, and not in an active bot thread");
          return;
        }

        if (isMentioned && threadRoot) {
          this.activeBotThreads.add(threadRoot);
        }

        if (this.client.isRoomEncrypted(roomId)) {
          console.log(`[Matrix] Encrypted room ${roomId}, sending warning`);
          void this.sendMessage(roomId, ENCRYPTION_WARNING, event.getId(), threadRoot);
          return;
        }

        // Strip mention from message body (by Matrix user ID and display name)
        const displayName = this.client.getUser(this.ownUserId)?.displayName ?? "";
        let text = body.replace(
          new RegExp(this.ownUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
          ""
        );
        if (displayName) {
          text = text.replace(
            new RegExp(
              displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*",
              "gi"
            ),
            ""
          );
        }
        text = text.trim();

        console.log(`[Matrix] Handling message from ${sender}, threadRoot=${threadRoot}, text=${JSON.stringify(text || body)}`);

        this.orchestrator
          .handle({
            userId: sender,
            roomId,
            threadId: threadRoot,
            text: text || body,
          })
          .then((response) => {
            console.log(`[Matrix] Sending response (${response.length} chars) to ${roomId}`);
            // DMs don't use threads — send as plain reply
            void this.sendMessage(
              roomId,
              response,
              event.getId(),
              isDM ? undefined : threadRoot
            );
          })
          .catch((err: unknown) => {
            console.error("[Matrix] Orchestrator error:", err);
          });
      }
    );
  }

  private isDMRoom(roomId: string): boolean {
    return this.dmRooms.has(roomId);
  }

  private async sendMessage(
    roomId: string,
    text: string,
    replyToEventId?: string,
    threadRootId?: string
  ): Promise<void> {
    const content: Record<string, unknown> = {
      msgtype: "m.text",
      body: text,
      format: "org.matrix.custom.html",
      formatted_body: await marked(text),
    };

    if (threadRootId) {
      content["m.relates_to"] = {
        rel_type: "m.thread",
        event_id: threadRootId,
        "m.in_reply_to": { event_id: replyToEventId ?? threadRootId },
        is_falling_back: false,
      };
    } else if (replyToEventId) {
      content["m.relates_to"] = {
        "m.in_reply_to": { event_id: replyToEventId },
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.client.sendEvent(roomId, "m.room.message" as any, content);
  }
}
