/**
 * Wallet deep links for USDT payers (Option 3).
 * WhatsApp only makes http(s) links tappable, so the bot sends an https link to
 * /pay/:ref/crypto, and that page holds the `ethereum:` (EIP-681) URIs that open
 * MetaMask / Trust Wallet with the amount and address pre-filled.
 */

interface TokenInfo {
  chainId: number;
  contract: string;
  decimals: number;
  label: string;
}

/** USDT contracts on EVM chains Busha supports. */
export const USDT_EVM: Record<string, TokenInfo> = {
  ETH: { chainId: 1, contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, label: "Ethereum (ERC-20)" },
  BSC: { chainId: 56, contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, label: "BNB Chain (BEP-20)" },
  MATIC: { chainId: 137, contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, label: "Polygon" },
};

export const NETWORK_LABELS: Record<string, string> = {
  TRX: "Tron (TRC-20)",
  ...Object.fromEntries(Object.entries(USDT_EVM).map(([k, v]) => [k, v.label])),
};

/** Converts "250.5" with 6 decimals -> "250500000" without floating point. */
export function toBaseUnits(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

/** EIP-681 token transfer URI, e.g. ethereum:0xdAC1…@1/transfer?address=0xabc&uint256=250000000 */
export function eip681UsdtUri(network: string, to: string, amount: string): string | null {
  const t = USDT_EVM[network.toUpperCase()];
  if (!t) return null;
  return `ethereum:${t.contract}@${t.chainId}/transfer?address=${to}&uint256=${toBaseUnits(amount, t.decimals)}`;
}

/** Trust Wallet universal link fallback (opens the app's send screen). */
export function trustWalletLink(network: string, to: string, amount: string): string | null {
  const assets: Record<string, string> = {
    TRX: "c195_tTR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    ETH: "c60_t0xdAC17F958D2ee523a2206206994597C13D831ec7",
    BSC: "c20000714_t0x55d398326f99059fF775485246999027B3197955",
    MATIC: "c966_t0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  };
  const asset = assets[network.toUpperCase()];
  if (!asset) return null;
  return `https://link.trustwallet.com/send?asset=${asset}&address=${to}&amount=${amount}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderCryptoPayPage(p: { ref: string; address: string; network: string; amount: string; description: string }): string {
  const eip = eip681UsdtUri(p.network, p.address, p.amount);
  const tw = trustWalletLink(p.network, p.address, p.amount);
  const net = NETWORK_LABELS[p.network.toUpperCase()] ?? p.network;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay ${esc(p.amount)} USDT</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#111;--muted:#666;--accent:#0a7c4a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#1a1d23;--fg:#eee;--muted:#9aa;--accent:#2ecc71}}
body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:420px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:16px;padding:20px;box-shadow:0 1px 3px #0002}
h1{font-size:28px;margin:4px 0}.muted{color:var(--muted);font-size:14px}
code{display:block;word-break:break-all;padding:12px;border-radius:10px;background:var(--bg);margin:8px 0;font-size:14px}
a.btn,button{display:block;width:100%;box-sizing:border-box;text-align:center;padding:14px;border-radius:12px;border:0;margin-top:10px;font-size:16px;font-weight:600;text-decoration:none;background:var(--accent);color:#fff;cursor:pointer}
a.alt{background:transparent;color:var(--accent);border:1.5px solid var(--accent)}
</style></head><body><main><div class="card">
<div class="muted">Settle · ${esc(p.ref)}</div>
<h1>${esc(p.amount)} USDT</h1>
<div class="muted">${esc(p.description)}</div>
<p class="muted" style="margin-top:16px">Send exactly this amount on <b>${esc(net)}</b> to:</p>
<code id="addr">${esc(p.address)}</code>
<button onclick="navigator.clipboard.writeText(document.getElementById('addr').textContent);this.textContent='Copied ✓'">Copy address</button>
${eip ? `<a class="btn alt" href="${esc(eip)}">Open MetaMask / wallet</a>` : ""}
${tw ? `<a class="btn alt" href="${esc(tw)}">Open Trust Wallet</a>` : ""}
<p class="muted" style="margin-top:16px">Sending on the wrong network can lose funds. You'll get a receipt in WhatsApp as soon as it lands.</p>
</div></main></body></html>`;
}
