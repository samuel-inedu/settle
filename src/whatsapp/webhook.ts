import { createHmac, timingSafeEqual } from "node:crypto";

/** Normalised inbound message: everything the agent needs, nothing it doesn't. */
export type Inbound =
  | { id: string; from: string; name?: string; type: "text"; text: string }
  | { id: string; from: string; name?: string; type: "button"; buttonId: string; title: string }
  | { id: string; from: string; name?: string; type: "flow_reply"; response: Record<string, unknown> }
  | { id: string; from: string; name?: string; type: "unsupported"; raw: string };

/** Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the App Secret). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseWhatsAppWebhook(body: any): Inbound[] {
  const out: Inbound[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value?.messages) continue; // statuses (sent/delivered/read) are ignored
      const names: Record<string, string> = {};
      for (const c of value.contacts ?? []) names[c.wa_id] = c.profile?.name;

      for (const m of value.messages) {
        const base = { id: m.id as string, from: m.from as string, name: names[m.from] };
        if (m.type === "text") {
          out.push({ ...base, type: "text", text: m.text?.body ?? "" });
        } else if (m.type === "interactive" && m.interactive?.type === "button_reply") {
          out.push({ ...base, type: "button", buttonId: m.interactive.button_reply.id, title: m.interactive.button_reply.title });
        } else if (m.type === "interactive" && m.interactive?.type === "list_reply") {
          out.push({ ...base, type: "button", buttonId: m.interactive.list_reply.id, title: m.interactive.list_reply.title });
        } else if (m.type === "interactive" && m.interactive?.type === "nfm_reply") {
          let response: Record<string, unknown> = {};
          try {
            response = JSON.parse(m.interactive.nfm_reply.response_json ?? "{}");
          } catch {
            /* ignore malformed */
          }
          out.push({ ...base, type: "flow_reply", response });
        } else if (m.type === "button") {
          // Quick-reply buttons on template messages
          out.push({ ...base, type: "button", buttonId: m.button?.payload ?? m.button?.text, title: m.button?.text });
        } else {
          out.push({ ...base, type: "unsupported", raw: m.type });
        }
      }
    }
  }
  return out;
}
