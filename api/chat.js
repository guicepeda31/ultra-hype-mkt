const { createClient } = require('@supabase/supabase-js');

const DAILY_LIMIT = 30;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data?.output || []) {
    if (item?.type === 'message') {
      for (const content of item?.content || []) {
        if (content?.type === 'output_text' && content?.text) {
          parts.push(content.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';

  if (!supabaseUrl || !supabaseServiceRoleKey || !openaiApiKey) {
    return sendJson(res, 500, { error: 'Missing server environment variables' });
  }

  const token = getBearerToken(req);
  if (!token) {
    return sendJson(res, 401, { error: 'Authentication required', code: 'auth_required' });
  }

  const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData || !authData.user) {
    return sendJson(res, 401, { error: 'Invalid session', code: 'invalid_session' });
  }

  const user = authData.user;
  const today = new Date().toISOString().slice(0, 10);

  let requestsToday = 0;
  const { data: usageRow, error: usageError } = await admin
    .from('user_usage')
    .select('id, day_key, requests_today')
    .eq('id', user.id)
    .maybeSingle();

  if (usageError && usageError.code !== 'PGRST116') {
    return sendJson(res, 500, { error: 'Could not read usage' });
  }

  if (usageRow) {
    requestsToday = usageRow.day_key === today ? Number(usageRow.requests_today || 0) : 0;
  }

  if (requestsToday >= DAILY_LIMIT) {
    return sendJson(res, 429, {
      error: 'Daily limit reached',
      code: 'daily_limit_exceeded',
      limit: DAILY_LIMIT,
      requests_today: requestsToday
    });
  }

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const maxTokensRaw = Number(body.maxTokens || 2000);
  const maxOutputTokens = Number.isFinite(maxTokensRaw)
    ? Math.max(256, Math.min(4000, Math.floor(maxTokensRaw)))
    : 2000;

  if (!prompt) {
    return sendJson(res, 400, { error: 'Prompt is required' });
  }

  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt }
          ]
        }
      ]
    })
  });

  if (!openaiResponse.ok) {
    const errorText = await openaiResponse.text();
    return sendJson(res, openaiResponse.status, {
      error: 'OpenAI request failed',
      details: errorText.slice(0, 800)
    });
  }

  const data = await openaiResponse.json();
  const text = extractOutputText(data);

  if (!text) {
    return sendJson(res, 502, { error: 'Empty model response' });
  }

  requestsToday += 1;

  const { error: updateError } = await admin
    .from('user_usage')
    .upsert({
      id: user.id,
      email: user.email || null,
      day_key: today,
      requests_today: requestsToday,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

  if (updateError) {
    return sendJson(res, 500, { error: 'Could not update usage' });
  }

  return sendJson(res, 200, {
    text,
    requests_today: requestsToday,
    limit: DAILY_LIMIT
  });
};
