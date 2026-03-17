// api/chat.js — Ultra Hype | Defesa máxima em camadas v3.1
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN            || 'https://ultra-hype-mkt.vercel.app';
const SUPABASE_URL    = process.env.SUPABASE_URL              || '';
const SUPABASE_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_PROMPT      = 6000;
const MAX_TOKENS      = 2000;
const GEMINI_TIMEOUT  = 20_000;

const LIMITS = {
  ip:     [ {w:60_000,max:30}, {w:600_000,max:100} ], 
  user:   [ {w:60_000,max:40}, {w:86_400_000,max:300} ],
  global: [ {w:60_000,max:150} ],
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, no-cache, private');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (checkRL('ip', ip)) return res.status(429).json({ error: 'Muitas requisições. Tente em 1 minuto.' });

  const { prompt, maxTokens = 1500 } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Erro: API Key não configurada.' });

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT);

    const gres = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt.slice(0, MAX_PROMPT) }] }],
        generationConfig: { maxOutputTokens: Math.min(maxTokens, MAX_TOKENS), temperature: 0.7 }
      })
    }).finally(() => clearTimeout(timeout));

    const data = await gres.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'IA não retornou resposta' });

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno no processamento' });
  }
}
