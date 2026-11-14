// Bộ xử lý macro kiểu SillyTavern: {{user}}, {{char}}, {{setvar::}}, {{getvar::}}, {{random}}, {{roll}}, {{// }}, {{trim}}...
import { hash32 } from './util.js';

const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

function rollDice(expr) {
  const m = String(expr).trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) { const n = parseInt(expr, 10); return Number.isFinite(n) ? 1 + Math.floor(Math.random() * n) : ''; }
  const count = Number(m[1] || 1), sides = Number(m[2]), mod = Number(m[3] || 0);
  let sum = 0;
  for (let i = 0; i < Math.min(count, 1000); i++) sum += 1 + Math.floor(Math.random() * sides);
  return sum + mod;
}

function splitArgs(s) {
  if (s.includes('::')) return s.split('::');
  return s.split(/(?<!\\),/).map((x) => x.replace(/\\,/g, ','));
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * ctx: { user, char, group, model, vars: Map, globalVars: Map, input, lastMessage, description, personality, scenario, persona, mesExamples, maxPrompt, seed }
 */
export function evaluateMacros(text, ctx = {}) {
  if (!text || typeof text !== 'string' || !text.includes('{{') && !/<(USER|BOT|CHAR)>/i.test(text)) return text ?? '';
  const vars = ctx.vars || (ctx.vars = new Map());
  const gvars = ctx.globalVars || (ctx.globalVars = new Map());
  let s = text;
  // chú thích & trim
  s = s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
  s = s.replace(/<USER>/gi, ctx.user ?? 'User').replace(/<BOT>|<CHAR>/gi, ctx.char ?? 'Character');

  const now = new Date();
  const one = (name, argStr) => {
    const n = name.toLowerCase();
    const args = argStr == null ? [] : splitArgs(argStr);
    switch (n) {
      case 'user': return ctx.user ?? 'User';
      case 'char': return ctx.char ?? 'Character';
      case 'charifnotgroup': return ctx.char ?? 'Character';
      case 'group': case 'groupnotmuted': return ctx.group ?? ctx.char ?? '';
      case 'model': return ctx.model ?? '';
      case 'input': return ctx.input ?? '';
      case 'lastmessage': case 'lastcharmessage': return ctx.lastMessage ?? '';
      case 'lastusermessage': return ctx.input ?? '';
      case 'lastmessageid': return '0';
      case 'description': case 'charprompt': return ctx.description ?? '';
      case 'personality': return ctx.personality ?? '';
      case 'scenario': return ctx.scenario ?? '';
      case 'persona': return ctx.persona ?? '';
      case 'mesexamples': case 'mesexamplesraw': return ctx.mesExamples ?? '';
      case 'charjailbreak': case 'charinstruction': return '';
      case 'original': return '';
      case 'newline': return '\n';
      case 'noop': return '';
      case 'trim': return '\u0000TRIM\u0000';
      case 'maxprompt': return String(ctx.maxPrompt ?? '');
      case 'idle_duration': return 'vài giây';
      case 'time': return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      case 'date': return now.toLocaleDateString('vi-VN');
      case 'weekday': return WEEKDAYS[now.getDay()];
      case 'isotime': return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      case 'isodate': return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      case 'random': {
        const opts = args.filter((x) => x !== '');
        return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '';
      }
      case 'pick': {
        const opts = args.filter((x) => x !== '');
        if (!opts.length) return '';
        const h = parseInt(hash32(String(ctx.seed ?? '') + argStr), 16);
        return opts[h % opts.length];
      }
      case 'roll': return String(rollDice(args[0] ?? '1d6'));
      case 'reverse': return [...(argStr ?? '')].reverse().join('');
      case 'setvar': vars.set(args[0]?.trim(), args.slice(1).join('::')); return '';
      case 'getvar': return String(vars.get(args[0]?.trim()) ?? '');
      case 'addvar': {
        const k = args[0]?.trim(); const cur = vars.get(k); const v = args.slice(1).join('::');
        const a = Number(cur), b = Number(v);
        vars.set(k, Number.isFinite(a) && Number.isFinite(b) && cur !== undefined && cur !== '' ? a + b : (cur ?? '') + v);
        return '';
      }
      case 'incvar': { const k = args[0]?.trim(); const v = (Number(vars.get(k)) || 0) + 1; vars.set(k, v); return String(v); }
      case 'decvar': { const k = args[0]?.trim(); const v = (Number(vars.get(k)) || 0) - 1; vars.set(k, v); return String(v); }
      case 'setglobalvar': gvars.set(args[0]?.trim(), args.slice(1).join('::')); return '';
      case 'getglobalvar': return String(gvars.get(args[0]?.trim()) ?? '');
      case 'addglobalvar': {
        const k = args[0]?.trim(); const cur = gvars.get(k); const v = args.slice(1).join('::');
        const a = Number(cur), b = Number(v);
        gvars.set(k, Number.isFinite(a) && Number.isFinite(b) && cur !== undefined && cur !== '' ? a + b : (cur ?? '') + v);
        return '';
      }
      case 'incglobalvar': { const k = args[0]?.trim(); const v = (Number(gvars.get(k)) || 0) + 1; gvars.set(k, v); return String(v); }
      case 'decglobalvar': { const k = args[0]?.trim(); const v = (Number(gvars.get(k)) || 0) - 1; gvars.set(k, v); return String(v); }
      case 'banned': return '';
      default: return null; // không biết -> giữ nguyên
    }
  };

  // xử lý macro trong cùng trước (hỗ trợ lồng nhau)
  const inner = /\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/g;
  for (let guard = 0; guard < 50; guard++) {
    let changed = false;
    s = s.replace(inner, (full, body) => {
      const m = body.match(/^\s*([a-zA-Z_][\w]*)\s*(?:(::|:)([\s\S]*))?$/);
      if (!m) return full.replace('{{', '\u0001{').replace('}}', '}\u0001');
      const r = one(m[1], m[3] != null ? m[3] : null);
      if (r == null) return full.replace('{{', '\u0001{').replace('}}', '}\u0001');
      changed = true;
      return r;
    });
    if (!changed) break;
  }
  s = s.replace(/\u0001\{/g, '{{').replace(/\}\u0001/g, '}}');
  s = s.replace(/(?:\r?\n)*\u0000TRIM\u0000(?:\r?\n)*/g, '');
  return s;
}
