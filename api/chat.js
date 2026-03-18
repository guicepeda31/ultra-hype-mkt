import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
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

function getContent(completion) {
  return completion?.choices?.[0]?.message?.content ?? "";
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

async function generateWithSchema({ prompt, schemaName, schema }) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "developer",
        content:
          "Responda apenas com JSON válido e siga exatamente o schema definido.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema,
      },
    },
  });

  return safeParseJson(getContent(completion));
}

async function generateWithJsonObject({ prompt }) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "developer",
        content:
          "Responda apenas com JSON válido, sem markdown, sem comentários e sem texto extra.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: {
      type: "json_object",
    },
  });

  return safeParseJson(getContent(completion));
}

async function generateTextFallback(prompt) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "developer",
        content:
          "Responda em texto claro, legível e objetivo. Não use markdown complexo.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return getContent(completion).trim();
}

async function createPlan(userInput) {
  const debug = [];
  const prompt = buildPlanPrompt(userInput);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      titulo: { type: "string" },
      descricao: { type: "string" },
      etapas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            nome: { type: "string" },
            acoes: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["nome", "acoes"],
        },
      },
    },
    required: ["titulo", "descricao", "etapas"],
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const plan = await generateWithSchema({
        prompt,
        schemaName: "planejamento_marketing",
        schema,
      });

      if (isValidPlan(plan)) {
        return { ok: true, mode: "json_schema", data: plan };
      }

      debug.push(`schema attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`schema attempt ${attempt}: ${error.message}`);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const plan = await generateWithJsonObject({ prompt });

      if (isValidPlan(plan)) {
        return { ok: true, mode: "json_object_fallback", data: plan };
      }

      debug.push(`json_object attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`json_object attempt ${attempt}: ${error.message}`);
    }
  }

  try {
    const rawText = await generateTextFallback(`
Crie um planejamento de marketing em texto claro e organizado.

Entrada:
"""${userInput}"""
    `.trim());

    return {
      ok: false,
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

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      titulo: { type: "string" },
      itens: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            data: { type: "string" },
            tema: { type: "string" },
            formato: { type: "string" },
            canal: { type: "string" },
            objetivo: { type: "string" },
            cta: { type: "string" },
          },
          required: ["data", "tema", "formato", "canal", "objetivo", "cta"],
        },
      },
    },
    required: ["titulo", "itens"],
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const calendar = await generateWithSchema({
        prompt,
        schemaName: "calendario_editorial",
        schema,
      });

      if (isValidCalendar(calendar)) {
        return { ok: true, mode: "json_schema", data: calendar };
      }

      debug.push(`schema attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`schema attempt ${attempt}: ${error.message}`);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const calendar = await generateWithJsonObject({ prompt });

      if (isValidCalendar(calendar)) {
        return { ok: true, mode: "json_object_fallback", data: calendar };
      }

      debug.push(`json_object attempt ${attempt}: estrutura inválida`);
    } catch (error) {
      debug.push(`json_object attempt ${attempt}: ${error.message}`);
    }
  }

  try {
    const rawText = await generateTextFallback(`
Crie um calendário editorial em texto claro e organizado com base neste planejamento:

${JSON.stringify(plan, null, 2)}
    `.trim());

    return {
      ok: false,
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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return send(res, { ok: true }, 200);
  }

  if (req.method !== "POST") {
    return send(res, { ok: false, error: "Method not allowed." }, 405);
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return send(
        res,
        {
          ok: false,
          error:
            "Missing server environment variables: OPENAI_API_KEY não configurada.",
        },
        500
      );
    }

    const body = req.body || {};
    const action = normalizeText(body.action || "plan");

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
          mode: result.mode,
          data: result.data,
        });
      }

      return send(res, {
        ok: false,
        action: "plan",
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
          mode: result.mode,
          data: result.data,
        });
      }

      return send(res, {
        ok: false,
        action: "calendar",
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
