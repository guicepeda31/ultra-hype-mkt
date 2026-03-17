// ══════════════════════════════════════════════════════════════════════════════
//  api/chat.js — Ultra Hype  |  Defesa máxima em camadas v3.1 (Estável)
// ══════════════════════════════════════════════════════════════════════════════

// ── 1. Configurações ───────────────────────────────────────────────────────────
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN            || 'https://ultra-hype-mkt.vercel.app';
const SUPABASE_URL    = process.env.SUPABASE_URL              || '';
const SUPABASE_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_PROMPT      = 6000;
const MAX_TOKENS      = 2000;
const MAX_BODY        = 12_000;
const GEMINI_TIMEOUT  = 20_000;
const JWT_CACHE_MS    = 300_000; // 5 min

// ── 2. Rate limits — sliding window ──────────────────────────────────────────
// Ajustado para permitir mais requisições sem erro 429 imediato
const LIMITS = {
  ip:     [ {w:60_000,max:30}, {w:600_000,max:100}, {w:3_600_000,max:250} ],
  user:   [ {w:60_000,max:40}, {w:600_000,max:120}, {w:86_400_000,max:300} ],
  global: [ {w:60_000,max:150}, {w:3_600_000,max:1000} ],
};
const rlMaps = { ip: new Map(), user: new Map(), global: new Map() };

function checkRL(scope, key) {
  const now = Date.now();
  const lim = LIMITS[scope];
  const map = rlMaps[scope];
  const ts  = (map.get(key) || []).filter(t => now - t < Math.max(...lim.map(l=>l.w)));
  for (const {w,max} of lim) {
    if (ts.filter(t => now - t < w).length >= max) { map.set(key,ts); return true; }
  }
  ts.push(now); map.set(key,ts); return false;
}

setInterval(() => {
  const cutoff = Date.now() - 86_400_000;
  for (const map of Object.values(rlMaps))
    for (const [k,ts] of map) {
      const c = ts.filter(t=>t>cutoff);
      c.length ? map.set(k,c) : map.delete(k);
    }
}, 600_000);

// ── 3. Blacklist de bots ──────────────────────────────────────────────────────
const BOT_UA = [
  /bot|crawl|spider|scraper|curl|wget|python|java|go-http|libwww|jakarta|httpclient/i,
  /nmap|masscan|nikto|sqlmap|acunetix|burpsuite|havij|metasploit/i,
  /headless|phantomjs|selenium|puppeteer|playwright|cypress/i,
];

function isBot(ua) {
  if (!ua || ua.length < 10 || ua.length > 512) return true;
  return BOT_UA.some(p => p.test(ua));
}

function fingerprint(ip, ua) {
  let h = 0;
  const s = ip + '|' + (ua||'').slice(0,50);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31,h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ── 4. Detecção de abuso ──────────────────────────────────────────────────────
const ABUSE = [
  /ignore\s+(all\s+)?(previous|above|prior|system)?\s*instructions?/i,
  /system\s*prompt\s*:/i,
  /jailbreak|jail\s*break/i,
  /DAN\s*(mode)?|do\s+anything\s+now/i,
  /<script[\s\S]*?>/i,
  /\beval\s*\(|\bexec\s*\(|\bspawn\s*\(/i,
];

function hasAbuse(text) {
  return ABUSE.some(p => p.test(text));
}

// ── 5. Sanitização ────────────────────────────────────────────────────────────
function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text
    .slice(0, MAX_PROMPT)
    .replace(/[\u0000-\u001F\u007F-\u009F\uFEFF]/g, ' ')
    .replace(/<[^>]{0,500}>/g, '')
    .trim();
}

// ── 6. JWT cache + verificação Supabase ──────────────────────────────────────
const jwtCache = new Map();

async function verifyJWT(token) {
  if (!SUPABASE_URL || !SUPABASE_SECRET) return null;
  const cached = jwtCache.get(token);
  if (cached && Date.now() - cached.ts < JWT_CACHE_MS) return cached.uid;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization':`Bearer ${token}`, 'apikey': SUPABASE_SECRET }
    });
    if (!r.ok) return null;
    const u = await r.json();
    const uid = u?.id || null;
    if (uid) jwtCache.set(token, { uid, ts: Date.now() });
    return uid;
  } catch { return null; }
}

// ── 7. Handler principal ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  const reqId = Date.now().toString(36);

  // Headers de segurança obrigatórios
  res.setHeader('Access-Control-Allow-Origin',   ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods',  'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Authorization, X-Requested-With');
  res.setHeader('X-Content-Type-Options',        'nosniff');
  res.setHeader('Cache-Control',                 'no-store, no-cache, private');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Detecção de Bot
  const ua = req.headers['user-agent'] || '';
  if (isBot(ua)) return res.status(403).json({ error: 'Forbidden' });

  // IP e Rate Limits
  const rawIP = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const ip    = String(rawIP).split(',')[0].trim();
  const fp    = fingerprint(ip, ua);

  if (checkRL('global', 'singleton') || checkRL('ip', ip) || checkRL('ip', fp)) {
    return res.status(429).json({ error: 'Muitas requisições. Tente em 1 minuto.' });
  }

  // Auth
  const auth   = req.headers['authorization'] || '';
  const token  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const userId = token ? await verifyJWT(token) : null;

  if (userId && checkRL('user', userId)) {
    return res.status(429).json({ error: 'Limite de usuário excedido.' });
  }

  // Body e Prompt
  const { prompt, maxTokens = 1500 } = req.body || {};
  if (!prompt || hasAbuse(prompt)) return res.status(400).json({ error: 'Prompt inválido.' });

  const clean = sanitize(prompt);
  const apiKey = process.env.GEMINI_API_KEY;

  try {
    const ctrl    = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT);

    const gres = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{
            text: 'Você é um assistente de inteligência de marketing para o mercado brasileiro. Retorne APENAS JSON válido. Não use blocos de código markdown ou explicações externas.'
          }]},
          contents: [{ role: 'user', parts: [{ text: clean }] }],
          generationConfig: { maxOutputTokens: Math.min(maxTokens, MAX_TOKENS), temperature: 0.7 }
        })
      }
    ).finally(() => clearTimeout(timeout));

    const data = await gres.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) throw new Error('Falha no Gemini');

    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: 'Erro ao processar IA.' });
  }
}
