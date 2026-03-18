import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;
const grokApiKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;

if (!supabaseUrl) throw new Error('SUPABASE_URL não configurada');
if (!supabaseAnonKey) throw new Error('SUPABASE_ANON_KEY não configurada');
if (!supabaseServiceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada');

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

const DAILY_LIMIT = 30;
const MIN_INTERVAL_MS = 4000;

function getTodayKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function readJson(req) {
  if (typeof req.body === 'object' && req.body) return req.body;

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function getUserFromBearer(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });

  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

async function getUsage(userId, dayKey) {
  const { data, error } = await supabaseAdmin
    .from('user_usage')
    .select('*')
    .eq('user_id', userId)
    .eq('day_key', dayKey)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertUsage(userId, dayKey, count) {
  const { error } = await supabaseAdmin
    .from('user_usage')
    .upsert(
      {
        user_id: userId,
        day_key: dayKey,
        request_count: count,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,day_key' }
    );

  if (error) throw error;
}

async function getRateLimit(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_rate_limits')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function touchRateLimit(userId) {
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('user_rate_limits')
    .upsert(
      {
        user_id: userId,
        last_request_at: now,
        updated_at: now
      },
      { onConflict: 'user_id' }
    );

  if (error) throw error;
}

async function callGemini(prompt) {
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY ausente');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') ||
    'Sem resposta.'
  );
}

async function callGrok(prompt) {
  if (!grokApiKey) throw new Error('GROK/GROQ API key ausente');

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grokApiKey}`
    },
    body: JSON.stringify({
      model: 'grok-2-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Grok error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || 'Sem resposta.';
}

async function generateText(prompt) {
  try {
    return await callGrok(prompt);
  } catch (e) {
    console.error('Grok falhou, fallback Gemini:', e.message);
    return await callGemini(prompt);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getUserFromBearer(req);

    if (!user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const body = await readJson(req);
    const prompt = body?.prompt?.trim();

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt obrigatório' });
    }

    const rate = await getRateLimit(user.id);

    if (rate?.last_request_at) {
      const elapsed = Date.now() - new Date(rate.last_request_at).getTime();

      if (elapsed < MIN_INTERVAL_MS) {
        const retryAfterMs = MIN_INTERVAL_MS - elapsed;
        return res.status(429).json({
          error: 'Aguarde alguns segundos antes de enviar outra solicitação.',
          retry_after_ms: retryAfterMs
        });
      }
    }

    const dayKey = getTodayKey();
    const usage = await getUsage(user.id, dayKey);
    const currentCount = usage?.request_count || 0;

    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({
        error: 'Limite diário atingido.',
        remaining: 0,
        limit: DAILY_LIMIT
      });
    }

    await touchRateLimit(user.id);

    const text = await generateText(prompt);

    await upsertUsage(user.id, dayKey, currentCount + 1);

    return res.status(200).json({
      text,
      remaining: DAILY_LIMIT - (currentCount + 1),
      limit: DAILY_LIMIT
    });
  } catch (error) {
    console.error('API /chat error:', error);
    return res.status(500).json({
      error: 'Erro interno',
      details: error.message
    });
  }
}
