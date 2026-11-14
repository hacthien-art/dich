/* Môi trường giả lập Tavern Helper + MVU cho iframe xem trước (chạy trong sandbox, không truy cập được app).
 * Dữ liệu được nạp qua window.__TH_DATA__ trước khi file này chạy.
 * Hành động (slash, đổi lời chào, toast...) gửi về app qua postMessage.
 */
(function () {
  'use strict';
  var D = window.__TH_DATA__ || {};
  var frameId = D.frameId || 'frame';

  // iframe sandbox không có localStorage/sessionStorage thật -> dùng bộ nhớ tạm để script của card không lỗi
  function memStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      clear: function () { m = {}; },
      key: function (i) { return Object.keys(m)[i] || null; },
      get length() { return Object.keys(m).length; },
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = true;
    try { ok = !!window[name]; window[name].getItem('__t'); } catch (e) { ok = false; }
    if (!ok) { try { Object.defineProperty(window, name, { value: memStorage(), configurable: true }); } catch (e) { /* */ } }
  });
  var clone = function (o) { try { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); } catch (e) { return o; } };
  // giữ tham chiếu cửa sổ app thật trước khi thay window.parent bằng bản giả lập kiểu ST
  var realParent = window.parent;
  var send = function (type, payload) {
    try { realParent.postMessage(Object.assign({ __th: 1, frameId: frameId, type: type }, payload || {}), '*'); } catch (e) { /* */ }
  };
  try { document.documentElement.setAttribute('translate', 'no'); } catch (e) { /* */ }
  var lodash = window._;
  var getPath = function (obj, path, def) {
    if (lodash && lodash.get) return lodash.get(obj, path, def);
    var ks = String(path).split('.'); var o = obj;
    for (var i = 0; i < ks.length; i++) { if (o == null) return def; o = o[ks[i]]; }
    return o === undefined ? def : o;
  };
  var setPath = function (obj, path, val) {
    if (lodash && lodash.set) return lodash.set(obj, path, val);
    var ks = String(path).split('.'); var o = obj;
    for (var i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = val; return obj;
  };

  // ------------------------------------------------------------------ dữ liệu
  var chat = (D.chat || []).map(function (m, i) {
    return {
      message_id: i, name: m.name, role: m.is_user ? 'user' : 'assistant', is_hidden: false,
      message: m.message, swipe_id: m.swipe_id || 0, swipes: m.swipes || [m.message],
      data: { stat_data: clone(m.stat_data || D.stat_data || {}), display_data: clone(m.stat_data || D.stat_data || {}), delta_data: {} },
      extra: {}, is_user: !!m.is_user,
    };
  });
  var messageId = typeof D.messageId === 'number' ? D.messageId : Math.max(0, chat.length - 1);
  var store = {
    global: clone(D.globalVars || {}),
    character: clone(D.charVars || {}),
    chat: clone(D.chatVars || {}),
    script: {},
    preset: {},
  };
  function msgData(id) {
    if (id === 'latest' || id === undefined || id === null) id = messageId;
    if (typeof id === 'number' && id < 0) id = chat.length + id;
    var m = chat[id] || chat[messageId] || { data: {} };
    return m.data;
  }
  function varsOf(option) {
    option = option || {};
    var type = option.type || 'chat';
    if (type === 'message') return msgData(option.message_id);
    if (!store[type]) store[type] = {};
    return store[type];
  }
  function assignVars(target, vars) { Object.keys(vars || {}).forEach(function (k) { target[k] = vars[k]; }); }

  // ------------------------------------------------------------------ sự kiện
  var listeners = {};
  function eventOn(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return { stop: function () { eventRemoveListener(ev, cb); } }; }
  function eventOnce(ev, cb) { var w = function () { eventRemoveListener(ev, w); return cb.apply(null, arguments); }; return eventOn(ev, w); }
  function eventRemoveListener(ev, cb) { listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== cb; }); }
  function eventEmit(ev) {
    var args = Array.prototype.slice.call(arguments, 1);
    var ls = (listeners[ev] || []).slice();
    return Promise.all(ls.map(function (f) { try { return f.apply(null, args); } catch (e) { console.error(e); } }));
  }
  var tavern_events = {
    APP_READY: 'app_ready', MESSAGE_SWIPED: 'message_swiped', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_UPDATED: 'message_updated', CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started', GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', USER_MESSAGE_RENDERED: 'user_message_rendered', STREAM_TOKEN_RECEIVED: 'stream_token_received',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', SETTINGS_UPDATED: 'settings_updated',
  };
  var iframe_events = {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_STARTED: 'js_generation_started', STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally', GENERATION_ENDED: 'js_generation_ended',
  };

  // ------------------------------------------------------------------ toastr
  var toastr = {};
  ['success', 'info', 'warning', 'error'].forEach(function (k) {
    toastr[k] = function (msg, title) { send('toast', { level: k, message: String(msg == null ? '' : msg), title: title ? String(title) : '' }); return {}; };
  });
  toastr.clear = function () {}; toastr.remove = function () {}; toastr.options = {};

  // ------------------------------------------------------------------ slash
  function triggerSlash(cmd) {
    send('slash', { cmd: String(cmd == null ? '' : cmd) });
    return Promise.resolve('');
  }

  // ------------------------------------------------------------------ chat
  function parseRange(range) {
    if (range === undefined || range === null) return [0, chat.length - 1];
    if (typeof range === 'number') { var r = range < 0 ? chat.length + range : range; return [r, r]; }
    var m = String(range).match(/^(-?\d+)(?:-(-?\d+))?$/);
    if (!m) return [0, chat.length - 1];
    var a = Number(m[1]), b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < 0) a = chat.length + a; if (b < 0) b = chat.length + b;
    return [Math.min(a, b), Math.max(a, b)];
  }
  function getChatMessages(range, opt) {
    var r = parseRange(range); var out = [];
    opt = opt || {};
    for (var i = r[0]; i <= r[1] && i < chat.length; i++) {
      var m = chat[i];
      if (opt.role && opt.role !== 'all' && opt.role !== m.role) continue;
      var item = { message_id: i, name: m.name, role: m.role, is_hidden: false, message: m.message, data: clone(m.data), extra: {} };
      if (opt.include_swipes) { item.swipe_id = m.swipe_id; item.swipes = m.swipes.slice(); item.swipes_data = m.swipes.map(function () { return clone(m.data); }); }
      else { item.swipe_id = m.swipe_id; item.swipes = m.swipes.slice(); }
      out.push(item);
    }
    return out;
  }
  function setChatMessages(list, opt) {
    list = Array.isArray(list) ? list : [list];
    list.forEach(function (x) {
      var m = chat[x.message_id];
      if (m) {
        if (typeof x.message === 'string') m.message = x.message;
        if (x.data) m.data = clone(x.data);
        if (typeof x.swipe_id === 'number' && m.swipes[x.swipe_id] !== undefined) { m.swipe_id = x.swipe_id; m.message = m.swipes[x.swipe_id]; }
      }
    });
    send('setChat', { list: clone(list), option: clone(opt || {}) });
    return Promise.resolve();
  }
  function setChatMessage(fieldValues, id, opt) {
    var x = Object.assign({ message_id: id }, typeof fieldValues === 'string' ? { message: fieldValues } : fieldValues || {});
    if (typeof x.swipe_id !== 'number' && opt && typeof opt.swipe_id === 'number') x.swipe_id = opt.swipe_id;
    return setChatMessages([x], opt);
  }
  function createChatMessages(list, opt) {
    send('createChat', { list: clone(list), option: clone(opt || {}) });
    return Promise.resolve();
  }
  function deleteChatMessages(ids) { send('slash', { cmd: '/cut ' + [].concat(ids).join(',') }); return Promise.resolve(); }

  // ------------------------------------------------------------------ biến
  function getVariables(option) { return clone(varsOf(option)); }
  function replaceVariables(vars, option) {
    var t = varsOf(option); Object.keys(t).forEach(function (k) { delete t[k]; }); assignVars(t, clone(vars));
    send('vars', { option: option || {}, vars: clone(t) }); return Promise.resolve();
  }
  function insertOrAssignVariables(vars, option) {
    var t = varsOf(option);
    if (lodash && lodash.merge) lodash.merge(t, clone(vars)); else assignVars(t, clone(vars));
    send('vars', { option: option || {}, vars: clone(t) }); return Promise.resolve(clone(t));
  }
  function insertVariables(vars, option) {
    var t = varsOf(option);
    if (lodash && lodash.defaultsDeep) lodash.defaultsDeep(t, clone(vars));
    return Promise.resolve(clone(t));
  }
  function updateVariablesWith(fn, option) {
    var t = varsOf(option);
    var r = fn(clone(t));
    var apply = function (v) { if (v && typeof v === 'object') { Object.keys(t).forEach(function (k) { delete t[k]; }); assignVars(t, v); } return clone(t); };
    return r && typeof r.then === 'function' ? r.then(apply) : Promise.resolve(apply(r));
  }
  function deleteVariable(path, option) { var t = varsOf(option); if (lodash && lodash.unset) lodash.unset(t, path); return Promise.resolve({ variables: clone(t), delete_occurred: true }); }
  function getAllVariables() {
    var out = {};
    var merge = function (o) { if (lodash && lodash.merge) lodash.merge(out, clone(o)); else assignVars(out, clone(o)); };
    merge(store.global); merge(store.character); merge(store.chat); merge(msgData(messageId));
    return out;
  }

  // ------------------------------------------------------------------ MVU
  var Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initialized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', SINGLE_VARIABLE_UPDATED: 'mag_variable_updated',
      COMMAND_PARSED: 'mag_command_parsed', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData: function (opt) {
      opt = opt || { type: 'message', message_id: 'latest' };
      var d = opt.type === 'message' || !opt.type ? msgData(opt.message_id) : varsOf(opt);
      return clone(Object.assign({ initialized_lorebooks: {}, stat_data: {}, display_data: {}, delta_data: {} }, d));
    },
    replaceMvuData: function (data, opt) { return replaceVariables(data, opt || { type: 'message', message_id: 'latest' }); },
    getMvuVariable: function (data, path, opt) {
      opt = opt || {};
      var cat = opt.category || 'stat';
      var root = cat === 'display' ? data.display_data : cat === 'delta' ? data.delta_data : data.stat_data;
      var v = getPath(root, path, opt.default_value);
      return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v;
    },
    setMvuVariable: function (data, path, value) { setPath(data.stat_data, path, value); return Promise.resolve(true); },
    parseMessage: function (message, oldData) { return Promise.resolve(clone(oldData)); },
    reloadInitVar: function () { return Promise.resolve(false); },
  };

  // ------------------------------------------------------------------ khác
  function substitudeMacros(text) {
    return String(text == null ? '' : text).replace(/\{\{user\}\}/gi, D.userName || 'User').replace(/\{\{char\}\}/gi, D.charName || 'Character');
  }
  function notSupported(name) {
    return function () {
      send('toast', { level: 'warning', message: name + '() không chạy trong chế độ xem trước (không gọi AI).' });
      return Promise.reject(new Error(name + ' không được hỗ trợ trong xem trước'));
    };
  }
  function errorCatched(fn) {
    return function () { try { var r = fn.apply(this, arguments); if (r && r.catch) r.catch(function (e) { console.error(e); }); return r; } catch (e) { console.error(e); send('toast', { level: 'error', message: String(e && e.message || e) }); } };
  }
  var charData = Object.assign({ name: D.charName || 'Character', avatar: '', description: '', first_mes: '' }, D.charData || {});

  var TH = {
    getVariables: getVariables, replaceVariables: replaceVariables, insertOrAssignVariables: insertOrAssignVariables, insertVariables: insertVariables,
    updateVariablesWith: updateVariablesWith, deleteVariable: deleteVariable, getAllVariables: getAllVariables,
    getChatMessages: getChatMessages, setChatMessages: setChatMessages, setChatMessage: setChatMessage, createChatMessages: createChatMessages,
    deleteChatMessages: deleteChatMessages,
    getCurrentMessageId: function () { return messageId; }, getLastMessageId: function () { return chat.length - 1; },
    getMessageId: function (name) { var m = String(name || '').match(/message-iframe-(\d+)/); return m ? Number(m[1]) : messageId; },
    getIframeName: function () { return 'message-iframe-' + messageId + '-' + frameId; },
    getScriptId: function () { return 'preview-script'; },
    triggerSlash: triggerSlash, triggerSlashWithResult: triggerSlash,
    eventOn: eventOn, eventOnce: eventOnce, eventEmit: eventEmit, eventRemoveListener: eventRemoveListener,
    eventMakeFirst: eventOn, eventMakeLast: eventOn, eventClearEvent: function (ev) { delete listeners[ev]; }, eventClearListener: function () {}, eventClearAll: function () { listeners = {}; },
    tavern_events: tavern_events, iframe_events: iframe_events,
    getCharData: function () { return clone(charData); }, getCharAvatarPath: function () { return ''; },
    getChatHistoryBrief: function () { return []; }, getChatHistoryDetail: function () { return {}; },
    substitudeMacros: substitudeMacros, substituteMacros: substitudeMacros,
    generate: notSupported('generate'), generateRaw: notSupported('generateRaw'), stopAllGeneration: function () { return true; },
    getLorebookEntries: function () { return Promise.resolve(clone(D.lorebookEntries || [])); },
    getCharLorebooks: function () { return { primary: D.bookName || null, additional: [] }; },
    getCurrentCharPrimaryLorebook: function () { return D.bookName || null; },
    waitGlobalInitialized: function () { return Promise.resolve(); },
    getTavernHelperVersion: function () { return '4.0.0'; }, getFrontendVersion: function () { return '4.0.0'; }, getTavernVersion: function () { return '1.13.5'; },
    errorCatched: errorCatched,
    getButtonEvent: function (name) { return 'button_' + name; }, getScriptButtons: function () { return []; }, replaceScriptButtons: function () {},
    reloadIframe: function () { location.reload(); },
    builtin: { reloadEditor: function () {}, renderMarkdown: function (t) { return t; } },
  };
  Object.keys(TH).forEach(function (k) { if (!(k in window)) window[k] = TH[k]; });
  window.TavernHelper = TH;
  window.Mvu = Mvu;
  window.toastr = window.toastr || toastr;

  // SillyTavern.getContext()
  var stChat = function () {
    return chat.map(function (m) {
      return { name: m.name, is_user: m.is_user, is_system: false, mes: m.message, swipe_id: m.swipe_id, swipes: m.swipes.slice(), extra: {}, variables: m.swipes.map(function () { return clone(m.data); }) };
    });
  };
  var eventSource = { on: eventOn, once: eventOnce, emit: eventEmit, removeListener: eventRemoveListener, makeFirst: eventOn, makeLast: eventOn };
  var ctx = function () {
    return {
      chat: stChat(), characters: [charData], characterId: 0, this_chid: 0, groupId: null, name1: D.userName || 'User', name2: D.charName || 'Character',
      chatMetadata: { variables: clone(store.chat) }, extensionSettings: {}, eventSource: eventSource, event_types: tavern_events, eventTypes: tavern_events,
      variables: {
        local: { get: function (k) { return getPath(store.chat, k); }, set: function (k, v) { setPath(store.chat, k, v); } },
        global: { get: function (k) { return getPath(store.global, k); }, set: function (k, v) { setPath(store.global, k, v); } },
      },
      executeSlashCommands: triggerSlash, executeSlashCommandsWithOptions: triggerSlash,
      getRequestHeaders: function () { return {}; }, substituteParams: substitudeMacros, saveChat: function () { return Promise.resolve(); },
      getCurrentChatId: function () { return 'preview'; }, onlineStatus: 'preview', mainApi: 'openai',
    };
  };
  window.SillyTavern = window.SillyTavern || { getContext: ctx };
  window.getContext = window.getContext || ctx;

  // ------------------------------------------------------------------ window.parent giả lập kiểu SillyTavern
  // Trong ST, iframe của Tavern Helper cùng origin nên card hay dùng window.parent.document (#send_textarea, #chat...).
  // Ở đây app khác origin (để bảo vệ khóa API) -> tạo "cửa sổ cha" giả có DOM giống ST.
  try {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    var pdoc = document.implementation.createHTMLDocument('SillyTavern');
    pdoc.body.innerHTML = '<div id="sheld"><div id="chat">' + chat.map(function (m, i) {
      return '<div class="mes" mesid="' + i + '" is_user="' + m.is_user + '" ch_name="' + esc(m.name) + '" swipeid="' + m.swipe_id + '"><div class="mes_block"><div class="ch_name"><span class="name_text">' + esc(m.name) + '</span></div><div class="mes_text">' + esc(m.message) + '</div></div></div>';
    }).join('') + '</div><div id="form_sheld"><form id="send_form"><textarea id="send_textarea"></textarea><div id="send_but" class="fa-solid fa-paper-plane"></div><div id="mes_stop"></div></form></div></div>' +
      '<div id="extensions_settings"></div><div id="extensions_settings2"></div><div id="left-nav-panel"></div><div id="right-nav-panel"></div><div id="movingDivs"></div><div id="bg1"></div>';
    var sendArea = pdoc.getElementById('send_textarea');
    var sendBtn = pdoc.getElementById('send_but');
    var doSend = function () {
      var v = String(sendArea.value || '');
      if (v.trim()) send('sendText', { text: v });
      sendArea.value = '';
    };
    sendBtn.addEventListener('click', doSend);
    sendArea.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault && e.preventDefault(); doSend(); } });
    var jq = function (sel, ctx) { return window.jQuery ? window.jQuery(sel, ctx || pdoc) : null; };
    var fakeParent = {
      document: pdoc,
      SillyTavern: window.SillyTavern, TavernHelper: TH, Mvu: Mvu, toastr: toastr,
      $: jq, jQuery: jq, _: window._, YAML: window.YAML,
      postMessage: function (msg, origin, transfer) { try { realParent.postMessage(msg, '*', transfer); } catch (e) { /* */ } },
      location: { href: 'http://127.0.0.1:8000/', origin: 'http://127.0.0.1:8000', host: '127.0.0.1:8000', hostname: '127.0.0.1', pathname: '/', search: '', hash: '', reload: function () {} },
      addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return true; },
      getComputedStyle: function (el) { try { return window.getComputedStyle(el); } catch (e) { return {}; } },
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      innerWidth: 1280, innerHeight: D.viewportHeight || 800, devicePixelRatio: window.devicePixelRatio || 1,
      console: window.console, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
      navigator: window.navigator, frames: [], length: 0, name: 'SillyTavern',
      eventSource: eventSource, event_types: tavern_events, getContext: ctx,
    };
    Object.keys(TH).forEach(function (k) { if (!(k in fakeParent)) fakeParent[k] = TH[k]; });
    fakeParent.window = fakeParent; fakeParent.self = fakeParent; fakeParent.parent = fakeParent; fakeParent.top = fakeParent;
    try { window.parent = fakeParent; } catch (e) { /* trình duyệt không cho thay */ }
    var fakeFrameEl = pdoc.createElement('iframe');
    fakeFrameEl.name = TH.getIframeName();
    try { Object.defineProperty(window, 'frameElement', { value: fakeFrameEl, configurable: true }); } catch (e) { /* */ }
  } catch (e) { /* bỏ qua: không giả lập được */ }

  send('ready', { origin: String(location.origin) });

  // ------------------------------------------------------------------ chiều cao tự động
  var lastH = 0;
  function reportHeight() {
    var b = document.body, h = 0;
    if (!b) return;
    h = Math.max(b.scrollHeight, b.offsetHeight, document.documentElement ? document.documentElement.offsetHeight : 0);
    var rect = b.getBoundingClientRect ? b.getBoundingClientRect() : null;
    if (rect) h = Math.max(h, Math.ceil(rect.height));
    if (Math.abs(h - lastH) > 1) { lastH = h; send('height', { height: h }); }
  }
  window.addEventListener('load', function () {
    reportHeight();
    if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
    setTimeout(reportHeight, 300); setTimeout(reportHeight, 1200);
    eventEmit(iframe_events.MESSAGE_IFRAME_RENDER_ENDED, TH.getIframeName());
  });
  document.addEventListener('DOMContentLoaded', reportHeight);
  window.addEventListener('error', function (e) { send('log', { level: 'error', message: String(e.message || e) + (e.lineno ? ' (dòng ' + e.lineno + ')' : '') }); });
  window.addEventListener('unhandledrejection', function (e) { send('log', { level: 'error', message: 'Promise: ' + String(e.reason && e.reason.message || e.reason) }); });
  // nhận cập nhật từ app
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__thHost) return;
    if (d.type === 'vars' && d.stat_data) { msgData(messageId).stat_data = d.stat_data; eventEmit(Mvu.events.VARIABLE_UPDATE_ENDED, msgData(messageId)); }
  });
})();
