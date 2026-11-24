import type { Config } from "../config.js";

export interface ReplyButton {
  id: string;
  title: string; // max 20 chars
}

export interface FlowMessage {
  flowId: string;
  flowToken: string;
  cta: string; // max 20 chars
  body: string;
  screen: string;
  data: Record<string, string>;
  header?: string;
}

/** Everything the bot can send. Two implementations: Graph API and an in-memory recorder. */
export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
  sendButtons(to: string, body: string, buttons: ReplyButton[], footer?: string): Promise<void>;
  sendCtaUrl(to: string, body: string, displayText: string, url: string, footer?: string): Promise<void>;
  sendFlow(to: string, flow: FlowMessage): Promise<void>;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Builds raw Cloud API payloads. Exported so tests/docs can show the exact JSON. */
export const payloads = {
  text: (to: string, body: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: clip(body, 4096), preview_url: true },
  }),

  buttons: (to: string, body: string, buttons: ReplyButton[], footer?: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: clip(body, 1024) },
      ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: clip(b.title, 20) } })),
      },
    },
  }),

  /** Opens the URL in WhatsApp's in-app browser sheet: the user never leaves WhatsApp. */
  ctaUrl: (to: string, body: string, displayText: string, url: string, footer?: string) => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: clip(body, 1024) },
      ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
      action: { name: "cta_url", parameters: { display_text: clip(displayText, 20), url } },
    },
  }),

  flow: (to: string, f: FlowMessage, mode: "draft" | "published") => ({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      ...(f.header ? { header: { type: "text", text: clip(f.header, 60) } } : {}),
      body: { text: clip(f.body, 1024) },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: f.flowToken,
          flow_id: f.flowId,
          flow_cta: clip(f.cta, 20),
          flow_action: "navigate",
          flow_action_payload: { screen: f.screen, data: f.data },
          ...(mode === "draft" ? { mode: "draft" } : {}),
        },
      },
    },
  }),
};

export class CloudApiSender implements WhatsAppSender {
  constructor(private cfg: Config["whatsapp"]) {
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      throw new Error("WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required when WHATSAPP_MODE=cloud");
    }
  }

  private async post(payload: unknown) {
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      // 131047 = outside the 24h customer-service window (needs a template message).
      throw new Error(`WhatsApp API ${res.status}: ${text}`);
    }
  }

  sendText(to: string, body: string) {
    return this.post(payloads.text(to, body));
  }
  sendButtons(to: string, body: string, buttons: ReplyButton[], footer?: string) {
    return this.post(payloads.buttons(to, body, buttons, footer));
  }
  sendCtaUrl(to: string, body: string, displayText: string, url: string, footer?: string) {
    return this.post(payloads.ctaUrl(to, body, displayText, url, footer));
  }
  sendFlow(to: string, flow: FlowMessage) {
    return this.post(payloads.flow(to, flow, this.cfg.flowMode));
  }
}

export interface RecordedMessage {
  to: string;
  kind: "text" | "buttons" | "cta_url" | "flow";
  body: string;
  buttons?: ReplyButton[];
  url?: string;
  flow?: FlowMessage;
}

/** Logs to the console and keeps an outbox. Used for local dev without Meta credentials, and in tests. */
export class ConsoleSender implements WhatsAppSender {
  outbox: RecordedMessage[] = [];
  constructor(private log = true) {}

  private record(m: RecordedMessage) {
    this.outbox.push(m);
    if (!this.log) return;
    const extra =
      m.buttons?.map((b) => `[${b.title}]`).join(" ") ?? (m.url ? `[→ ${m.url}]` : m.flow ? `[Flow: ${m.flow.cta}]` : "");
    console.log(`\n📤 to ${m.to} (${m.kind})\n${m.body}\n${extra}`);
  }

  async sendText(to: string, body: string) {
    this.record({ to, kind: "text", body });
  }
  async sendButtons(to: string, body: string, buttons: ReplyButton[]) {
    this.record({ to, kind: "buttons", body, buttons });
  }
  async sendCtaUrl(to: string, body: string, _displayText: string, url: string) {
    this.record({ to, kind: "cta_url", body, url });
  }
  async sendFlow(to: string, flow: FlowMessage) {
    this.record({ to, kind: "flow", body: flow.body, flow });
  }

  lastTo(to: string): RecordedMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}
