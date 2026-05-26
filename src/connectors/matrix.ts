import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodeCrypto from "node:crypto";
import {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
} from "matrix-bot-sdk";
import { marked } from "marked";
import { config } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";

const _require = createRequire(import.meta.url);

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

// ─── Crypto utilities (ported from example-verify.js) ────────────────────────

function generateX25519KeyPair() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("x25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pubBytes = spki.slice(-32);
  const pubB64 = pubBytes.toString("base64");
  const pubB64NoPad = pubB64.replace(/=+$/, "");
  return { privateKey, pubBytes, pubB64, pubB64NoPad };
}

function computeX25519(
  ourPrivKey: nodeCrypto.KeyObject,
  theirPubBytes: Buffer,
): Buffer {
  const header = Buffer.from("302a300506032b656e032100", "hex");
  const theirSpki = Buffer.concat([header, theirPubBytes]);
  const theirPubKey = nodeCrypto.createPublicKey({
    key: theirSpki,
    format: "der",
    type: "spki",
  });
  return nodeCrypto.diffieHellman({
    privateKey: ourPrivKey,
    publicKey: theirPubKey,
  });
}

function canonicalJson(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj))
    return "[" + (obj as unknown[]).map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(obj as object)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalJson((obj as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function hkdfSha256(
  ikm: Buffer,
  salt: Buffer,
  info: string,
  length: number,
): Buffer {
  const prk = nodeCrypto.createHmac("sha256", salt).update(ikm).digest();
  const infoBuffer = Buffer.from(info, "utf8");
  const chunks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let i = 1;
  while (Buffer.concat(chunks).length < length) {
    const h = nodeCrypto.createHmac("sha256", prk);
    h.update(prev);
    h.update(infoBuffer);
    h.update(Buffer.from([i++]));
    prev = h.digest();
    chunks.push(prev);
  }
  return Buffer.concat(chunks).slice(0, length);
}

const SAS_EMOJI = [
  "🐶 Dog",
  "🐱 Cat",
  "🦁 Lion",
  "🐎 Horse",
  "🦄 Unicorn",
  "🐷 Pig",
  "🐘 Elephant",
  "🐰 Rabbit",
  "🐼 Panda",
  "🐓 Rooster",
  "🐧 Penguin",
  "🐢 Turtle",
  "🐟 Fish",
  "🐙 Octopus",
  "🦋 Butterfly",
  "🌷 Flower",
  "🌳 Tree",
  "🌵 Cactus",
  "🍄 Mushroom",
  "🌏 Globe",
  "🌙 Moon",
  "☁️ Cloud",
  "🔥 Fire",
  "🍌 Banana",
  "🍎 Apple",
  "🍓 Strawberry",
  "🌽 Corn",
  "🍕 Pizza",
  "🎂 Cake",
  "❤️ Heart",
  "😀 Smiley",
  "🤖 Robot",
  "🎩 Hat",
  "👓 Glasses",
  "🔧 Wrench",
  "🎅 Santa",
  "👍 Thumbs Up",
  "☂️ Umbrella",
  "⌛ Hourglass",
  "⏰ Clock",
  "🎁 Gift",
  "💡 Light Bulb",
  "📕 Book",
  "✏️ Pencil",
  "📎 Paperclip",
  "✂️ Scissors",
  "🔒 Lock",
  "🔑 Key",
  "🔨 Hammer",
  "📞 Telephone",
  "🏁 Flag",
  "🚂 Train",
  "🚲 Bicycle",
  "✈️ Airplane",
  "🚀 Rocket",
  "🏆 Trophy",
  "⚽ Ball",
  "🎸 Guitar",
  "🎺 Trumpet",
  "🔔 Bell",
  "⚓ Anchor",
  "🎧 Headphones",
  "📁 Folder",
  "📌 Pin",
];

function decodeSasEmoji(sasBytes: Buffer): string[] {
  const n =
    (BigInt(sasBytes[0]) << 34n) |
    (BigInt(sasBytes[1]) << 26n) |
    (BigInt(sasBytes[2]) << 18n) |
    (BigInt(sasBytes[3]) << 10n) |
    (BigInt(sasBytes[4]) << 2n) |
    (BigInt(sasBytes[5]) >> 6n);
  const emojis: string[] = [];
  for (let i = 5; i >= 0; i--) {
    emojis.unshift(SAS_EMOJI[Number((n >> BigInt(i * 6)) & 63n)]);
  }
  return emojis;
}

// ─── Constants ────────────────────────────────────────────────────────────────

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

// ─── Verification state ───────────────────────────────────────────────────────

interface VerifState {
  sender: string;
  fromDevice: string;
  ourKeys?: ReturnType<typeof generateX25519KeyPair>;
  sharedSecret?: Buffer;
}

// ─── MatrixConnector ──────────────────────────────────────────────────────────

export class MatrixConnector {
  private client!: MatrixClient;
  private ownUserId = "";
  private ownDeviceId = "";
  private resolvedToken = "";
  private activeBotThreads = new Set<string>();
  private dmRooms = new Set<string>();
  private greetedRooms = new Set<string>();
  private pendingVerif = new Map<string, VerifState>();
  private startupTs = Date.now();

  constructor(private orchestrator: Orchestrator) {}

  async start(): Promise<void> {
    // Set global.Olm before creating the client (needed for matrix-bot-sdk compat layer)
    try {
      (globalThis as unknown as { Olm: unknown }).Olm =
        _require("@matrix-org/olm");
    } catch {}

    const { homeserver, user, accessToken, password } = config.matrix;
    let token = accessToken;

    if (!token) {
      const saved = loadCredentials(config.dataDir);
      if (saved) {
        token = saved.accessToken;
        console.log(
          `[Matrix] Loaded saved credentials (device=${saved.deviceId})`,
        );
      } else if (password) {
        const res = await fetch(`${homeserver}/_matrix/client/v3/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "m.login.password",
            user: user!,
            password: password!,
          }),
        });
        if (!res.ok)
          throw new Error(`[Matrix] Login failed: ${await res.text()}`);
        const data = (await res.json()) as {
          access_token: string;
          device_id: string;
          user_id: string;
        };
        token = data.access_token;
        saveCredentials(config.dataDir, {
          accessToken: token,
          deviceId: data.device_id,
          userId: data.user_id,
        });
        console.log(
          `[Matrix] New device registered (device=${data.device_id})`,
        );
      } else {
        throw new Error("[Matrix] No access token or password configured");
      }
    }

    this.resolvedToken = token;
    mkdirSync(config.dataDir, { recursive: true });

    const storageProvider = new SimpleFsStorageProvider(
      `${config.dataDir}/bot-session.json`,
    );
    // 0 = StoreType.Sqlite, the only available store type in matrix-sdk-crypto-nodejs
    const cryptoProvider = new RustSdkCryptoStorageProvider(
      `${config.dataDir}/crypto`,
      0 as unknown as never,
    );

    this.client = new MatrixClient(
      homeserver!,
      token,
      storageProvider,
      cryptoProvider,
    );

    this.setupVerification();
    this.setupMessageHandlers();

    console.log("[Matrix] Starting client sync…");
    await this.client.start();

    const whoami = await this.client.getWhoAmI();
    this.ownUserId = whoami.user_id;
    this.ownDeviceId = whoami.device_id ?? "";
    console.log(
      `[Matrix] Connected as ${this.ownUserId} / ${this.ownDeviceId}`,
    );

    process.on("SIGINT", () => {
      this.client.stop();
      process.exit(0);
    });
  }

  // Intercept verification to-device events before the Rust engine processes them
  private setupVerification(): void {
    type SyncData = {
      to_device?: { events?: Array<Record<string, unknown>> };
      rooms?: Record<string, unknown>;
      device_lists?: Record<string, unknown>;
      device_one_time_keys_count?: Record<string, unknown>;
    };
    type PatchedClient = MatrixClient & {
      processSync?: (data: SyncData) => Promise<void>;
    };

    const pc = this.client as PatchedClient;
    const originalProcessSync = pc.processSync?.bind(this.client);
    if (!originalProcessSync) return;

    pc.processSync = async (syncData: SyncData) => {
      const allToDevice = syncData?.to_device?.events ?? [];
      const verifEvents = allToDevice.filter((e) =>
        (e.type as string)?.includes("verification"),
      );
      const nonVerifEvents = allToDevice.filter(
        (e) => !(e.type as string)?.includes("verification"),
      );

      for (const evt of verifEvents) {
        const txnPrefix = String(
          (evt.content as Record<string, unknown>)?.transaction_id ?? "",
        ).slice(0, 8);
        console.log(`← ${evt.type as string} [${txnPrefix}]`);
        try {
          await this.handleVerifEvent(evt);
        } catch (e) {
          console.error("[Matrix] Verif error:", (e as Error).message);
        }
      }

      const patched = JSON.parse(JSON.stringify(syncData)) as SyncData;
      patched.to_device = { events: nonVerifEvents };
      patched.rooms = patched.rooms ?? {};
      (patched.rooms as Record<string, unknown>).join =
        (patched.rooms as Record<string, unknown>).join ?? {};
      (patched.rooms as Record<string, unknown>).invite =
        (patched.rooms as Record<string, unknown>).invite ?? {};
      (patched.rooms as Record<string, unknown>).leave =
        (patched.rooms as Record<string, unknown>).leave ?? {};
      patched.device_lists = patched.device_lists ?? {};
      patched.device_one_time_keys_count =
        patched.device_one_time_keys_count ?? {};

      try {
        return await originalProcessSync(patched);
      } catch {
        return originalProcessSync(syncData);
      }
    };

    console.log("[Matrix] Device verification handler registered");
  }

  private async handleVerifEvent(evt: Record<string, unknown>): Promise<void> {
    const content = evt.content as Record<string, unknown>;
    const txId = content?.transaction_id as string;
    const sender = evt.sender as string;
    const fromDevice =
      this.pendingVerif.get(txId)?.fromDevice ??
      (content?.from_device as string | undefined) ??
      ((evt?.unsigned as Record<string, unknown>)?.device_id as
        | string
        | undefined) ??
      "";
    const whoami = await this.client.getWhoAmI();

    switch (evt.type as string) {
      case "m.key.verification.request": {
        if (!(content?.methods as string[] | undefined)?.includes("m.sas.v1"))
          return;
        this.pendingVerif.set(txId, { sender, fromDevice });
        await this.sendToDevice(
          "m.key.verification.ready",
          sender,
          fromDevice,
          {
            from_device: whoami.device_id,
            methods: ["m.sas.v1"],
            transaction_id: txId,
          },
        );
        break;
      }

      case "m.key.verification.start": {
        if (content?.method !== "m.sas.v1") return;
        const state = this.pendingVerif.get(txId) ?? { sender, fromDevice };
        const ourKeys = generateX25519KeyPair();
        const commitment = nodeCrypto
          .createHash("sha256")
          .update(ourKeys.pubB64NoPad + canonicalJson(content), "utf8")
          .digest("base64");
        state.ourKeys = ourKeys;
        this.pendingVerif.set(txId, state);
        await this.sendToDevice(
          "m.key.verification.accept",
          sender,
          fromDevice,
          {
            transaction_id: txId,
            method: "m.sas.v1",
            key_agreement_protocol: "curve25519-hkdf-sha256",
            hash: "sha256",
            message_authentication_code: "hkdf-hmac-sha256.v2",
            short_authentication_string: ["decimal", "emoji"],
            commitment,
          },
        );
        break;
      }

      case "m.key.verification.key": {
        const state = this.pendingVerif.get(txId);
        if (!state?.ourKeys) return;
        const theirPubB64 = content.key as string;
        const theirPubBytes = Buffer.from(theirPubB64, "base64");
        const theirPubNoPad = theirPubB64.replace(/=+$/, "");
        const sharedSecret = computeX25519(
          state.ourKeys.privateKey,
          theirPubBytes,
        );
        const sasInfo =
          "MATRIX_KEY_VERIFICATION_SAS" +
          `|${sender}|${fromDevice}|${theirPubNoPad}` +
          `|${whoami.user_id}|${whoami.device_id}|${state.ourKeys.pubB64NoPad}` +
          `|${txId}`;
        const sasBytes = hkdfSha256(sharedSecret, Buffer.alloc(32), sasInfo, 7);
        state.sharedSecret = sharedSecret;
        this.pendingVerif.set(txId, state);
        await this.sendToDevice("m.key.verification.key", sender, fromDevice, {
          transaction_id: txId,
          key: state.ourKeys.pubB64NoPad,
        });
        console.log("\n====== EMOJIS SAS ======");
        decodeSasEmoji(sasBytes).forEach((e) => console.log(`  ${e}`));
        console.log("========================");
        console.log(
          '\n👉 Confirme "Ils correspondent" dans Element pour continuer\n',
        );
        break;
      }

      case "m.key.verification.mac": {
        const state = this.pendingVerif.get(txId);
        if (!state?.sharedSecret) return;

        type KeysQueryResp = {
          device_keys?: {
            [userId: string]: {
              [deviceId: string]: { keys?: { [keyId: string]: string } };
            };
          };
        };

        const ownUserId = whoami.user_id as string;
        const ownDeviceId = (whoami.device_id ?? "") as string;

        // Verify their MAC
        const theirDeviceKeyId = `ed25519:${fromDevice}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const theirKeysResp = (await (this.client.doRequest as any)(
          "POST",
          "/_matrix/client/v3/keys/query",
          null,
          { device_keys: { [sender]: [fromDevice] } },
        )) as KeysQueryResp;
        const theirEd25519 =
          theirKeysResp?.device_keys?.[sender]?.[fromDevice]?.keys?.[
            theirDeviceKeyId
          ] ?? "";
        const theirEd25519NoPad = theirEd25519.replace(/=+$/, "");
        const theirBaseInfo = `${sender}|${fromDevice}|${ownUserId}|${ownDeviceId}|${txId}`;
        const verifyKey = hkdfSha256(
          state.sharedSecret,
          Buffer.alloc(32),
          `MATRIX_KEY_VERIFICATION_MAC|${theirBaseInfo}|${theirDeviceKeyId}`,
          32,
        );
        const mac = content.mac as Record<string, string>;
        const expectedMac = nodeCrypto
          .createHmac("sha256", verifyKey)
          .update(theirEd25519NoPad, "utf8")
          .digest("base64")
          .replace(/=+$/, "");
        console.log("✅ MAC match:", mac?.[theirDeviceKeyId] === expectedMac);

        // Send our MAC
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ourKeysResp = (await (this.client.doRequest as any)(
          "POST",
          "/_matrix/client/v3/keys/query",
          null,
          { device_keys: { [ownUserId]: [ownDeviceId] } },
        )) as KeysQueryResp;
        const keyId = `ed25519:${ownDeviceId}`;
        const ed25519key =
          ourKeysResp?.device_keys?.[ownUserId]?.[ownDeviceId]?.keys?.[keyId] ??
          "";
        const ed25519NoPad = ed25519key.replace(/=+$/, "");
        const baseInfo = `${ownUserId}|${ownDeviceId}|${sender}|${fromDevice}|${txId}`;
        const macKey = hkdfSha256(
          state.sharedSecret,
          Buffer.alloc(32),
          `MATRIX_KEY_VERIFICATION_MAC|${baseInfo}|${keyId}`,
          32,
        );
        const keyMac = nodeCrypto
          .createHmac("sha256", macKey)
          .update(ed25519NoPad, "utf8")
          .digest("base64")
          .replace(/=+$/, "");
        const keysKey = hkdfSha256(
          state.sharedSecret,
          Buffer.alloc(32),
          `MATRIX_KEY_VERIFICATION_MAC|${baseInfo}|KEY_IDS`,
          32,
        );
        const keysMac = nodeCrypto
          .createHmac("sha256", keysKey)
          .update(keyId, "utf8")
          .digest("base64")
          .replace(/=+$/, "");

        await this.sendToDevice("m.key.verification.mac", sender, fromDevice, {
          transaction_id: txId,
          mac: { [keyId]: keyMac },
          keys: keysMac,
        });
        await this.sendToDevice("m.key.verification.done", sender, fromDevice, {
          transaction_id: txId,
        });
        console.log("\n🎉 Vérification envoyée !");
        this.pendingVerif.delete(txId);
        break;
      }

      case "m.key.verification.cancel": {
        console.warn(`❌ Annulé : ${content?.reason} (${content?.code})`);
        this.pendingVerif.delete(txId);
        break;
      }
    }
  }

  private async sendToDevice(
    type: string,
    sender: string,
    deviceId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    const txnId = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const url = `${config.matrix.homeserver}/_matrix/client/v3/sendToDevice/${encodeURIComponent(type)}/${txnId}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.resolvedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: { [sender]: { [deviceId]: content } } }),
    });
    if (!resp.ok) {
      const json = (await resp.json().catch(() => ({}))) as unknown;
      console.error(`❌ ${type} error:`, JSON.stringify(json));
    } else {
      console.log(`→ ${type}`);
    }
  }

  private setupMessageHandlers(): void {
    this.client.on(
      "room.invite",
      async (roomId: string, inviteEvent: Record<string, unknown>) => {
        const isDirect =
          (inviteEvent as { content?: { is_direct?: boolean } }).content
            ?.is_direct === true;
        if (isDirect) this.dmRooms.add(roomId);
        console.log(
          `[Matrix] Invited to ${roomId} isDirect=${isDirect}, joining…`,
        );
        try {
          await this.client.joinRoom(roomId);
          console.log(`[Matrix] Joined ${roomId}`);
          if (isDirect && !this.greetedRooms.has(roomId)) {
            this.greetedRooms.add(roomId);
            await this.sendMessage(roomId, WELCOME_MESSAGE);
          }
        } catch (err) {
          console.error(
            `[Matrix] Failed to join or welcome in ${roomId}:`,
            err,
          );
        }
      },
    );

    this.client.on(
      "room.message",
      (roomId: string, event: Record<string, unknown>) => {
        void this.handleIncomingMessage(roomId, event);
      },
    );

    this.client.on(
      "room.failed_decryption",
      (roomId: string, event: Record<string, unknown>, error: Error) => {
        console.log(`[Matrix] Decryption failure in ${roomId}:`, error.message);
        const sender = event.sender as string;
        if (sender === this.ownUserId) return;
        const relates = (
          event.content as Record<string, unknown> | undefined
        )?.["m.relates_to"] as
          | { rel_type?: string; event_id?: string }
          | undefined;
        const threadRoot =
          relates?.rel_type === "m.thread"
            ? (relates.event_id ?? (event.event_id as string))
            : (event.event_id as string);
        void this.isDMRoom(roomId).then((isDM) => {
          const isActiveBotThread = this.activeBotThreads.has(threadRoot ?? "");
          if (isDM || isActiveBotThread) {
            void this.sendMessage(
              roomId,
              "_(Désolé, je n'ai pas pu déchiffrer votre message 🫣)_",
              event.event_id as string,
              isDM ? undefined : (threadRoot ?? undefined),
            );
          }
        });
      },
    );
  }

  private async handleIncomingMessage(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const sender = event.sender as string;
    if (sender === this.ownUserId) return;

    const eventTs = event.origin_server_ts as number | undefined;
    if (eventTs !== undefined && eventTs < this.startupTs) return;

    const content = event.content as {
      msgtype?: string;
      body?: string;
      formatted_body?: string;
    };
    if (content?.msgtype !== "m.text") return;

    const body = content.body ?? "";
    const formattedBody = content.formatted_body ?? "";
    const isDM = await this.isDMRoom(roomId);
    const localPart = this.ownUserId
      ? (this.ownUserId.replace(/@/, "").split(":")[0] ?? "")
      : "";
    const isMentioned = this.ownUserId
      ? formattedBody.includes(this.ownUserId) ||
        body.toLowerCase().includes(this.ownUserId.toLowerCase()) ||
        (localPart !== "" &&
          body.toLowerCase().includes(localPart.toLowerCase()))
      : false;

    const relates = (event.content as Record<string, unknown>)?.[
      "m.relates_to"
    ] as { rel_type?: string; event_id?: string } | undefined;
    const threadRoot =
      relates?.rel_type === "m.thread"
        ? (relates.event_id ?? (event.event_id as string))
        : (event.event_id as string);

    const isActiveBotThread = this.activeBotThreads.has(threadRoot ?? "");

    console.log(
      `[Matrix] Message from ${sender} in ${roomId} isDM=${isDM} isMentioned=${isMentioned} isActiveBotThread=${isActiveBotThread} body=${JSON.stringify(body.slice(0, 100))}`,
    );

    if (!isDM && !isMentioned && !isActiveBotThread) return;

    if (isMentioned && threadRoot) this.activeBotThreads.add(threadRoot);

    let text = body.replace(
      new RegExp(this.ownUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "",
    );
    text = text.trim();

    const userEventId = event.event_id as string;

    await this.sendReaction(roomId, userEventId, "🤖");

    this.orchestrator
      .handle({
        userId: sender,
        roomId,
        threadId: threadRoot,
        text: text || body,
      })
      .then(async (response) => {
        const base =
          response.trim() || "_(Désolé, je n'ai pas pu générer de réponse.)_";
        const replyText =
          base +
          "\n\n---\n*[Partager un retour](https://github.com/betagouv/betabot/issues/new)*";
        await this.sendMessage(
          roomId,
          replyText,
          userEventId,
          threadRoot,
        );
      })
      .catch(async (err: unknown) => {
        console.error("[Matrix] Orchestrator error:", err);
        await this.sendMessage(
          roomId,
          "_(Erreur interne, merci de réessayer.)_",
          userEventId,
          threadRoot,
        );
      });
  }

  private async sendReaction(
    roomId: string,
    targetEventId: string,
    emoji: string,
  ): Promise<string | null> {
    try {
      const eventId = await this.client.sendEvent(roomId, "m.reaction", {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: targetEventId,
          key: emoji,
        },
      });
      return eventId as string;
    } catch (err) {
      console.error("[Matrix] Failed to send reaction:", err);
      return null;
    }
  }

  private async isDMRoom(roomId: string): Promise<boolean> {
    if (this.dmRooms.has(roomId)) return true;
    try {
      const members = await this.client.getJoinedRoomMembers(roomId);
      if (Object.keys(members).length === 2) {
        this.dmRooms.add(roomId);
        return true;
      }
    } catch {}
    return false;
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

    await this.client.sendEvent(roomId, "m.room.message", content);
  }
}
