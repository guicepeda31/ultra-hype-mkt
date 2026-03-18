const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_MODEL = process.env.XAI_MODEL || "grok-4";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const MAX_PROMPT_CHARS = 12000;

function send(res, data, status = 200) {
  return res.status(status).json(data);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncateText(text, max = MAX_PROMPT_CHARS) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function cleanJsonText(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function safeParseJson(text) {
  return JSON.parse(cleanJsonText(text));
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidPlan(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!isNonEmptyString(obj.titulo)) return false;
  if (typeof obj.descricao !== "string") return false;
  if (!Array.isArray(obj.etapas)) return false;

  for (const etapa of obj.etapas) {
    if (!etapa || typeof etapa !== "object") return false;
    if (!isNonEmptyString(etapa.nome)) return false;
    if (!Array.isArray(etapa.acoes)) return false;
    if (!etapa.acoes.every((a) => typeof a === "string")) return false;
  }

  return true;
}

function isValidCalendar(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!isNonEmptyString(obj.titulo)) return false;
  if (!Array.isArray(obj.itens)) return false;

  for (const item of obj.itens) {
    if (!item || typeof item !== "object") return false;
    if (!isNonEmptyString(item.data)) return false;
    if (!isNonEmptyString(item.tema)) return false;
    if (!isNonEmptyString(item.formato)) return false;
    if (!isNonEmptyString(item.canal)) return false;
    if (!isNonEmptyString(item.objetivo)) return false;
    if (typeof item.cta !== "string") return false;
  }

  return true;
}

function buildPlanPrompt(userInput) {
  return `
Você é um estrategista sênior de marketing e conteúdo.

Sua tarefa é criar um planejamento claro, objetivo, acionável e útil para um produto SaaS.

Regras:
- Responda em português do Brasil.
- Seja específico e direto.
- Não escreva nada fora do JSON.
- Evite floreios.
- Se faltar contexto, faça a melhor inferência possível sem inventar dados absurdos.
- Organize as ações em etapas lógicas.
- As ações devem ser práticas e executáveis.

Entrada do usuário:
"""${userInput}"""

Formato desejado:
{
  "titulo": "string",
  "descricao": "string",
  "etapas": [
    {
      "nome": "string",
      "acoes": ["string"]
    }
  ]
}
`.trim();
}

function buildCalendarPrompt(plan, extraContext = "") {
  return `
Você é um estrategista de conteúdo e social media.

Crie um calendário editorial claro e prático com base no planejamento abaixo.

Planejamento:
${JSON.stringify(plan, null, 2)}

Contexto adicional:
"""${extraContext || "Nenhum contexto adicional informado."}"""

Regras:
- Responda em português do Brasil.
- Não escreva nada fora do JSON.
- Crie ideias realistas e coerentes com o planejamento.
- Misture formatos quando fizer sentido.
- Distribua os conteúdos de forma organizada.
- Você pode sugerir datas em sequência, mesmo sem mês exato informado.

Formato desejado:
{
  "titulo": "string",
  "itens": [
    {
      "data": "string",
      "tema": "string",
      "formato": "string",
      "canal": "string",
      "objetivo": "string",
      "cta": "string"
    }
  ]
}
`.trim();
}

// =========================
// xAI / GROK
// =========================

async function xaiChat(messages, temperature = 0.2, maxTokens = 2200) {
  if (!XAI_API_KEY) {
    throw new Error("XAI_API_KEY não configurada.");
  }

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      stream: false,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 429) {
    const err = new Error(data?.error?.message || "Rate limited");
    err.status = 429;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || "Erro na xAI");
    err.status = response.status || 500;
    throw err;
  }

  return data?.choices?.[0]?.message?.content || "";
}

async function xaiGeneratePlan(prompt) {
  const content = await xaiChat(
    [
      {
        role: "system",
        content: "Você responde apenas em JSON válido.",
      },
      {
        role: "user",
        content: buildPlanPrompt(prompt),
      },
    ],
    0.2,
    2200
  );

  return safeParseJson(content);
}

async function xaiGenerateCalendar(plan, extraContext) {
  const content = await xaiChat(
    [
      {
        role: "system",
        content: "Você responde apenas em JSON válido.",
      },
      {
        role: "user",
        content: buildCalendarPrompt(plan, extraContext),
      },
    ],
    0.2,
    2600
  );

  return safeParseJson(content);
}

async function xaiGenerateText(prompt, maxTokens = 2000) {
  return xaiChat(
    [
      {
        role: "system",
        content: "Responda em texto claro, legível e objetivo. Não use markdown complexo.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    0.3,
    maxTokens
  );
}

// =========================
// GEMINI
// =========================

function getGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""
  );
}

const planSchema = {
  type: "OBJECT",
  properties: {
    titulo: { type: "STRING" },
    descricao: { type: "STRING" },
    etapas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          nome: { type: "STRING" },
          acoes: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
        required: ["nome", "acoes"],
      },
    },
  },
  required: ["titulo", "descricao", "etapas"],
};

const calendarSchema = {
  type: "OBJECT",
  properties: {
    titulo: { type: "STRING" },
    itens: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          data: { type: "STRING" },
          tema: { type: "STRING" },
          formato: { type: "STRING" },
          canal: { type: "STRING" },
          objetivo: { type: "STRING" },
          cta: { type: "STRING" },
        },
        required: ["data", "tema", "formato", "canal", "objetivo", "cta"],
      },
    },
  },
  required: ["titulo", "itens"],
};

async function geminiGenerateJson({ prompt, schema }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (response.status === 429) {
    const err = new Error(data?.error?.message || "Rate limited");
    err.status = 429;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || "Erro no Gemini");
    err.status = response.status || 500;
    throw err;
  }

  return safeParseJson(getGeminiText(data));
}

async function geminiGeneratePlan(prompt) {
  return geminiGenerateJson({
    prompt: buildPlanPrompt(prompt),
    schema: planSchema,
  });
}

async function geminiGenerateCalendar(plan, extraContext) {
  return geminiGenerateJson({
    prompt: buildCalendarPrompt(plan, extraContext),
    schema: calendarSchema,
  });
}

async function geminiGenerateText(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (response.status === 429) {
    const err = new Error(data?.error?.message || "Rate limited");
    err.status = 429;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || "Erro no Gemini");
    err.status = response.status || 500;
    throw err;
  }

  return getGeminiText(data).trim();
}

// =========================
// ORQUESTRADOR
// =========================

async function createPlan(userInput) {
  const debug = [];
  const prompt = buildPlanPrompt(userInput);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const plan = await xaiGeneratePlan(userInput);
      if (isValidPlan(plan)) {
        return {
          ok: true,
          provider: "xai",
          mode: "xai_json_prompt",
          data: plan,
          debug,
        };
      }
      debug.push(`xai attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`xai attempt ${attempt}: ${error.message}`);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const plan = await geminiGeneratePlan(userInput);
      if (isValidPlan(plan)) {
        return {
          ok: true,
          provider: "gemini",
          mode: "gemini_structured",
          data: plan,
          debug,
        };
      }
      debug.push(`gemini attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`gemini attempt ${attempt}: ${error.message}`);
    }
  }

  try {
    const rawText = XAI_API_KEY
      ? await xaiGenerateText(
          `Crie um planejamento de marketing em texto claro e organizado.\n\nEntrada:\n"""${userInput}"""`
        )
      : await geminiGenerateText(
          `Crie um planejamento de marketing em texto claro e organizado.\n\nEntrada:\n"""${userInput}"""`
        );

    return {
      ok: false,
      provider: XAI_API_KEY ? "xai" : "gemini",
      mode: "text_fallback",
      error: "A IA não devolveu JSON válido para o planejamento.",
      fallback_text:
        "Planejamento gerado em modo texto. A IA não devolveu JSON perfeito desta vez, mas o conteúdo foi mantido abaixo para você não perder o resultado.",
      raw_text: rawText,
      debug,
    };
  } catch (error) {
    debug.push(`text fallback: ${error.message}`);

    return {
      ok: false,
      mode: "hard_fail",
      error: "Falha ao gerar planejamento.",
      debug,
    };
  }
}

async function createCalendar(plan, extraContext = "") {
  const debug = [];
  const prompt = buildCalendarPrompt(plan, extraContext);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const calendar = await xaiGenerateCalendar(plan, extraContext);
      if (isValidCalendar(calendar)) {
        return {
          ok: true,
          provider: "xai",
          mode: "xai_json_prompt",
          data: calendar,
          debug,
        };
      }
      debug.push(`xai attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`xai attempt ${attempt}: ${error.message}`);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const calendar = await geminiGenerateCalendar(plan, extraContext);
      if (isValidCalendar(calendar)) {
        return {
          ok: true,
          provider: "gemini",
          mode: "gemini_structured",
          data: calendar,
          debug,
        };
      }
      debug.push(`gemini attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`gemini attempt ${attempt}: ${error.message}`);
    }
  }

  try {
    const rawText = XAI_API_KEY
      ? await xaiGenerateText(
          `Crie um calendário editorial em texto claro e organizado com base neste planejamento:\n\n${JSON.stringify(plan, null, 2)}`,
          2600
        )
      : await geminiGenerateText(
          `Crie um calendário editorial em texto claro e organizado com base neste planejamento:\n\n${JSON.stringify(plan, null, 2)}`
        );

    return {
      ok: false,
      provider: XAI_API_KEY ? "xai" : "gemini",
      mode: "text_fallback",
      error: "A IA não devolveu JSON válido para o calendário editorial.",
      fallback_text:
        "Calendário editorial gerado em modo texto. A IA não devolveu JSON perfeito desta vez, mas o conteúdo foi mantido abaixo para você não perder o resultado.",
      raw_text: rawText,
      debug,
    };
  } catch (error) {
    debug.push(`text fallback: ${error.message}`);

    return {
      ok: false,
      mode: "hard_fail",
      error: "Falha ao gerar calendário editorial.",
      debug,
    };
  }
}

// =========================
// HANDLER
// =========================

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return send(res, { ok: true }, 200);
  }

  if (req.method !== "POST") {
    return send(res, { ok: false, error: "Method not allowed." }, 405);
  }

  try {
    if (!XAI_API_KEY && !GEMINI_API_KEY) {
      return send(
        res,
        {
          ok: false,
          error: "Configure pelo menos XAI_API_KEY ou GEMINI_API_KEY.",
        },
        500
      );
    }

    const body = req.body || {};
    const hasExplicitAction = isNonEmptyString(body.action);
    const action = normalizeText(body.action);

    // =========================
    // COMPATIBILIDADE COM INDEX ANTIGO
    // Se vier só { prompt, maxTokens } sem action,
    // devolve { text } como o front antigo espera.
    // =========================
    if (!hasExplicitAction && body.prompt) {
      const prompt = truncateText(normalizeText(body.prompt));
      const maxTokens = Number(body.maxTokens || 2000);

      try {
        const text = await xaiGenerateText(prompt, maxTokens);
        return send(res, {
          ok: true,
          provider: "xai",
          text,
        });
      } catch (xaiError) {
        try {
          const text = await geminiGenerateText(prompt);
          return send(res, {
            ok: true,
            provider: "gemini",
            text,
          });
        } catch (geminiError) {
          const status =
            xaiError?.status === 429 || geminiError?.status === 429 ? 429 : 500;

          return send(
            res,
            {
              ok: false,
              error: `Falha xAI: ${xaiError.message} | Falha Gemini: ${geminiError.message}`,
              details: `Falha xAI: ${xaiError.message} | Falha Gemini: ${geminiError.message}`,
            },
            status
          );
        }
      }
    }

    // =========================
    // NOVO FLUXO
    // =========================

    if (action === "plan") {
      const prompt = truncateText(
        normalizeText(body.prompt) ||
          normalizeText(body.message) ||
          normalizeText(body.briefing)
      );

      if (!prompt) {
        return send(res, { ok: false, error: "Prompt vazio." }, 400);
      }

      const result = await createPlan(prompt);

      if (result.ok) {
        return send(res, {
          ok: true,
          action: "plan",
          provider: result.provider,
          mode: result.mode,
          data: result.data,
          text: JSON.stringify(result.data),
          debug: result.debug,
        });
      }

      return send(res, {
        ok: false,
        action: "plan",
        provider: result.provider,
        mode: result.mode,
        error: result.error,
        fallback_text: result.fallback_text,
        raw_text: result.raw_text,
        debug: result.debug,
      });
    }

    if (action === "calendar") {
      const plan = body.plan;
      const extraContext = truncateText(normalizeText(body.extraContext));

      if (!isValidPlan(plan)) {
        return send(
          res,
          {
            ok: false,
            error: "Planejamento inválido ou ausente para gerar calendário.",
          },
          400
        );
      }

      const result = await createCalendar(plan, extraContext);

      if (result.ok) {
        return send(res, {
          ok: true,
          action: "calendar",
          provider: result.provider,
          mode: result.mode,
          data: result.data,
          text: JSON.stringify(result.data),
          debug: result.debug,
        });
      }

      return send(res, {
        ok: false,
        action: "calendar",
        provider: result.provider,
        mode: result.mode,
        error: result.error,
        fallback_text: result.fallback_text,
        raw_text: result.raw_text,
        debug: result.debug,
      });
    }

    return send(res, { ok: false, error: "Ação inválida." }, 400);
  } catch (error) {
    console.error("API /chat error:", error);

    return send(
      res,
      {
        ok: false,
        error: error?.message || "Erro interno do servidor.",
      },
      500
    );
  }
}
