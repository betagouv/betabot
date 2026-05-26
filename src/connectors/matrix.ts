import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sdk, { MatrixEvent, MatrixEventEvent } from "matrix-js-sdk";
import {
  CryptoEvent,
  VerifierEvent,
  VerificationPhase,
  VerificationRequestEvent,
  type Verifier,
  type ShowSasCallbacks,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { marked } from "marked";
import { config } from "../config.js";
import { dumpIDB, restoreIDB } from "../idb-persist.js";
import type { Orchestrator } from "../orchestrator.js";

interface SavedCredentials {
  accessToken: string;
  deviceId: string;
  userId: string;
}

function loadCredentials(dataDir: string): SavedCredentials | null {
  const path = `${dataDir}/credentials.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SavedCredentials;
  } catch {
    return null;
  }
}

function saveCredentials(dataDir: string, creds: SavedCredentials): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${dataDir}/credentials.json`, JSON.stringify(creds, null, 2));
}

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

export class MatrixConnector {
  private client!: ReturnType<typeof createClient>;
  private ownUserId = "";
  private synced = false;
  private activeBotThreads = new Set<string>();
  private dmRooms = new Set<string>();
  private greetedRooms = new Set<string>();

  constructor(private orchestrator: Orchestrator) {}

  async start(): Promise<void> {
    const {
      homeserver,
      user,
      accessToken,
      password,
      deviceId: configDeviceId,
    } = config.matrix;

    // Resolve credentials: saved file > env vars. deviceId is mandatory for Rust crypto.
    let creds = loadCredentials(config.dataDir);

    if (!creds) {
      if (accessToken) {
        const deviceId =
          configDeviceId ??
          (await this.fetchDeviceId(homeserver!, accessToken));
        if (!deviceId)
          throw new Error(
            "[Matrix] Cannot resolve device ID — set MATRIX_DEVICE_ID explicitly or check MATRIX_ACCESS_TOKEN",
          );
        creds = { accessToken, deviceId, userId: user! };
      } else {
        // Password login — response always includes a device_id
        const loginClient = createClient({ baseUrl: homeserver! });
        const loginRes = (await loginClient.login("m.login.password", {
          user: user!,
          password: password!,
          ...(configDeviceId ? { device_id: configDeviceId } : {}),
        })) as unknown as {
          access_token: string;
          device_id: string;
          user_id: string;
        };
        creds = {
          accessToken: loginRes.access_token,
          deviceId: loginRes.device_id,
          userId: loginRes.user_id,
        };
        console.log(
          `[Matrix] New device registered (device=${creds.deviceId})`,
        );
      }
      saveCredentials(config.dataDir, creds);
      console.log(`[Matrix] Credentials saved (device=${creds.deviceId})`);
    } else if (!creds.deviceId) {
      // Saved file exists but deviceId is empty — recover via whoami
      const deviceId = await this.fetchDeviceId(homeserver!, creds.accessToken);
      if (!deviceId)
        throw new Error(
          "[Matrix] Saved credentials have no deviceId — delete credentials.json and restart",
        );
      creds = { ...creds, deviceId };
      saveCredentials(config.dataDir, creds);
      console.log(
        `[Matrix] Device ID recovered and saved (device=${creds.deviceId})`,
      );
    } else {
      console.log(
        `[Matrix] Loaded saved credentials (device=${creds.deviceId})`,
      );
    }

    this.client = createClient({
      baseUrl: homeserver!,
      userId: creds.userId,
      accessToken: creds.accessToken,
      deviceId: creds.deviceId,
    });

    // IndexedDB polyfill required by matrix-sdk-crypto-wasm in Node.js
    const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    Object.assign(globalThis, { indexedDB: idb, IDBKeyRange });

    const cryptoStorePath = `${config.dataDir}/crypto-store.json`;
    await restoreIDB(idb, cryptoStorePath);

    await this.client.initRustCrypto();

    // First save after 10 s — gives the WASM time to upload one-time keys before we snapshot
    setTimeout(() => void dumpIDB(idb, cryptoStorePath), 10_000);
    // Then keep the snapshot current every 5 minutes
    const saveInterval = setInterval(
      () => void dumpIDB(idb, cryptoStorePath),
      5 * 60 * 1000,
    );
    const onExit = () => {
      clearInterval(saveInterval);
      void dumpIDB(idb, cryptoStorePath);
    };
    process.once("SIGINT", onExit);
    process.once("SIGTERM", onExit);

    this.setupVerification();
    this.client.setGlobalBlacklistUnverifiedDevices(false);
    this.client.setGlobalErrorOnUnknownDevices(false);

    console.log("[Matrix] Starting client sync…");
    await this.client.startClient({
      initialSyncLimit: 0,
      lazyLoadMembers: true,
    });

    this.client.on(RoomMemberEvent.Membership, (event, member) => {
      if (!this.synced) return;
      if (member.userId !== this.ownUserId) return;
      if (member.membership !== "invite") return;

      const roomId = member.roomId;
      const isDirect =
        (event.getContent() as Record<string, unknown>).is_direct === true;
      if (isDirect) this.dmRooms.add(roomId);
      console.log(
        `[Matrix] Invited to ${roomId} isDirect=${isDirect}, joining…`,
      );

      this.client
        .joinRoom(roomId)
        .then(() => {
          console.log(`[Matrix] Joined ${roomId}`);
          if (this.greetedRooms.has(roomId)) return;
          this.greetedRooms.add(roomId);
          return this.sendMessage(roomId, WELCOME_MESSAGE);
        })
        .catch((err: unknown) => {
          console.error(
            `[Matrix] Failed to join or welcome in ${roomId}:`,
            err,
          );
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

    this.client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (!this.synced) return;
      if (toStartOfTimeline) return;

      const roomId = room?.roomId ?? event.getRoomId() ?? "";

      // For encrypted events, handle after the SDK decrypts them
      if (event.getType() === "m.room.encrypted") {
        event.once(MatrixEventEvent.Decrypted, () => {
          this.handleIncomingMessage(event, roomId);
        });
        return;
      }

      this.handleIncomingMessage(event, roomId);
    });
  }

  private handleIncomingMessage(event: MatrixEvent, roomId: string): void {
    if (event.isDecryptionFailure()) {
      console.log(`[Matrix] Decryption failure in ${roomId}`);
      if (event.getSender() === this.ownUserId) return;
      const isDM = this.isDMRoom(roomId);
      const relation = event.getRelation();
      const threadRoot =
        relation?.rel_type === "m.thread"
          ? (relation.event_id ?? event.getId())
          : event.getId();
      const isActiveBotThread = this.activeBotThreads.has(threadRoot ?? "");
      if (isDM || isActiveBotThread) {
        void this.sendMessage(
          roomId,
          "_(Désolé, je n'ai pas pu déchiffrer votre message 🫣)_",
          event.getId(),
          isDM ? undefined : (threadRoot ?? undefined),
        );
      }
      return;
    }

    console.log(
      `[Matrix] Timeline event type=${event.getType()} sender=${event.getSender()}`,
    );
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
    const sender = event.getSender() ?? "unknown";
    const isDM = this.isDMRoom(roomId);
    const localPart = this.ownUserId
      ? (this.ownUserId.replace(/@/, "").split(":")[0] ?? "")
      : "";
    const isMentioned = this.ownUserId
      ? formattedBody.includes(this.ownUserId) ||
        body.toLowerCase().includes(this.ownUserId.toLowerCase()) ||
        (localPart !== "" &&
          body.toLowerCase().includes(localPart.toLowerCase()))
      : false;

    const relates = (event.getContent() as Record<string, unknown>)[
      "m.relates_to"
    ] as { rel_type?: string; event_id?: string } | undefined;
    const threadRoot =
      relates?.rel_type === "m.thread"
        ? (relates.event_id ?? event.getId())
        : event.getId();

    const isActiveBotThread = this.activeBotThreads.has(threadRoot ?? "");

    console.log(
      `[Matrix] Message from ${sender} in ${roomId} isDM=${isDM} isMentioned=${isMentioned} isActiveBotThread=${isActiveBotThread} ownUserId=${this.ownUserId || "(not set)"} body=${JSON.stringify(body.slice(0, 100))}`,
    );

    if (!isDM && !isMentioned && !isActiveBotThread) {
      console.log(
        "[Matrix] Ignoring: not a DM, not mentioned, and not in an active bot thread",
      );
      return;
    }

    if (isMentioned && threadRoot) {
      this.activeBotThreads.add(threadRoot);
    }

    const displayName = this.client.getUser(this.ownUserId)?.displayName ?? "";
    let text = body.replace(
      new RegExp(this.ownUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "",
    );
    if (displayName) {
      text = text.replace(
        new RegExp(
          displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*",
          "gi",
        ),
        "",
      );
    }
    text = text.trim();

    console.log(
      `[Matrix] Handling message from ${sender}, threadRoot=${threadRoot}, text=${JSON.stringify(text || body)}`,
    );

    this.orchestrator
      .handle({
        userId: sender,
        roomId,
        threadId: threadRoot,
        text: text || body,
      })
      .then((response) => {
        const replyText =
          response.trim() || "_(Désolé, je n'ai pas pu générer de réponse.)_";
        console.log(
          `[Matrix] Sending response (${replyText.length} chars) to ${roomId}`,
        );
        void this.sendMessage(
          roomId,
          replyText,
          event.getId(),
          isDM ? undefined : threadRoot,
        );
      })
      .catch((err: unknown) => {
        console.error("[Matrix] Orchestrator error:", err);
        void this.sendMessage(
          roomId,
          "_(Erreur interne, merci de réessayer.)_",
          event.getId(),
          isDM ? undefined : threadRoot,
        );
      });
  }

  private setupVerification(): void {
    this.client.on(CryptoEvent.VerificationRequestReceived, async (request) => {
      const otherUser = request.otherUserId;
      console.log(
        `[Matrix] Verification request from ${otherUser}, auto-accepting…`,
      );
      try {
        await request.accept();

        // Wait for the other side to send m.key.verification.start (sets request.verifier).
        // We don't call startVerification() ourselves to avoid both sides racing to send start.
        const verifier = await new Promise<Verifier>((resolve, reject) => {
          if (request.verifier) {
            resolve(request.verifier);
            return;
          }
          const onChange = () => {
            if (request.verifier) {
              request.off(VerificationRequestEvent.Change, onChange);
              resolve(request.verifier);
            } else if (request.phase === VerificationPhase.Cancelled) {
              request.off(VerificationRequestEvent.Change, onChange);
              reject(
                new Error(
                  `Cancelled: ${request.cancellationCode ?? "unknown"}`,
                ),
              );
            }
          };
          request.on(VerificationRequestEvent.Change, onChange);
        });

        let sasConfirmed = false;
        const confirmSas = async (sas: ShowSasCallbacks) => {
          if (sasConfirmed) return;
          sasConfirmed = true;
          const emojis =
            sas.sas.emoji?.map((e) => e[0]).join(" ") ?? "(no emojis)";
          console.log(
            `[Matrix] Auto-confirming SAS with ${otherUser}: ${emojis}`,
          );
          try {
            await sas.confirm();
            console.log(`[Matrix] SAS confirmed with ${otherUser}`);
          } catch (err) {
            console.error("[Matrix] SAS confirm() error:", err);
          }
        };

        // Event-based path
        verifier.on(VerifierEvent.ShowSas, confirmSas);

        // Polling fallback: Rust backend may compute SAS before the listener fires
        const pollTimer = setInterval(() => {
          const sas = verifier.getShowSasCallbacks();
          if (sas) void confirmSas(sas);
        }, 500);

        try {
          await verifier.verify();
          console.log(`[Matrix] Verification complete with ${otherUser}`);
        } finally {
          clearInterval(pollTimer);
        }
      } catch (err) {
        console.error("[Matrix] Verification error:", err);
      }
    });
    console.log("[Matrix] Device verification handler registered");
  }

  private async fetchDeviceId(
    homeserver: string,
    accessToken: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(
        `${homeserver}/_matrix/client/v3/account/whoami`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { device_id?: string };
      return data.device_id ?? null;
    } catch {
      return null;
    }
  }

  private isDMRoom(roomId: string): boolean {
    if (this.dmRooms.has(roomId)) return true;
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    return room.getInvitedAndJoinedMemberCount() === 2;
  }

  private async sendMessage(
    roomId: string,
    text: string,
    replyToEventId?: string,
    threadRootId?: string,
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
