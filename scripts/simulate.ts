/**
 * Chat with Settle from your terminal, no Meta account needed.
 * Start the server (WHATSAPP_MODE=console BUSHA_MODE=mock) then: npm run simulate
 *
 * Messages you type are POSTed to /webhooks/whatsapp exactly like Meta would send them.
 * Commands:
 *   /as <phone> [name]   switch who you are (e.g. seller vs buyer)
 *   /tap <n|button-id>   tap a button from the last message (by number or id)
 *   /pin <digits> [confirm]  submit the last PIN Flow shown to you
 *   /paid                "complete" the last payment shown to you (fires a signed Busha webhook)
 *   /quit
 */
import { createInterface } from "node:readline/promises";
import { createHmac } from "node:crypto";
import { stdin, stdout } from "node:process";
import "dotenv/config";

const BASE = process.env.SIM_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "";

let me = { phone: "2348011111111", name: "Tunde" };
let cursor = 0;
let seq = 0;
interface ChatState {
  buttons: { id: string; title: string }[];
  flowToken?: string;
  paymentRef?: string;
}
/** Remembered per phone, so switching with /as keeps each user's last buttons/Flow/payment. */
const chats = new Map<string, ChatState>();
const st = (phone = me.phone) => chats.get(phone) ?? (chats.set(phone, { buttons: [] }), chats.get(phone)!);

async function postWebhook(message: Record<string, unknown>) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ wa_id: me.phone, profile: { name: me.name } }],
              messages: [{ id: `wamid.sim${Date.now()}${seq++}`, from: me.phone, timestamp: `${Math.floor(Date.now() / 1000)}`, ...message }],
            },
          },
        ],
      },
    ],
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (APP_SECRET) headers["x-hub-signature-256"] = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
  const res = await fetch(`${BASE}/webhooks/whatsapp`, { method: "POST", headers, body });
  if (!res.ok) console.log(`  ⚠️  webhook returned ${res.status}`);
}

async function showReplies() {
  await new Promise((r) => setTimeout(r, 400));
  const res = await fetch(`${BASE}/dev/outbox?since=${cursor}`);
  if (!res.ok) return console.log("  (no /dev/outbox: is the server running with WHATSAPP_MODE=console?)");
  const { next, messages } = (await res.json()) as { next: number; messages: any[] };
  cursor = next;
  for (const m of messages) {
    const mine = m.to === me.phone;
    console.log(`\n${mine ? "🤖 Settle → you" : `🤖 Settle → +${m.to}`}`);
    console.log(m.body.split("\n").map((l: string) => "   " + l).join("\n"));
    if (m.buttons?.length) {
      console.log("   " + m.buttons.map((b: any, i: number) => `[${i + 1}. ${b.title}]`).join(" "));
      st(m.to).buttons = m.buttons;
    }
    if (m.url) {
      console.log(`   [🔗 ${m.url}]`);
      const ref = m.url.match(/(PAYR_[a-f0-9]+)/)?.[1];
      if (ref) st(m.to).paymentRef = ref;
    }
    if (m.flow) {
      console.log(`   [📝 Flow "${m.flow.cta}" → screen ${m.flow.screen}]  type /pin 1234`);
      st(m.to).flowToken = m.flow.flowToken;
    }
  }
}

async function main() {
  // Skip history from before we connected
  const init = await fetch(`${BASE}/dev/outbox?since=0`).then((r) => r.json() as Promise<{ next: number }>).catch(() => null);
  if (!init) {
    console.error(`Cannot reach ${BASE}. Start the server first: npm run dev`);
    process.exit(1);
  }
  cursor = init.next;
  console.log(`💬 Settle simulator → ${BASE}\nYou are +${me.phone} (${me.name}). Type "help" to start, /as <phone> to switch user.\n`);

  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const prompt = () => stdout.write(`\n[${me.name ?? me.phone}] > `);
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!stdin.isTTY && line) console.log(line);
    if (!line) {
      prompt();
      continue;
    }
    const [cmd, ...args] = line.split(/\s+/);

    if (cmd === "/quit") break;
    if (cmd === "/as") {
      me = { phone: args[0].replace(/\D/g, ""), name: args.slice(1).join(" ") || args[0] };
      console.log(`  now chatting as +${me.phone}`);
      prompt();
      continue;
    }
    if (cmd === "/tap") {
      const b = /^\d$/.test(args[0]) ? st().buttons[Number(args[0]) - 1] : { id: args[0], title: args[0] };
      if (!b) {
        console.log("  no such button");
        prompt();
        continue;
      }
      await postWebhook({ type: "interactive", interactive: { type: "button_reply", button_reply: b } });
    } else if (cmd === "/pin") {
      if (!st().flowToken) {
        // Flows not configured: the bot asked for the PIN as a chat reply
        await postWebhook({ type: "text", text: { body: args[0] } });
        await showReplies();
        prompt();
        continue;
      }
      const response = { flow_token: st().flowToken, pin: args[0], pin_confirm: args[1] ?? args[0] };
      st().flowToken = undefined;
      await postWebhook({
        type: "interactive",
        interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: JSON.stringify(response) } },
      });
    } else if (cmd === "/paid") {
      if (!st().paymentRef) {
        console.log("  no payment details shown yet");
        prompt();
        continue;
      }
      const r = await fetch(`${BASE}/dev/simulate-payment/${st().paymentRef}`, { method: "POST", headers: { accept: "application/json" } });
      console.log(`  💳 Busha webhook fired (${r.ok ? "ok" : r.status})`);
    } else {
      await postWebhook({ type: "text", text: { body: line } });
    }
    await showReplies();
    prompt();
  }
  rl.close();
}

main();
