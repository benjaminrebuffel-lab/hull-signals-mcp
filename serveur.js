import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const BASE = "https://fapi.binance.com";
const TOKEN = process.env.MCP_TOKEN || "";
const DEFAULT = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"];

const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/USDTUSDT$/, "USDT");
const f = v => (v == null || !isFinite(v) ? "n/a" : Number(v.toPrecision(6)));

async function klines(sym, interval, limit, startTime) {
  let url = `${BASE}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${sym} ${interval} HTTP ${r.status}`);
  const now = Date.now();
  return (await r.json())
    .map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], ct: k[6] }))
    .filter(k => k.ct < now); // bougies clôturées uniquement
}

function wma(src, n) {
  const out = new Array(src.length).fill(null), den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) {
      const v = src[i - n + 1 + j];
      if (v == null) { ok = false; break; }
      s += v * (j + 1);
    }
    if (ok) out[i] = s / den;
  }
  return out;
}

function hma(close, n) {
  const half = wma(close, Math.floor(n / 2)), full = wma(close, n);
  const diff = close.map((_, i) => (half[i] != null && full[i] != null ? 2 * half[i] - full[i] : null));
  return wma(diff, Math.round(Math.sqrt(n)));
}

function atrWilder(bars, n = 14) {
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
  for (let i = n + 1; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

async function analyse(sym, pos) {
  const m5 = await klines(sym, "5m", 300);
  const d1 = (await klines(sym, "1d", 4)).slice(-2);
  const close = m5.map(b => b.c), i = close.length - 1;
  const h144 = hma(close, 144), h36 = hma(close, 36);

  const g144 = h144[i] > h144[i - 1], g144p = h144[i - 1] > h144[i - 2];
  const g36 = h36[i] > h36[i - 1], g36p = h36[i - 1] > h36[i - 2];
  const slope = ((h144[i] - h144[i - 20]) / h144[i - 20]) * 100;
  const flat = Math.abs(slope) < 0.02;
  const px = close[i], prev = close[i - 1];

  const levels = d1.flatMap(d => [d.h, d.c]);
  const blockLong = levels.some(L => L >= px && L <= px * 1.0009);
  const blockShort = levels.some(L => L <= px && L >= px * 0.9991);
  const brokeUp = levels.some(L => prev <= L && px > L);
  const brokeDn = levels.some(L => prev >= L && px < L);
  const near = levels.reduce((a, L) => (Math.abs(L - px) < Math.abs(a - px) ? L : a), levels[0]);
  const atr = atrWilder(m5.slice(-100));

  let sig = "aucun";
  if (!flat && g144 && g36 && !g36p && !blockLong) sig = "LONG";
  if (!flat && !g144 && !g36 && g36p && !blockShort) sig = "SHORT";

  const time = new Date(m5[i].t).toISOString().slice(11, 16);
  let out = `${sym} ${time}Z | px ${f(px)} | H144 ${g144 ? "verte" : "rouge"} pente ${slope.toFixed(3)}% plat ${flat ? "oui" : "non"}`
    + ` | H36 ${g36 ? "verte" : "rouge"} flip ${g36 !== g36p ? "oui" : "non"}`
    + ` | niv ${f(near)} (${(((near - px) / px) * 100).toFixed(3)}%) cassure ${brokeUp ? "haut" : brokeDn ? "bas" : "non"}`
    + ` | ATR ${f(atr)} | SIGNAL ${sig}`;

  if (pos) {
    const long = pos.side === "long", e = pos.entryPrice;
    const since = await klines(sym, "5m", 1500, new Date(pos.entryTime).getTime());
    const best = long ? Math.max(...since.map(b => b.h), px) : Math.min(...since.map(b => b.l), px);
    const fav = long ? (best - e) / e * 100 : (e - best) / e * 100;
    const trailOn = fav >= 1;
    let target = null;
    if (trailOn) target = long ? Math.max(best - atr, e) : Math.min(best + atr, e);
    else if (fav >= 0.5) target = e;
    let move = "non";
    if (target != null) {
      const cur = pos.currentStop;
      const gain = cur == null ? Infinity : long ? (target - cur) / px * 100 : (cur - target) / px * 100;
      const minGain = trailOn ? 0.25 : 0;
      if (gain > minGain) move = `oui -> ${f(target)}`;
    }
    const exit = long ? (!g36 && g36p) || (g144 !== g144p) : (g36 && !g36p) || (g144 !== g144p);
    out += `\n  POS ${pos.side} entrée ${f(e)} | meilleur ${f(best)} (+${fav.toFixed(2)}%)`
      + ` | BE ${fav >= 0.5 ? "oui" : "non"} | suiveur ${trailOn ? "actif" : "non"}`
      + ` | bouger stop ${move} | SORTIE ${exit ? "OUI" : "non"}`;
  }
  return out;
}

function buildServer() {
  const server = new McpServer({ name: "hull-signals", version: "1.0.0" });
  server.registerTool("hull_signals", {
    title: "Signaux Hull M5",
    description: "Hull 144/36 M5, pente, plat, niveaux J-1/J-2 (filtre 0,09 %), cassure, ATR14, signal LONG/SHORT, et pour chaque position : break-even, stop suiveur 1×ATR, sortie. Bougies clôturées uniquement.",
    inputSchema: {
      symbols: z.array(z.string()).optional(),
      positions: z.array(z.object({
        symbol: z.string(),
        side: z.enum(["long", "short"]),
        entryPrice: z.number(),
        entryTime: z.string(),
        currentStop: z.number().optional()
      })).optional()
    }
  }, async ({ symbols, positions }) => {
    const list = (symbols?.length ? symbols : DEFAULT).map(norm);
    const lines = await Promise.all(list.map(async s => {
      const p = positions?.find(x => norm(x.symbol) === s);
      try { return await analyse(s, p); } catch (e) { return `${s} ERREUR ${e.message}`; }
    }));
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });
  return server;
}

const app = express();
app.use(express.json());
app.post("/mcp", async (req, res) => {
  const auth = req.query.key || (req.headers.authorization || "").replace("Bearer ", "");
  if (TOKEN && auth !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", (_, res) => res.status(405).end());
app.get("/", (_, res) => res.send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("hull-signals up"));
