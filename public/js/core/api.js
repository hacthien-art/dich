// Gọi API LLM thông qua máy chủ cục bộ (tránh CORS): OpenAI-compatible / Claude / Gemini, có streaming.
import { postProcess } from './preset.js';

export const PROVIDERS = {
  openai: 'OpenAI-compatible (proxy / reverse proxy / OpenRouter / one-api...)',
  claude: 'Claude (Anthropic API / reverse proxy)',
  gemini: 'Google AI Studio (Gemini)',
};

function appToken() {
  if (typeof document === 'undefined') return globalThis.__APP_TOKEN__ || '';
  return document.querySelector('meta[name="app-token"]')?.content || '';
}

async function api(path, body, signal) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Token': appToken() },
    body: JSON.stringify(body),
    signal,
  });
  return r;
}

function parseHeaders(text) {
  if (!text || !String(text).trim()) return undefined;
  try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : undefined; } catch { throw new Error('Header bổ sung phải là JSON hợp lệ, ví dụ {"X-Foo": "bar"}'); }
}
function parseExtraBody(text) {
  if (!text || !String(text).trim()) return {};
  try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : {}; } catch { throw new Error('Body JSON bổ sung không hợp lệ'); }
}

export async function listModels(conn, signal) {
  const r = await api('/api/llm/models', { provider: conn.provider, url: conn.url, key: conn.key, headers: parseHeaders(conn.headers), claudeBearer: conn.claudeBearer }, signal);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const isReasoningModel = (m) => /^(o\d|gpt-5)/i.test(String(m || '').replace(/^.*\//, ''));

/** Tạo payload theo nhà cung cấp */
export function buildPayload(conn, preset, messages, { stream, maxTokens } = {}) {
  const p = preset || {};
  const model = conn.model;
  const extra = parseExtraBody(conn.extraBody);
  const max = Number(maxTokens || p.openai_max_tokens || 4096);
  if (conn.provider === 'claude') {
    let system = '';
    const msgs = [];
    for (const m of messages) {
      if (m.role === 'system' && !msgs.length) system += (system ? '\n\n' : '') + m.content;
      else msgs.push({ role: m.role === 'system' ? 'user' : m.role, content: m.content });
    }
    const merged = postProcess(msgs, 'merge');
    if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: p.human_sysprompt_message || 'Let\'s get started.' });
    const body = { model, max_tokens: max, messages: merged, stream: !!stream };
    if (system) body.system = system;
    const t = Number(p.temperature ?? 1), tp = Number(p.top_p ?? 1), tk = Number(p.top_k ?? 0);
    body.temperature = Math.min(1, Math.max(0, t));
    if (tp < 1 && t === 1) body.top_p = tp;
    if (tk > 0) body.top_k = tk;
    return { ...body, ...extra };
  }
  if (conn.provider === 'gemini') {
    let systemText = '';
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system' && p.use_makersuite_sysprompt !== false && !contents.length) { systemText += (systemText ? '\n\n' : '') + m.content; continue; }
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push({ text: m.content });
      else contents.push({ role, parts: [{ text: m.content }] });
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: '...' }] });
    const cats = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY'];
    const body = {
      contents,
      safetySettings: cats.map((category) => ({ category, threshold: 'BLOCK_NONE' })),
      generationConfig: { temperature: Number(p.temperature ?? 1), topP: Number(p.top_p ?? 1), maxOutputTokens: max, candidateCount: 1 },
    };
    if (Number(p.top_k) > 0) body.generationConfig.topK = Number(p.top_k);
    if (Number(p.seed) >= 0) body.generationConfig.seed = Number(p.seed);
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    return { ...body, ...extra };
  }
  // OpenAI-compatible
  const msgs = postProcess(messages, conn.postProcessing || 'none');
  const body = { model, messages: msgs, stream: !!stream };
  if (isReasoningModel(model)) {
    body.max_completion_tokens = max;
  } else {
    body.max_tokens = max;
    body.temperature = Number(p.temperature ?? 1);
    body.top_p = Number(p.top_p ?? 1);
    body.frequency_penalty = Number(p.frequency_penalty ?? 0);
    body.presence_penalty = Number(p.presence_penalty ?? 0);
    if (conn.extendedSamplers !== false) {
      if (Number(p.top_k) > 0) body.top_k = Number(p.top_k);
      if (Number(p.min_p) > 0) body.min_p = Number(p.min_p);
      if (Number(p.top_a) > 0) body.top_a = Number(p.top_a);
      if (Number(p.repetition_penalty) > 0 && Number(p.repetition_penalty) !== 1) body.repetition_penalty = Number(p.repetition_penalty);
    }
  }
  if (Number(p.seed) >= 0) body.seed = Number(p.seed);
  if (conn.sendReasoningEffort && p.reasoning_effort && p.reasoning_effort !== 'auto') {
    const map = { min: 'minimal', minimum: 'minimal', max: 'high', maximum: 'high' };
    body.reasoning_effort = map[p.reasoning_effort] || p.reasoning_effort;
  }
  return { ...body, ...extra };
}

function errorFrom(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.error) return typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
  if (j.type === 'error' && j.message) return j.message;
  if (j.promptFeedback?.blockReason) return 'Gemini chặn nội dung: ' + j.promptFeedback.blockReason;
  return null;
}

function extractFull(provider, j) {
  if (provider === 'claude') {
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const reasoning = (j.content || []).filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
    return { text, reasoning, finish: j.stop_reason };
  }
  if (provider === 'gemini') {
    const c = j.candidates?.[0];
    const parts = c?.content?.parts || [];
    return { text: parts.filter((x) => !x.thought).map((x) => x.text || '').join(''), reasoning: parts.filter((x) => x.thought).map((x) => x.text || '').join(''), finish: c?.finishReason };
  }
  const c = j.choices?.[0];
  const msg = c?.message || {};
  let text = msg.content ?? c?.text ?? '';
  if (Array.isArray(text)) text = text.map((x) => x.text || '').join('');
  return { text: String(text || ''), reasoning: msg.reasoning_content || msg.reasoning || '', finish: c?.finish_reason };
}

function extractDelta(provider, j) {
  if (provider === 'claude') {
    if (j.type === 'content_block_delta') {
      if (j.delta?.type === 'text_delta') return { text: j.delta.text };
      if (j.delta?.type === 'thinking_delta') return { reasoning: j.delta.thinking };
    }
    if (j.type === 'message_delta') return { finish: j.delta?.stop_reason };
    return {};
  }
  if (provider === 'gemini') {
    const c = j.candidates?.[0];
    const parts = c?.content?.parts || [];
    return { text: parts.filter((x) => !x.thought).map((x) => x.text || '').join(''), reasoning: parts.filter((x) => x.thought).map((x) => x.text || '').join(''), finish: c?.finishReason };
  }
  const c = j.choices?.[0];
  if (!c) return {};
  const d = c.delta || {};
  let text = d.content ?? c.text ?? '';
  if (Array.isArray(text)) text = text.map((x) => x.text || '').join('');
  return { text: text || '', reasoning: d.reasoning_content || d.reasoning || '', finish: c.finish_reason };
}

/** Bỏ khối suy nghĩ <think>...</think> mà một số model chèn vào nội dung */
export function stripThinking(text) {
  return String(text || '').replace(/^\s*<(think|thinking|thought)>[\s\S]*?<\/\1>\s*/i, '').replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
}

/**
 * Gửi yêu cầu chat. Trả về { text, reasoning, finish, truncated }
 * onDelta(textSoFar) được gọi khi stream.
 */
export async function chat(conn, preset, messages, { signal, onDelta, maxTokens, stream } = {}) {
  if (!conn?.url) throw new Error('Chưa nhập URL proxy trong tab Kết nối');
  if (!conn?.model) throw new Error('Chưa chọn model trong tab Kết nối');
  const useStream = stream ?? (preset?.stream_openai !== false);
  const payload = buildPayload(conn, preset, messages, { stream: useStream, maxTokens });
  const r = await api('/api/llm/chat', { provider: conn.provider, url: conn.url, key: conn.key, model: conn.model, headers: parseHeaders(conn.headers), claudeBearer: conn.claudeBearer, stream: useStream, payload }, signal);
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), { status: j?.status || r.status });
  }
  let text = '', reasoning = '', finish = null;
  if (!useStream || !/event-stream|stream/i.test(ct)) {
    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); } catch {
      // có thể là SSE dù content-type khác
      if (raw.includes('data:')) return parseSseText(conn.provider, raw, onDelta, conn);
      throw new Error('Phản hồi không phải JSON: ' + raw.slice(0, 300));
    }
    const err = errorFrom(j);
    if (err) throw new Error(err);
    ({ text, reasoning, finish } = extractFull(conn.provider, j));
  } else {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const res = handleSseLine(conn.provider, line);
        if (!res) continue;
        if (res.error) throw new Error(res.error);
        if (res.text) text += res.text;
        if (res.reasoning) reasoning += res.reasoning;
        if (res.finish) finish = res.finish;
        if (onDelta && (res.text || res.reasoning)) onDelta(text, reasoning);
      }
    }
    if (buf.trim()) {
      const res = handleSseLine(conn.provider, buf.trim());
      if (res?.error) throw new Error(res.error);
      if (res?.text) text += res.text;
      if (res?.finish) finish = res.finish;
    }
  }
  if (conn.stripThinking !== false) text = stripThinking(text);
  const truncated = /length|max_tokens|MAX_TOKENS/i.test(String(finish || ''));
  return { text, reasoning, finish, truncated };
}

function handleSseLine(provider, line) {
  if (!line || line.startsWith(':') || line.startsWith('event:')) return null;
  if (!line.startsWith('data:')) {
    // một số proxy trả JSON lỗi thô
    if (line.startsWith('{')) { try { const j = JSON.parse(line); const e = errorFrom(j); if (e) return { error: e }; } catch { /* */ } }
    return null;
  }
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  let j;
  try { j = JSON.parse(data); } catch { return null; }
  const err = errorFrom(j);
  if (err) return { error: err };
  return extractDelta(provider, j);
}

function parseSseText(provider, raw, onDelta, conn) {
  let text = '', reasoning = '', finish = null;
  for (const line of raw.split(/\r?\n/)) {
    const res = handleSseLine(provider, line);
    if (!res) continue;
    if (res.error) throw new Error(res.error);
    text += res.text || '';
    reasoning += res.reasoning || '';
    if (res.finish) finish = res.finish;
  }
  onDelta?.(text, reasoning);
  if (conn.stripThinking !== false) text = stripThinking(text);
  return { text, reasoning, finish, truncated: /length|max_tokens|MAX_TOKENS/i.test(String(finish || '')) };
}
