import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const DAILY_LIMIT = 30;
const COOLDOWN_MS = 4000;

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
}

function getRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getEnv() {
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL?.trim(),
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY?.trim(),
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim(),
    GEMINI_MODEL: process.env.GEMINI_MODEL?.trim() || 'gemini-1.5-flash',
    GROQ_API_KEY: process.env.GROQ_API_KEY?.trim(),
    GROK_API_KEY: process.env.GROK_API_KEY?.trim(),
    GROQ_MODEL: process.env.GROQ_MODEL?.trim() || 'llama-3.1-70b-versatile',
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN?.trim() || '*',
    VERCEL_ENV: process.env.VERCEL_ENV || 'unknown',
  };

  const groqLikeKey = env.GROQ_API_KEY || env.GROK_API_KEY;

  const missing = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.GEMINI_API_KEY && !groqLikeKey) {
    missing.push('GEMINI_API_KEY or GROQ_API_KEY/GROK_API_KEY');
  }

  return {
    env,
    groqLikeKey,
    missing,
    hasMissing: missing.length > 0,
    flags: {
      hasSupabaseUrl: !!env.SUPABASE_URL,
      hasSupabaseAnonKey: !!env.SUPABASE_ANON_KEY,
      hasSupabaseServiceRoleKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
      hasGeminiApiKey: !!env.GEMINI_API_KEY,
      hasGroqApiKey: !!env.GROQ_API_KEY,
      hasGrokApiKey: !!env.GROK_API_KEY,
    },
  };
}

function getCorsHeaders(req, allowedOrigin) {
  const reqOrigin = req.headers.origin || '';
  const allowOrigin =
    allowedOrigin === '*'
      ? '*'
      : reqOrigin === allowedOrigin
        ? allowedOrigin
        : allowedOrigin;

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureAuthenticatedUser(adminClient, accessToken) {
  if (!accessToken) {
    return { user: null, error: 'Missing bearer token' };
  }

  const { data, error } = await adminClient.auth.getUser(accessToken);

  if (error || !data?.user) {
    return { user: null, error: error?.message || 'Invalid token' };
  }

  return { user: data.user, error: null };
}

async function enforceCooldown(adminClient, userId) {
  const now = Date.now();

  const { data, error } = await adminClient
    .from('user_rate_limits')
    .select('user_id,last_request_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Cooldown lookup failed: ${error.message}`);
  }

  const last = data?.last_request_at ? new Date(data.last_request_at).getTime() : 0;
  const diff = now - last;

  if (last && diff < COOLDOWN_MS) {
    const retryAfterMs = COOLDOWN_MS - diff;
    return {
      allowed: false,
      retryAfterMs,
    };
  }

  const { error: upsertError } = await adminClient
    .from('user_rate_limits')
    .upsert(
      {
        user_id: userId,
        last_request_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: 'user_id' }
    );

  if (upsertError) {
    throw new Error(`Cooldown update failed: ${upsertError.message}`);
  }

  return { allowed: true, retryAfterMs: 0 };
}

async function enforceDailyLimit(adminClient, userId) {
  const day = todayISO();

  const { data, error } = await adminClient
    .from('user_usage')
    .select('user_id,day,request_count')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle();

  if (error) {
    throw new Error(`Usage lookup failed: ${error.message}`);
  }

  const currentCount = data?.request_count || 0;

  if (currentCount >= DAILY_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      used: currentCount,
      limit: DAILY_LIMIT,
    };
  }

  const nextCount = currentCount + 1;

  const { error: upsertError } = await adminClient
    .from('user_usage')
    .upsert(
      {
        user_id: userId,
        day,
        request_count: nextCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,day' }
    );

  if (upsertError) {
    throw new Error(`Usage update failed: ${upsertError.message}`);
  }

  return {
    allowed: true,
    remaining: Math.max(0, DAILY_LIMIT - nextCount),
    used: nextCount,
    limit: DAILY_LIMIT,
  };
}

async function callGroq({ apiKey, model, prompt, system }) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  });

  const raw = await r.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!r.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `Groq HTTP ${r.status}`
    );
  }

  const text = data?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error('Groq returned empty response');
  }

  return {
    provider: 'groq',
    text,
    raw: data,
  };
}

async function callGemini({ apiKey, model, prompt, system }) {
  const fullPrompt = system
    ? `${system}\n\nUser:\n${prompt}`
    : prompt;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: fullPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
      },
    }),
  });

  const raw = await r.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!r.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `Gemini HTTP ${r.status}`
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || '')
      .join('')
      .trim() || '';

  if (!text) {
    throw new Error('Gemini returned empty response');
  }

  return {
    provider: 'gemini',
    text,
    raw: data,
  };
}

async function generateWithFallback({ env, groqLikeKey, prompt, system, requestId }) {
  const errors = [];

  if (groqLikeKey) {
    try {
      const out = await callGroq({
        apiKey: groqLikeKey,
        model: env.GROQ_MODEL,
        prompt,
        system,
      });
      return out;
    } catch (err) {
      errors.push(`groq: ${err.message}`);
      console.error('[api/chat] provider groq failed', {
        requestId,
        message: err.message,
      });
    }
  }

  if (env.GEMINI_API_KEY) {
    try {
      const out = await callGemini({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        prompt,
        system,
      });
      return out;
    } catch (err) {
      errors.push(`gemini: ${err.message}`);
      console.error('[api/chat] provider gemini failed', {
        requestId,
        message: err.message,
      });
    }
  }

  throw new Error(
    errors.length
      ? `All providers failed: ${errors.join(' | ')}`
      : 'No AI provider configured'
  );
}

export default async function handler(req, res) {
  const requestId = getRequestId();
  const startedAt = Date.now();

  const runtime = getEnv();
  const corsHeaders = getCorsHeaders(req, runtime.env.ALLOWED_ORIGIN);

  if (req.method === 'OPTIONS') {
    return json(res, 204, {}, corsHeaders);
  }

  try {
    if (req.method !== 'POST') {
      return json(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        details: 'Use POST.',
        requestId,
      }, corsHeaders);
    }

    if (runtime.hasMissing) {
      console.error('[api/chat] missing envs', {
        requestId,
        missing: runtime.missing,
        flags: runtime.flags,
        vercelEnv: runtime.env.VERCEL_ENV,
      });

      return json(res, 500, {
        ok: false,
        error: 'server_misconfigured',
        details: `Missing server environment variables: ${runtime.missing.join(', ')}`,
        missing: runtime.missing,
        vercelEnv: runtime.env.VERCEL_ENV,
        requestId,
      }, corsHeaders);
    }

    const adminClient = createClient(
      runtime.env.SUPABASE_URL,
      runtime.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );

    const body = await readJsonBody(req);
    const prompt = String(body?.prompt || '').trim();
    const system = body?.system ? String(body.system) : '';
    const accessToken = getBearerToken(req);

    if (!prompt) {
      return json(res, 400, {
        ok: false,
        error: 'invalid_request',
        details: 'Field "prompt" is required.',
        requestId,
      }, corsHeaders);
    }

    const { user, error: authError } = await ensureAuthenticatedUser(adminClient, accessToken);

    if (authError || !user) {
      return json(res, 401, {
        ok: false,
        error: 'unauthorized',
        details: authError || 'Invalid auth token.',
        requestId,
      }, corsHeaders);
    }

    const cooldown = await enforceCooldown(adminClient, user.id);
    if (!cooldown.allowed) {
      return json(res, 429, {
        ok: false,
        error: 'cooldown_active',
        details: 'Please wait a few seconds before sending another request.',
        retryAfterMs: cooldown.retryAfterMs,
        requestId,
      }, corsHeaders);
    }

    const usage = await enforceDailyLimit(adminClient, user.id);
    if (!usage.allowed) {
      return json(res, 429, {
        ok: false,
        error: 'daily_limit_reached',
        details: `Daily limit of ${DAILY_LIMIT} requests reached.`,
        limit: usage.limit,
        used: usage.used,
        remaining: usage.remaining,
        requestId,
      }, corsHeaders);
    }

    const ai = await generateWithFallback({
      env: runtime.env,
      groqLikeKey: runtime.groqLikeKey,
      prompt,
      system,
      requestId,
    });

    const durationMs = Date.now() - startedAt;

    console.log('[api/chat] success', {
      requestId,
      userId: user.id,
      provider: ai.provider,
      durationMs,
      remaining: usage.remaining,
      vercelEnv: runtime.env.VERCEL_ENV,
    });

    return json(res, 200, {
      ok: true,
      text: ai.text,
      provider: ai.provider,
      limit: usage.limit,
      used: usage.used,
      remaining: usage.remaining,
      requestId,
    }, corsHeaders);
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    console.error('[api/chat] unhandled error', {
      requestId,
      durationMs,
      message: err?.message,
      stack: err?.stack,
      vercelEnv: runtime.env.VERCEL_ENV,
    });

    return json(res, 500, {
      ok: false,
      error: 'internal_error',
      details: err?.message || 'Unexpected server error',
      requestId,
    }, corsHeaders);
  }
}
