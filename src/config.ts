import "dotenv/config";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const port = Number(env("PORT", "3000"));
  return {
    port,
    /** Public HTTPS base URL of this server (ngrok/cloudflared in dev). Used for checkout + deep-link pages. */
    publicBaseUrl: env("PUBLIC_BASE_URL", `http://localhost:${port}`).replace(/\/$/, ""),
    dataFile: env("DATA_FILE", "data/db.json"),
    /** Escrow fee charged to the seller at release, in basis points (100 = 1%). */
    escrowFeeBps: Number(env("ESCROW_FEE_BPS", "100")),

    whatsapp: {
      /** "cloud" calls the Meta Graph API; "console" just logs outgoing messages (local dev / tests). */
      mode: env("WHATSAPP_MODE", "console") as "cloud" | "console",
      apiVersion: env("WHATSAPP_API_VERSION", "v21.0"),
      accessToken: env("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
      /** Your bot's phone number in international format without "+", used to build wa.me share links. */
      botNumber: env("WHATSAPP_BOT_NUMBER", "15550000000"),
      verifyToken: env("WHATSAPP_VERIFY_TOKEN", "settle-dev-verify"),
      /** Meta App Secret, used to verify X-Hub-Signature-256. Leave empty to skip verification in dev. */
      appSecret: env("WHATSAPP_APP_SECRET"),
      /** IDs of the two Flows in /flows (upload them in WhatsApp Manager). Empty = fall back to PIN-by-chat. */
      pinFlowId: env("WHATSAPP_PIN_FLOW_ID"),
      setPinFlowId: env("WHATSAPP_SET_PIN_FLOW_ID"),
      /** "draft" lets you send unpublished Flows to test numbers. */
      flowMode: env("WHATSAPP_FLOW_MODE", "draft") as "draft" | "published",
    },

    busha: {
      /** "mock" simulates Busha locally (with a fake checkout page); "live" calls the Busha API. */
      mode: env("BUSHA_MODE", "mock") as "mock" | "live",
      baseUrl: env("BUSHA_BASE_URL", "https://api.sandbox.busha.so"),
      secretKey: env("BUSHA_SECRET_KEY"),
      publicKey: env("BUSHA_PUBLIC_KEY"),
      webhookSecret: env("BUSHA_WEBHOOK_SECRET", "mock-webhook-secret"),
      /** Network used for USDT collection addresses (e.g. TRX, ETH, BSC, MATIC). */
      cryptoNetwork: env("BUSHA_CRYPTO_NETWORK", "TRX"),
    },

    anthropic: {
      /** When set, free-text messages are understood by Claude; otherwise the regex parser is used. */
      enabled: Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")),
      model: env("CLAUDE_MODEL", "claude-opus-5-5"),
    },
  };
}
