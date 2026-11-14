// Preset Chat Completion của SillyTavern: nhập/xuất nguyên vẹn, quản lý prompt, dựng danh sách message.
import { evaluateMacros } from './macros.js';
import { deepClone } from './util.js';

export const DEFAULT_PRESET = {
  chat_completion_source: 'custom',
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  top_p: 1,
  top_k: 0,
  top_a: 0,
  min_p: 0,
  repetition_penalty: 1,
  openai_max_context: 128000,
  openai_max_tokens: 8192,
  wrap_in_quotes: false,
  names_behavior: 0,
  send_if_empty: '',
  impersonation_prompt: '',
  new_chat_prompt: '[Start a new Chat]',
  new_group_chat_prompt: '',
  new_example_chat_prompt: '[Example Chat]',
  continue_nudge_prompt: '',
  bias_preset_selected: 'Default (none)',
  max_context_unlocked: true,
  wi_format: '{0}',
  scenario_format: '{{scenario}}',
  personality_format: '{{personality}}',
  group_nudge_prompt: '',
  stream_openai: true,
  prompts: [
    { name: 'Main Prompt', system_prompt: true, role: 'system', content: '', identifier: 'main' },
    { name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', identifier: 'nsfw' },
    { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
    { name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', identifier: 'jailbreak' },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    { identifier: 'enhanceDefinitions', role: 'system', name: 'Enhance Definitions', content: '', system_prompt: true, marker: false },
    { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'personaDescription', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'charPersonality', enabled: true },
        { identifier: 'scenario', enabled: true },
        { identifier: 'enhanceDefinitions', enabled: false },
        { identifier: 'nsfw', enabled: true },
        { identifier: 'worldInfoAfter', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
    },
  ],
  assistant_prefill: '',
  assistant_impersonation: '',
  human_sysprompt_message: '',
  claude_use_sysprompt: true,
  use_makersuite_sysprompt: true,
  squash_system_messages: false,
  continue_prefill: false,
  continue_postfix: ' ',
  function_calling: false,
  show_thoughts: false,
  reasoning_effort: 'auto',
  seed: -1,
  n: 1,
};

export const MARKERS = {
  main: 'Main Prompt', nsfw: 'Auxiliary Prompt', jailbreak: 'Post-History Instructions', chatHistory: 'Chat History',
  dialogueExamples: 'Chat Examples', worldInfoBefore: 'World Info (before)', worldInfoAfter: 'World Info (after)',
  charDescription: 'Char Description', charPersonality: 'Char Personality', scenario: 'Scenario',
  personaDescription: 'Persona Description', enhanceDefinitions: 'Enhance Definitions',
};

/** Các tham số sampler hiển thị trong UI (giống panel ST) */
export const SAMPLERS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01 },
  { key: 'frequency_penalty', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01 },
  { key: 'presence_penalty', label: 'Presence Penalty', min: -2, max: 2, step: 0.01 },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01 },
  { key: 'top_k', label: 'Top K', min: 0, max: 500, step: 1 },
  { key: 'top_a', label: 'Top A', min: 0, max: 1, step: 0.01 },
  { key: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.001 },
  { key: 'repetition_penalty', label: 'Repetition Penalty', min: 1, max: 2, step: 0.01 },
  { key: 'openai_max_context', label: 'Context Size (tokens)', min: 512, max: 2000000, step: 1, wide: true },
  { key: 'openai_max_tokens', label: 'Max Response Length (tokens)', min: 1, max: 131072, step: 1, wide: true },
  { key: 'seed', label: 'Seed (-1 = ngẫu nhiên)', min: -1, max: 2147483647, step: 1, wide: true },
];

/** Nhận diện & chuẩn hóa preset được nhập (giữ nguyên toàn bộ trường gốc) */
export function importPreset(json, fileName = 'preset.json') {
  let raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (!raw || typeof raw !== 'object') throw new Error('Preset không hợp lệ');
  // một số preset bọc trong { preset: {...} } hoặc { data: {...} }
  if (!raw.prompts && raw.preset && typeof raw.preset === 'object') raw = raw.preset;
  const isCC = Array.isArray(raw.prompts) || 'openai_max_tokens' in raw || 'temperature' in raw && 'stream_openai' in raw;
  const isTC = !isCC && ('temp' in raw || 'rep_pen' in raw || 'genamt' in raw);
  let preset;
  if (isCC) {
    preset = deepClone(raw);
    if (!Array.isArray(preset.prompts)) preset.prompts = deepClone(DEFAULT_PRESET.prompts);
    if (!Array.isArray(preset.prompt_order) || !preset.prompt_order.length) preset.prompt_order = [{ character_id: 100001, order: preset.prompts.map((p) => ({ identifier: p.identifier, enabled: true })) }];
  } else if (isTC) {
    // preset Text Completion -> lấy sampler
    preset = deepClone(DEFAULT_PRESET);
    preset.temperature = num(raw.temp, 1);
    preset.top_p = num(raw.top_p, 1);
    preset.top_k = num(raw.top_k, 0);
    preset.top_a = num(raw.top_a, 0);
    preset.min_p = num(raw.min_p, 0);
    preset.repetition_penalty = num(raw.rep_pen, 1);
    preset.frequency_penalty = num(raw.freq_pen, 0);
    preset.presence_penalty = num(raw.presence_pen, 0);
    if (raw.genamt) preset.openai_max_tokens = num(raw.genamt, 8192);
    if (raw.max_length) preset.openai_max_context = num(raw.max_length, 32000);
    preset._source_text_completion = raw;
  } else {
    throw new Error('Không nhận ra định dạng preset (cần preset Chat Completion hoặc Text Completion của SillyTavern)');
  }
  const name = String(fileName).replace(/\.json$/i, '');
  return { name, data: preset };
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function exportPreset(preset) {
  return JSON.stringify(preset.data, null, 4);
}

/** Lấy danh sách thứ tự prompt (giống ST: ưu tiên character_id 100001 = global) */
export function getOrder(data) {
  const po = Array.isArray(data.prompt_order) ? data.prompt_order : [];
  let entry = po.find((x) => Number(x.character_id) === 100001) || po.find((x) => Number(x.character_id) === 100000) || po[0];
  if (!entry) {
    entry = { character_id: 100001, order: (data.prompts || []).map((p) => ({ identifier: p.identifier, enabled: true })) };
    data.prompt_order = [entry];
  }
  if (!Array.isArray(entry.order)) entry.order = [];
  // prompt có trong danh sách nhưng chưa có trong order -> không thêm (ST cũng ẩn)
  return entry.order;
}

export function getPrompt(data, identifier) {
  return (data.prompts || []).find((p) => p.identifier === identifier);
}

/**
 * Dựng danh sách message theo preset (logic giống Prompt Manager của ST, rút gọn cho tác vụ dịch).
 * opts: {
 *   usePresetPrompts: bool,   // false = chỉ dùng prompt dịch của app
 *   systemPrompt: string,     // prompt hệ thống của app (chỉ thị dịch)
 *   taskMessages: [{role, content}], // nội dung cần dịch (đặt tại vị trí Chat History)
 *   macro: ctx cho evaluateMacros, provider, applyPrefill
 * }
 */
export function buildMessages(data, opts) {
  const macro = opts.macro || {};
  const sys = opts.systemPrompt ? [{ role: 'system', content: evaluateMacros(opts.systemPrompt, macro) }] : [];
  const task = (opts.taskMessages || []).map((m) => ({ ...m }));
  let messages = [];
  if (!opts.usePresetPrompts) {
    messages = [...sys, ...task];
  } else {
    const order = getOrder(data);
    const injections = [];
    let placedHistory = false;
    for (const o of order) {
      if (!o || !o.enabled) continue;
      const p = getPrompt(data, o.identifier);
      if (!p) continue;
      if (Number(p.injection_position) === 1 && !p.marker) {
        const content = evaluateMacros(p.content || '', macro);
        if (content.trim()) injections.push({ role: p.role || 'system', content, depth: Number(p.injection_depth ?? 4), order: Number(p.injection_order ?? 100) });
        continue;
      }
      if (p.marker) {
        if (o.identifier === 'chatHistory') { messages.push({ __history: true }); placedHistory = true; }
        continue;
      }
      const content = evaluateMacros(p.content || '', macro);
      if (content.trim()) messages.push({ role: p.role || 'system', content });
    }
    if (!placedHistory) messages.push({ __history: true });
    // chèn chỉ thị dịch + nội dung tại vị trí Chat History, kèm prompt "in-chat" theo depth
    const hist = [...sys, ...task];
    injections.sort((a, b) => a.order - b.order);
    for (const inj of injections) {
      const pos = Math.max(0, hist.length - inj.depth);
      hist.splice(pos, 0, { role: inj.role, content: inj.content });
    }
    const idx = messages.findIndex((m) => m.__history);
    messages.splice(idx, 1, ...hist);
  }
  if (data.squash_system_messages) messages = squashSystem(messages);
  const prefill = evaluateMacros(data.assistant_prefill || '', macro);
  if (prefill && (opts.provider === 'claude' || opts.applyPrefill)) messages.push({ role: 'assistant', content: prefill });
  return messages.filter((m) => m.content != null && (m.content !== '' || m.role === 'assistant'));
}

function squashSystem(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === 'system' && m.role === 'system' && !m.name && !last.name) last.content += '\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}

/** Hậu xử lý prompt (giống "Prompt Post-Processing" của ST cho Custom endpoint) */
export function postProcess(messages, mode) {
  let msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  if (!mode || mode === 'none') return msgs;
  if (mode === 'single') {
    return [{ role: 'user', content: msgs.map((m) => m.content).join('\n\n') }];
  }
  const merge = (arr) => {
    const out = [];
    for (const m of arr) {
      const last = out[out.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else out.push({ ...m });
    }
    return out;
  };
  msgs = merge(msgs);
  if (mode === 'merge') return msgs;
  // semi/strict: chỉ 1 system ở đầu
  const out = [];
  msgs.forEach((m, i) => {
    if (m.role === 'system' && i !== 0) out.push({ role: 'user', content: m.content });
    else out.push(m);
  });
  msgs = merge(out);
  if (mode === 'strict') {
    const first = msgs[0]?.role === 'system' ? 1 : 0;
    if (msgs[first] && msgs[first].role !== 'user') msgs.splice(first, 0, { role: 'user', content: '[Start]' });
  }
  return msgs;
}
