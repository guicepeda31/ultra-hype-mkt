export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Extract the prompt from Anthropic format
    const prompt = body.messages?.[0]?.content || '';
    const maxTokens = body.max_tokens || 2000;

    const geminiBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7
      },
      systemInstruction: {
        parts: [{ text: body.system || 'Return ONLY valid JSON when asked. No markdown, no code fences, no extra text.' }]
      }
    };

    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Convert Gemini response to Anthropic format so HTML needs no changes
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
