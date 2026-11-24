/**
 * Setup checker: `npm run doctor`
 * Verifies each stage of the README walkthrough against the real services, without sending any messages:
 *   - WhatsApp token + phone number ID (reads the number's profile)
 *   - Flow IDs (reads each Flow's status and validation errors)
 *   - PUBLIC_BASE_URL reaches this server (needs `npm run dev` running)
 *   - Busha credentials (reads balances)
 *   - Claude model access (reads the model record)
 * Exits 1 if anything is broken.
 */
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
let failures = 0;

const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const fail = (msg: string, hint?: string) => {
  failures++;
  console.log(`  ❌ ${msg}${hint ? `\n     → ${hint}` : ""}`);
};

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function checkWhatsApp() {
  console.log("\nWhatsApp");
  const w = cfg.whatsapp;
  if (w.mode !== "cloud") {
    ok(
      "WHATSAPP_MODE=console: messages are printed locally (Stage 1). Set cloud for real WhatsApp.",
    );
    return;
  }
  if (!w.accessToken || !w.phoneNumberId) {
    return fail(
      "WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is empty",
      "Copy both from the API Setup page of your Meta app.",
    );
  }
  const auth = { Authorization: `Bearer ${w.accessToken}` };
  const base = `https://graph.facebook.com/${w.apiVersion}`;
  try {
    const { status, body } = await getJson(
      `${base}/${w.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      auth,
    );
    if (status === 200) {
      ok(
        `Token works. Number: ${body.display_phone_number} (${body.verified_name ?? "no name"})`,
      );
      const digits = String(body.display_phone_number ?? "").replace(/\D/g, "");
      if (digits && digits !== w.botNumber) {
        warn(
          `WHATSAPP_BOT_NUMBER is ${w.botNumber} but the number is ${digits}. Invoice share links will point to the wrong chat.`,
        );
      }
    } else if (body?.error?.code === 190) {
      fail(
        "Access token expired or invalid",
        "Temporary tokens last about 24h. Make a permanent System User token for demo day.",
      );
    } else {
      fail(
        `Graph API returned ${status}: ${body?.error?.message ?? "unknown error"}`,
        "Check the phone number ID belongs to the same app as the token.",
      );
    }
  } catch (err) {
    fail(`Could not reach graph.facebook.com: ${(err as Error).message}`);
  }

  if (!w.appSecret)
    warn(
      "WHATSAPP_APP_SECRET is empty, so incoming webhooks are not signature-checked.",
    );
  else ok("App Secret set (webhook signatures will be verified).");

  for (const [label, id] of [
    ["PIN Flow", w.pinFlowId],
    ["Create-PIN Flow", w.setPinFlowId],
  ] as const) {
    if (!id) {
      warn(
        `${label} ID not set: the bot will ask for the PIN as a chat reply.`,
      );
      continue;
    }
    try {
      const { status, body } = await getJson(
        `${base}/${id}?fields=name,status,validation_errors`,
        auth,
      );
      if (status !== 200) {
        fail(
          `${label} (${id}) could not be read: ${body?.error?.message ?? status}`,
        );
        continue;
      }
      const errors: any[] = body.validation_errors ?? [];
      if (errors.length) {
        fail(
          `${label} "${body.name}" has ${errors.length} validation error(s): ${errors.map((e) => e.message ?? e.error).join("; ")}`,
        );
      } else {
        ok(
          `${label} "${body.name}" is ${body.status}${body.status === "DRAFT" && w.flowMode !== "draft" ? " (set WHATSAPP_FLOW_MODE=draft or publish it)" : ""}`,
        );
      }
    } catch (err) {
      fail(`${label}: ${(err as Error).message}`);
    }
  }
}

async function checkPublicUrl() {
  console.log("\nPublic URL");
  const url = cfg.publicBaseUrl;
  if (!url.startsWith("https://")) {
    if (cfg.whatsapp.mode === "cloud" || cfg.busha.mode === "live") {
      fail(
        `PUBLIC_BASE_URL is ${url}`,
        "Meta and Busha need HTTPS. Run `ngrok http 3000` and paste the https address.",
      );
    } else {
      ok(`PUBLIC_BASE_URL is ${url} (fine for local mock mode)`);
    }
    return;
  }
  try {
    const { status, body } = await getJson(`${url}/health`);
    if (status === 200 && body.ok)
      ok(
        `${url}/health reaches the server (whatsapp=${body.whatsapp}, payments=${body.payments})`,
      );
    else
      fail(
        `${url}/health returned ${status}`,
        "Is `npm run dev` running, and is the tunnel pointing at the same port?",
      );
  } catch (err) {
    fail(
      `${url} is unreachable: ${(err as Error).message}`,
      "Start the server and the tunnel, then rerun. Free ngrok URLs change on restart.",
    );
  }
}

async function checkBusha() {
  console.log("\nBusha");
  const b = cfg.busha;
  if (b.mode !== "live") {
    ok("BUSHA_MODE=mock: payments are simulated with a fake checkout page.");
    if (b.webhookSecret === "mock-webhook-secret")
      ok("Using the default mock webhook secret.");
    return;
  }
  if (!b.secretKey) return fail("BUSHA_SECRET_KEY is empty");
  if (!b.webhookSecret || b.webhookSecret === "mock-webhook-secret") {
    fail(
      "BUSHA_WEBHOOK_SECRET is not set",
      "Copy it from Settings → Developer Tools → Webhooks after registering your webhook.",
    );
  }
  try {
    const { status, body } = await getJson(`${b.baseUrl}/v1/balances`, {
      Authorization: `Bearer ${b.secretKey}`,
    });
    if (status === 200) {
      const list = (body.data ?? [])
        .map((x: any) => `${x.currency} ${x.available?.amount ?? "?"}`)
        .join(", ");
      ok(`Busha key works (${b.baseUrl}). Balances: ${list || "none"}`);
    } else if (status === 401) {
      fail(
        `Busha rejected the key (401): ${body?.error?.message ?? ""}`,
        "Docs disagree on the auth format. Check the key is for this environment (sandbox vs production); if it is, tell your dev the Bearer format was rejected.",
      );
    } else {
      fail(
        `Busha returned ${status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 200)}`,
      );
    }
  } catch (err) {
    fail(`Could not reach ${b.baseUrl}: ${(err as Error).message}`);
  }
}

async function checkClaude() {
  console.log("\nClaude (optional)");
  if (!cfg.anthropic.enabled) {
    ok("No ANTHROPIC_API_KEY: the rules parser handles messages.");
    return;
  }
  try {
    const model = await new Anthropic().models.retrieve(cfg.anthropic.model);
    ok(`Key works and ${model.id} is available.`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      fail("ANTHROPIC_API_KEY was rejected");
    else if (err instanceof Anthropic.NotFoundError)
      fail(`Model ${cfg.anthropic.model} not found`, "Check CLAUDE_MODEL.");
    else fail(`Claude check failed: ${(err as Error).message}`);
  }
}

console.log("🩺 Settle setup check");
await checkWhatsApp();
await checkPublicUrl();
await checkBusha();
await checkClaude();
console.log(failures ? `\n${failures} problem(s) found.` : "\nAll good.");
process.exit(failures ? 1 : 0);
