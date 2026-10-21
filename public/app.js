/* ============================================================
   Codex Web — chat front-end
   Vanilla JS, no build step. Talks to /api/chat (SSE over POST).
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'codexweb.v1';
  var SAVE_DELAY = 260;

  var DEFAULT_INSTRUCTIONS = [
    '你是 Codex，一个编程助手，运行在用户的浏览器对话端。把自己当成和用户一起解决问题的同事。',
    '',
    '- 先给结论，再解释关键原因；语气自然、简洁，不要堆砌客套话。',
    '- 代码用带语言标注的 Markdown 代码块，命令给出可直接执行的形式。',
    '- 不确定的地方先说明假设，不要编造 API、文件内容或运行结果。',
    '- 中文提问用中文回答；专有名词、代码标识符保持原文。',
  ].join('\n');

  var SUGGESTED_PROMPTS = [];

  /* ---------------------------------------------------------- utilities --- */

  function $(id) { return document.getElementById(id); }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function nowTime() {
    var d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function relativeDay(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return nowTime();
    var y = new Date(today.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function duration(ms) {
    if (!ms || ms < 0) return '0.0s';
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  }

  function clampStyleText(s) { return String(s || ''); }

  function icon(name) {
    var paths = {
      copy: '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6.5 15H5a1.5 1.5 0 01-1.5-1.5v-8A1.5 1.5 0 015 4h8A1.5 1.5 0 0114.5 5.5V7" fill="none" stroke="currentColor" stroke-width="1.7"/>',
      retry: '<path d="M19 12a7 7 0 11-2.2-5.1M19 5v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      edit: '<path d="M4 20h4l10-10-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
      check: '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      warn: '<path d="M12 8v5m0 3.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 3.5L21 20H3L12 3.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
      chev: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    };
    return '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' + (paths[name] || '') + '</svg>';
  }

  function svgSize(html, size) {
    return html.replace('width="13" height="13"', 'width="' + size + '" height="' + size + '"');
  }

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /* --------------------------------------------------------------- state --- */

  var state = {
    boot: null,
    conversations: [],
    activeId: null,
    settings: {
      model: '',
      effort: '',
      instructions: DEFAULT_INSTRUCTIONS,
      autoCollapseReasoning: true,
      showUsage: true,
      typewriter: true,
    },
    streaming: null,
    pendingImages: [],
    search: '',
    refs: {},
  };

  var els = {};

  function activeConversation() {
    return state.conversations.find(function (c) { return c.id === state.activeId; }) || null;
  }

  function ensureConversation() {
    var conv = activeConversation();
    if (conv) return conv;
    conv = { id: uid(), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    return conv;
  }

  /* ------------------------------------------------------------ storage --- */

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || data.v !== 1) return;
      if (Array.isArray(data.conversations)) state.conversations = data.conversations;
      if (typeof data.activeId === 'string') state.activeId = data.activeId;
      if (data.settings && typeof data.settings === 'object') {
        Object.keys(state.settings).forEach(function (k) {
          if (data.settings[k] !== undefined) state.settings[k] = data.settings[k];
        });
      }
      // Never restore a half-streamed message.
      state.conversations.forEach(function (c) {
        c.messages.forEach(function (m) {
          if (m.status === 'streaming') m.status = 'stopped';
        });
      });
      state.streaming = null;
      if (!state.conversations.some(function (c) { return c.id === state.activeId; })) {
        state.activeId = state.conversations[0] ? state.conversations[0].id : null;
      }
    } catch (e) {
      console.warn('读取本地会话失败', e);
    }
  }

  var saveTimer = null;
  function saveStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushStore, SAVE_DELAY);
  }

  function flushStore() {
    var snapshot = {
      v: 1,
      activeId: state.activeId,
      settings: state.settings,
      conversations: state.conversations.slice(0, 60).map(function (c) {
        return {
          id: c.id,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messages: c.messages.slice(-200),
        };
      }),
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
      return;
    } catch (e) {
      // Image payloads can blow the quota; retry without them.
      try {
        snapshot.conversations.forEach(function (c) {
          c.messages.forEach(function (m) { delete m.images; });
        });
        localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
        state.conversations.forEach(function (c) {
          c.messages.forEach(function (m) { if (m.images) m.images = m.images.slice(); });
        });
      } catch (e2) {
        console.warn('本地存储写入失败', e2);
      }
    }
  }

  /* --------------------------------------------------------------- boot --- */

  function init() {
    cacheEls();
    loadStore();
    bindEvents();
    populateStaticUI();
    bootRequest();
  }

  function cacheEls() {
    [
      'app', 'sidebar', 'closeSidebar', 'openSidebar', 'scrim', 'newChat', 'search', 'chatList',
      'sideMeta', 'connDot', 'providerLabel', 'chatTitle', 'chatSub', 'modelSelect', 'effortSelect',
      'exportBtn', 'settingsBtn', 'viewport', 'thread', 'empty', 'emptySub', 'chips', 'toBottom',
      'composer', 'input', 'thumbs', 'attachBtn', 'fileInput', 'composerHint', 'streamState',
      'sendBtn', 'footModel', 'settingsDialog', 'instructionsInput', 'resetInstructions',
      'instructionsCount', 'optAutoCollapse', 'optShowUsage', 'optTypewriter', 'infoEndpoint',
      'infoProvider', 'infoConfig', 'infoKey', 'saveSettings', 'settingsForm', 'toast',
    ].forEach(function (id) { els[id] = $(id); });
  }

  function populateStaticUI() {
    els.input.value = '';
    els.instructionsInput.value = state.settings.instructions;
    els.optAutoCollapse.checked = state.settings.autoCollapseReasoning !== false;
    els.optShowUsage.checked = state.settings.showUsage !== false;
    els.optTypewriter.checked = state.settings.typewriter !== false;
    updateInstructionsCount();

    els.chips.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      els.input.value = chip.getAttribute('data-prompt') || '';
      resizeInput();
      els.input.focus();
      send();
    });
  }

  function bootRequest() {
    renderSidebar();
    renderThread();
    fetch('./api/bootstrap')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (boot) {
        state.boot = boot;
        if (!state.settings.model) state.settings.model = boot.defaultModel;
        if (!state.settings.effort) state.settings.effort = boot.defaultEffort;
        if (boot.models.every(function (m) { return m.slug !== state.settings.model; })) {
          state.settings.model = boot.defaultModel;
        }
        applyBootUI(boot);
        maybeSeedDemo();
        renderSidebar();
        renderThread();
        saveStore();
      })
      .catch(function (err) {
        els.connDot.className = 'dot err';
        els.providerLabel.textContent = '服务端未连接';
        els.emptySub.textContent = '无法读取服务端配置：' + err.message + '（请确认 node server.mjs 正在运行）';
        toast('无法连接本地服务端，请检查启动窗口', true);
      });
  }

  function applyBootUI(boot) {
    els.connDot.className = 'dot ' + (boot.provider.hasKey ? 'ok' : 'warn');
    els.providerLabel.textContent = boot.provider.name + (boot.provider.hasKey ? ' · 已连接' : ' · 缺少 API Key');
    els.footModel.textContent = state.settings.model + ' · ' + state.settings.effort;

    buildModelSelect(boot);
    buildEffortSelect(boot);
    updateEmptySub();
    updateComposerHint();

    els.infoEndpoint.textContent = boot.endpoint;
    els.infoProvider.textContent = boot.provider.name + ' (' + boot.provider.baseUrl + ') · wire ' + boot.provider.wireApi;
    els.infoConfig.textContent = boot.configFound ? boot.configPath : boot.configPath + '（未找到，使用默认值）';
    els.infoKey.textContent = boot.provider.hasKey ? '已从 ' + (boot.provider.keySource || '配置') + ' 读取（仅服务端可见）' : '缺少 API Key';
  }

  function buildModelSelect(boot) {
    var sel = els.modelSelect;
    sel.innerHTML = '';
    var groups = {};
    boot.models.forEach(function (m) {
      var key = m.inputModalities.indexOf('image') >= 0 ? '支持图片' : '文本模型';
      groups[key] = groups[key] || [];
      groups[key].push(m);
    });
    Object.keys(groups).forEach(function (label) {
      var og = document.createElement('optgroup');
      og.label = label;
      groups[label].forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.slug;
        opt.textContent = m.displayName;
        if (m.slug === state.settings.model) opt.selected = true;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    if (!sel.value) sel.value = boot.defaultModel;
    sel.disabled = false;
  }

  function buildEffortSelect(boot) {
    var model = currentModelMeta();
    var levels = (model && model.reasoningLevels) || [
      { effort: 'low', description: '更快' },
      { effort: 'high', description: '更深' },
      { effort: 'max', description: '最深' },
    ];
    var labels = { low: '低 · 更快', high: '高 · 更深', max: '最深 · 最强' };
    var sel = els.effortSelect;
    sel.innerHTML = '';
    levels.forEach(function (l) {
      var opt = document.createElement('option');
      opt.value = l.effort;
      opt.textContent = labels[l.effort] || l.effort;
      opt.title = l.description || '';
      sel.appendChild(opt);
    });
    var has = levels.some(function (l) { return l.effort === state.settings.effort; });
    if (!has) state.settings.effort = (model && model.defaultReasoningLevel) || levels[0].effort;
    sel.value = state.settings.effort;
  }

  function currentModelMeta() {
    if (!state.boot) return null;
    return state.boot.models.find(function (m) { return m.slug === state.settings.model; }) || null;
  }

  function modelSupportsImages(slug) {
    if (!state.boot) return true;
    var m = state.boot.models.find(function (x) { return x.slug === slug; });
    return !m || m.inputModalities.indexOf('image') >= 0;
  }

  function updateEmptySub() {
    if (!state.boot) return;
    var provider = state.boot.provider.name;
    els.emptySub.textContent = '已连接 ' + provider + ' · ' + state.settings.model + ' · 与 Codex CLI 共用同一份配置';
  }

  function updateComposerHint() {
    if (state.pendingImages.length) {
      els.composerHint.textContent = state.pendingImages.length + ' 张图片 · 将随消息发送';
    } else if (!modelSupportsImages(state.settings.model)) {
      els.composerHint.textContent = '当前模型不支持图片，可切换到 Vision 模型后附带截图';
    } else {
      els.composerHint.textContent = 'Enter 发送 · Shift+Enter 换行';
    }
  }

  /* -------------------------------------------------------------- events --- */

  function bindEvents() {
    els.newChat.addEventListener('click', newConversation);
    els.search.addEventListener('input', function () {
      state.search = els.search.value.trim().toLowerCase();
      renderSidebar();
    });

    els.composer.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    els.sendBtn.addEventListener('click', function (e) {
      if (state.streaming) { e.preventDefault(); stopStreaming(); }
    });

    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        send();
      }
    });
    els.input.addEventListener('input', resizeInput);
    els.input.addEventListener('paste', handlePaste);

    els.attachBtn.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      addImages(Array.prototype.slice.call(els.fileInput.files || []));
      els.fileInput.value = '';
    });
    els.composer.addEventListener('dragover', function (e) {
      e.preventDefault();
      els.composer.classList.add('dragging');
    });
    els.composer.addEventListener('dragleave', function () { els.composer.classList.remove('dragging'); });
    els.composer.addEventListener('drop', function (e) {
      e.preventDefault();
      els.composer.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files) addImages(Array.prototype.slice.call(e.dataTransfer.files));
    });

    els.modelSelect.addEventListener('change', function () {
      state.settings.model = els.modelSelect.value;
      buildEffortSelect(state.boot);
      updateEmptySub();
      updateComposerHint();
      els.footModel.textContent = state.settings.model + ' · ' + state.settings.effort;
      saveStore();
    });
    els.effortSelect.addEventListener('change', function () {
      state.settings.effort = els.effortSelect.value;
      els.footModel.textContent = state.settings.model + ' · ' + state.settings.effort;
      saveStore();
    });

    els.exportBtn.addEventListener('click', exportConversation);
    els.settingsBtn.addEventListener('click', openSettings);

    els.instructionsInput.addEventListener('input', updateInstructionsCount);
    els.resetInstructions.addEventListener('click', function () {
      els.instructionsInput.value = DEFAULT_INSTRUCTIONS;
      updateInstructionsCount();
    });
    els.settingsForm.addEventListener('submit', function (e) {
      if (e.submitter !== els.saveSettings) return; // 取消 / 关闭：不保存
      state.settings.instructions = els.instructionsInput.value;
      state.settings.autoCollapseReasoning = els.optAutoCollapse.checked;
      state.settings.showUsage = els.optShowUsage.checked;
      state.settings.typewriter = els.optTypewriter.checked;
      saveStore();
      renderThread();
      toast('设置已保存');
    });

    els.viewport.addEventListener('scroll', function () {
      updateToBottom();
    });
    els.toBottom.addEventListener('click', function () { scrollToBottom(true); });

    // mobile drawer
    els.openSidebar.addEventListener('click', openDrawer);
    els.closeSidebar.addEventListener('click', closeDrawer);
    els.scrim.addEventListener('click', closeDrawer);

    // delegated actions inside the thread
    els.thread.addEventListener('click', onThreadClick);

    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        newConversation();
      } else if (e.key === 'Escape' && state.streaming) {
        stopStreaming();
      }
    });

    window.addEventListener('beforeunload', function () {
      if (state.streaming) {
        state.streaming.controller.abort();
      }
      clearTimeout(saveTimer);
      flushStore();
    });
  }

  function resizeInput() {
    var ta = els.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 216) + 'px';
  }

  function handlePaste(e) {
    if (!e.clipboardData) return;
    var items = Array.prototype.slice.call(e.clipboardData.items || []);
    var files = items
      .filter(function (it) { return it.kind === 'file' && it.type.indexOf('image/') === 0; })
      .map(function (it) { return it.getAsFile(); })
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addImages(files);
    }
  }

  function updateInstructionsCount() {
    var n = els.instructionsInput.value.length;
    els.instructionsCount.textContent = n + ' 字符';
  }

  /* --------------------------------------------------------------- images --- */

  function addImages(files) {
    var accepted = files.filter(function (f) { return f && f.type.indexOf('image/') === 0; });
    if (!accepted.length) return;
    if (!state.boot) { toast('服务端配置尚未加载完成', true); return; }

    if (!modelSupportsImages(state.settings.model)) {
      var vision = state.boot.models.find(function (m) { return m.inputModalities.indexOf('image') >= 0; });
      if (vision) {
        state.settings.model = vision.slug;
        els.modelSelect.value = vision.slug;
        buildEffortSelect(state.boot);
        els.footModel.textContent = vision.slug + ' · ' + state.settings.effort;
        toast('已切换到 ' + vision.displayName + ' 以支持图片输入');
      } else {
        toast('当前模型不支持图片输入', true);
        return;
      }
    }

    var remaining = 4 - state.pendingImages.length;
    accepted.slice(0, remaining).forEach(function (file) {
      if (file.size > 6 * 1024 * 1024) { toast('单张图片请控制在 6MB 以内', true); return; }
      var reader = new FileReader();
      reader.onload = function () {
        state.pendingImages.push({ name: file.name || 'image', dataUrl: String(reader.result) });
        renderThumbs();
        updateComposerHint();
      };
      reader.readAsDataURL(file);
    });
    if (accepted.length > remaining) toast('最多一次发送 4 张图片');
  }

  function renderThumbs() {
    var wrap = els.thumbs;
    wrap.innerHTML = '';
    if (!state.pendingImages.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    state.pendingImages.forEach(function (img, idx) {
      var div = document.createElement('div');
      div.className = 'thumb';
      var el = document.createElement('img');
      el.src = img.dataUrl;
      el.alt = img.name;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.title = '移除图片';
      btn.addEventListener('click', function () {
        state.pendingImages.splice(idx, 1);
        renderThumbs();
        updateComposerHint();
      });
      div.appendChild(el);
      div.appendChild(btn);
      wrap.appendChild(div);
    });
  }

  /* ----------------------------------------------------------- streaming --- */

  function setStreamingUI(on) {
    var btn = els.sendBtn;
    btn.classList.toggle('stop', on);
    btn.querySelector('.send-label').textContent = on ? '停止' : '发送';
    btn.title = on ? '停止生成 (Esc)' : '发送';
    els.input.disabled = false;
    if (!on) {
      els.streamState.textContent = '';
      els.streamState.dataset.started = '';
    }
  }

  function send() {
    if (state.streaming) { stopStreaming(); return; }
    if (!state.boot) { toast('服务端尚未就绪', true); return; }

    var text = els.input.value.trim();
    var images = state.pendingImages.map(function (i) { return i.dataUrl; });
    if (!text && !images.length) return;

    var conv = ensureConversation();
    var userMsg = {
      id: uid(), role: 'user', content: text, images: images, ts: Date.now(), status: 'done',
    };
    conv.messages.push(userMsg);
    conv.updatedAt = Date.now();
    if (conv.messages.filter(function (m) { return m.role === 'user'; }).length === 1) {
      conv.title = titleFrom(text || '图片对话');
    }

    els.input.value = '';
    resizeInput();
    state.pendingImages = [];
    renderThumbs();
    updateComposerHint();

    var asst = {
      id: uid(), role: 'assistant', content: '', reasoning: '', ts: Date.now(),
      status: 'streaming', model: state.settings.model, effort: state.settings.effort,
      startedAt: Date.now(), usage: null,
    };
    conv.messages.push(asst);

    renderSidebar();
    renderThread();
    scrollToBottom(true);
    runStream(conv, asst);
  }

  function titleFrom(text) {
    var clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return '新对话';
    return clean.length > 26 ? clean.slice(0, 26) + '…' : clean;
  }

  async function runStream(conv, asst) {
    var controller = new AbortController();
    var startedAt = Date.now();
    state.streaming = { controller: controller, convId: conv.id, msgId: asst.id, startedAt: startedAt };
    setStreamingUI(true);
    startStreamTimer(asst, startedAt);

    var history = conv.messages
      .filter(function (m) { return m.id !== asst.id && m.status !== 'error'; })
      .map(function (m) {
        var out = { role: m.role, content: m.content || '' };
        if (m.role === 'user' && m.images && m.images.length) out.images = m.images;
        return out;
      });

    try {
      var res = await fetch('./api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: asst.model,
          effort: asst.effort,
          instructions: (state.settings.instructions || '').trim(),
          messages: history,
        }),
      });

      if (!res.ok) {
        var message = 'HTTP ' + res.status;
        try {
          var j = await res.json();
          if (j && j.error) message = j.error;
        } catch (e) { /* ignore */ }
        asst.status = 'error';
        asst.error = message;
      } else {
        await consumeStream(res, asst);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') asst.status = 'stopped';
      else {
        asst.status = 'error';
        asst.error = (err && err.message) || String(err);
      }
    } finally {
      stopStreamTimer();
      if (flushHandle) { cancelAnimationFrame(flushHandle); flushHandle = null; }
      flushFlags.reasoning = false;
      flushFlags.text = false;
      if (asst.status === 'streaming') asst.status = 'done';
      asst.ms = Date.now() - startedAt;
      state.streaming = null;
      conv.updatedAt = Date.now();
      setStreamingUI(false);
      refreshMessageNode(asst);
      renderSidebar();
      saveStore();
      if (isNearBottom()) scrollToBottom(true);
    }
  }

  async function consumeStream(res, asst) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var sawText = false;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var sep;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        var raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        var lines = raw.split('\n');
        var dataLines = [];
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('data:') === 0) dataLines.push(lines[i].slice(5).trim());
        }
        if (!dataLines.length) continue;
        var ev;
        try { ev = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }

        if (ev.type === 'start') {
          if (ev.model) asst.model = ev.model;
          if (ev.effort) asst.effort = ev.effort;
        } else if (ev.type === 'reasoning.delta') {
          asst.reasoning = (asst.reasoning || '') + ev.text;
          scheduleFlush(true);
        } else if (ev.type === 'text.delta') {
          if (!sawText && state.settings.autoCollapseReasoning) collapseReasoning(asst);
          sawText = true;
          asst.content = (asst.content || '') + ev.text;
          scheduleFlush(false);
        } else if (ev.type === 'complete') {
          asst.usage = ev.usage || null;
          asst.status = ev.status === 'incomplete' ? 'incomplete' : 'done';
          asst.responseId = ev.responseId || null;
        } else if (ev.type === 'error') {
          asst.status = 'error';
          asst.error = ev.message || '生成失败';
        } else if (ev.type === 'aborted') {
          asst.status = 'stopped';
        }
      }
    }
  }

  var flushHandle = null;
  var flushFlags = { reasoning: false, text: false };

  function scheduleFlush(reasoningOnly) {
    flushFlags.reasoning = true;
    if (!reasoningOnly) flushFlags.text = true;
    if (flushHandle) return;
    flushHandle = requestAnimationFrame(function () {
      flushHandle = null;
      var conv = activeConversation();
      if (!conv) return;
      var asst = conv.messages[conv.messages.length - 1];
      if (!asst || asst.role !== 'assistant') return;
      paintStreamingMessage(asst);
      if (flushFlags.text && isNearBottom()) scrollToBottom(false);
      flushFlags.reasoning = false;
      flushFlags.text = false;
    });
  }

  function paintStreamingMessage(asst) {
    // A rAF may still be queued for the frame in which the stream finished.
    if (!asst || asst.status !== 'streaming') return;
    var ref = state.refs[asst.id];
    if (!ref) return;

    if (ref.reasoningBody && asst.reasoning) {
      if (ref.reasoningBody.textContent !== asst.reasoning) {
        ref.reasoningBody.textContent = asst.reasoning;
        ref.reasoningBody.scrollTop = ref.reasoningBody.scrollHeight;
      }
      updateReasoningSummary(asst, ref);
    }

    if (ref.md) {
      var html = Markdown.render(asst.content || '');
      if (ref.md.dataset.length !== String((asst.content || '').length) || ref.dirtyForced) {
        ref.md.dataset.length = String((asst.content || '').length);
        ref.md.innerHTML = html + (state.settings.typewriter ? '<span class="caret"></span>' : '');
      }
    }

    if (ref.status) {
      var mode = (asst.content || '').trim()
        ? 'none'
        : ((asst.reasoning || '').trim() ? 'thinking' : 'wait');
      if (ref.statusMode !== mode) {
        ref.statusMode = mode;
        if (mode === 'none') {
          ref.status.innerHTML = '';
          ref.status.style.display = 'none';
        } else {
          ref.status.style.display = 'flex';
          ref.status.innerHTML = mode === 'wait'
            ? '<span class="spin"></span><span>正在思考…</span>'
            : '<span class="spin"></span><span>思考中…</span>';
        }
      }
    }

    if (asst.reasoning) {
      updateReasoningSummary(asst, ref);
      if (ref.reasoningWrap && !ref.userToggled && state.settings.autoCollapseReasoning) {
        // keep open while only reasoning exists
        ref.reasoningWrap.open = true;
      }
    }
  }

  function updateReasoningSummary(asst, ref) {
    if (!ref.reasoningLabel) return;
    var secs = ((Date.now() - (asst.startedAt || Date.now())) / 1000).toFixed(1);
    var label = '思考过程';
    if (asst.status === 'streaming' && !(asst.content || '').trim()) {
      label += ' · ' + secs + 's';
      ref.reasoningLabel.innerHTML = '<span class="thinking-dots"><i></i><i></i><i></i></span>' + label;
    } else if (asst.status === 'streaming') {
      label += ' · 已完成思考';
      ref.reasoningLabel.textContent = label;
    } else if (asst.ms) {
      label += ' · ' + duration(asst.ms);
      ref.reasoningLabel.textContent = label;
    } else {
      ref.reasoningLabel.textContent = label;
    }
  }

  function collapseReasoning(asst) {
    var ref = state.refs[asst.id];
    if (!ref || !ref.reasoningWrap) return;
    if (ref.userToggled) return;
    ref.reasoningWrap.open = false;
  }

  var streamTimer = null;
  function startStreamTimer(asst, startedAt) {
    stopStreamTimer();
    streamTimer = setInterval(function () {
      var conv = activeConversation();
      if (!conv || !state.streaming) return;
      var elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      var chars = (asst.content || '').length;
      els.streamState.textContent = chars
        ? '生成中 · ' + chars + ' 字符 · ' + elapsed + 's'
        : '思考中 · ' + elapsed + 's';
      var ref = state.refs[asst.id];
      if (ref) updateReasoningSummary(asst, ref);
    }, 250);
  }

  function stopStreamTimer() {
    clearInterval(streamTimer);
    streamTimer = null;
  }

  function stopStreaming() {
    if (!state.streaming) return;
    state.streaming.controller.abort();
  }

  /* -------------------------------------------------------------- render --- */

  function renderSidebar() {
    var list = els.chatList;
    list.innerHTML = '';
    var convs = state.conversations.slice();
    if (state.search) {
      convs = convs.filter(function (c) {
        if (c.title.toLowerCase().indexOf(state.search) >= 0) return true;
        return c.messages.some(function (m) { return (m.content || '').toLowerCase().indexOf(state.search) >= 0; });
      });
    }

    if (!convs.length) {
      var empty = document.createElement('div');
      empty.className = 'chat-list-empty';
      empty.textContent = state.search ? '没有匹配的对话' : '还没有对话，点上面新建一个';
      list.appendChild(empty);
      return;
    }

    convs.forEach(function (conv) {
      var item = document.createElement('div');
      item.className = 'chat-item' + (conv.id === state.activeId ? ' active' : '');
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.dataset.convId = conv.id;

      var title = document.createElement('span');
      title.className = 'chat-item-title';
      title.textContent = conv.title || '新对话';
      title.title = conv.title || '新对话';

      var when = document.createElement('span');
      when.className = 'chat-item-when';
      when.textContent = relativeDay(conv.updatedAt || conv.createdAt);
      when.style.cssText = 'font-size:10.5px;color:var(--text-mute);flex:none;';
      if (conv.id === state.activeId) when.style.display = 'none';

      var del = document.createElement('button');
      del.className = 'chat-item-del';
      del.type = 'button';
      del.title = '删除对话';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteConversation(conv.id);
      });

      item.appendChild(title);
      item.appendChild(when);
      item.appendChild(del);
      item.addEventListener('click', function () { switchConversation(conv.id); });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchConversation(conv.id); }
      });
      list.appendChild(item);
    });
  }

  function renderThread() {
    var conv = activeConversation();
    var thread = els.thread;
    thread.innerHTML = '';
    state.refs = {};

    var messages = conv ? conv.messages : [];
    var visible = messages.filter(function (m) { return m.role === 'user' || m.content || m.reasoning || m.status === 'streaming' || m.status === 'error'; });

    visible.forEach(function (msg) {
      var node = buildMessageNode(msg, conv);
      thread.appendChild(node);
    });

    els.empty.hidden = !!(conv && conv.messages.length);
    els.chatTitle.textContent = conv ? conv.title : '新对话';
    els.chatSub.textContent = conv && conv.messages.length
      ? state.settings.model + ' · 思考 ' + state.settings.effort + ' · ' + conv.messages.filter(function (m) { return m.role === 'user'; }).length + ' 轮对话'
      : '与 Codex 一起写代码';

    if (conv && messages.length) {
      var last = messages[messages.length - 1];
      if (last.status === 'streaming') {
        startStreamTimer(last, last.startedAt || Date.now());
      }
    }
    updateToBottom();
  }

  function buildMessageNode(msg, conv) {
    var root = document.createElement('div');
    root.className = 'msg ' + msg.role;
    root.dataset.msgId = msg.id;

    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'C';
    if (msg.role !== 'user') root.appendChild(avatar);

    var body = document.createElement('div');
    body.className = 'body';
    root.appendChild(body);

    var meta = document.createElement('div');
    meta.className = 'meta';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.role === 'user' ? '你' : 'Codex';
    meta.appendChild(who);

    if (msg.role === 'assistant' && msg.model) {
      var tag = document.createElement('span');
      tag.className = 'model-tag';
      tag.textContent = msg.model + (msg.effort ? ' · ' + msg.effort : '');
      if (msg.effort) tag.classList.add('effort-tag');
      meta.appendChild(tag);
    }

    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = msg.ts ? new Date(msg.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    meta.appendChild(ts);
    body.appendChild(meta);

    var ref = { root: root, body: body };

    if (msg.role === 'user') {
      var bubbleWrap = document.createElement('div');
      if (msg.images && msg.images.length) {
        var imgs = document.createElement('div');
        imgs.className = 'bubble-images';
        msg.images.forEach(function (src) {
          var img = document.createElement('img');
          img.src = src;
          img.alt = '附带的图片';
          img.addEventListener('click', function () { openImage(src); });
          imgs.appendChild(img);
        });
        bubbleWrap.appendChild(imgs);
      }
      if (msg.content) {
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = msg.content;
        bubbleWrap.appendChild(bubble);
      }
      body.appendChild(bubbleWrap);
    } else {
      if (msg.reasoning) {
        var details = document.createElement('details');
        details.className = 'reasoning';
        var summary = document.createElement('summary');
        var chev = document.createElement('span');
        chev.className = 'chev';
        chev.innerHTML = svgSize(icon('chev'), 12);
        var label = document.createElement('span');
        label.className = 'reasoning-label';
        label.textContent = '思考过程' + (msg.ms ? ' · ' + duration(msg.ms) : '');
        summary.appendChild(chev);
        summary.appendChild(label);
        details.appendChild(summary);

        var rbody = document.createElement('div');
        rbody.className = 'reasoning-body';
        rbody.textContent = msg.reasoning;
        details.appendChild(rbody);

        details.addEventListener('toggle', function () {
          ref.userToggled = true;
        });

        details.open = msg.status === 'streaming' && !msg.content;
        body.appendChild(details);
        ref.reasoningWrap = details;
        ref.reasoningLabel = label;
        ref.reasoningBody = rbody;
      }

      var status = document.createElement('div');
      status.className = 'status-line';
      if (msg.status === 'streaming') {
        if ((msg.content || '').trim()) {
          status.style.display = 'none';
        } else {
          status.innerHTML = '<span class="spin"></span><span>正在思考…</span>';
          ref.statusMode = 'wait';
        }
      } else {
        status.style.display = 'none';
      }
      body.appendChild(status);
      ref.status = status;

      var md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = Markdown.render(msg.content || '');
      body.appendChild(md);
      ref.md = md;

      if (msg.status === 'streaming' && state.settings.typewriter) {
        md.innerHTML = Markdown.render(msg.content || '') + '<span class="caret"></span>';
      }

      if (msg.status === 'error') {
        var errBox = document.createElement('div');
        errBox.className = 'error-box';
        errBox.innerHTML = '<span class="err-icon">' + svgSize(icon('warn'), 15) + '</span>'
          + '<div class="err-text">' + Markdown.escapeHtml(msg.error || '生成失败') + '</div>';
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry-btn';
        retry.textContent = '重试';
        retry.addEventListener('click', function () { regenerate(msg.id); });
        errBox.appendChild(retry);
        body.appendChild(errBox);
      }

      if (msg.status === 'stopped') {
        var stopped = document.createElement('div');
        stopped.className = 'status-line';
        stopped.innerHTML = '<span>已停止生成</span>';
        body.appendChild(stopped);
      }

      var actions = document.createElement('div');
      actions.className = 'msg-actions' + (msg.status === 'streaming' ? '' : ' visible');

      actions.appendChild(actionButton('copy', '复制', function () {
        copyText(msg.content || '').then(function () { toast('已复制'); });
      }));
      if (msg.status !== 'streaming') {
        actions.appendChild(actionButton('retry', '重新生成', function () { regenerate(msg.id); }));
      }
      if (msg.usage && state.settings.showUsage !== false) {
        var usage = document.createElement('span');
        usage.className = 'usage';
        usage.textContent = 'in ' + msg.usage.input + ' · out ' + msg.usage.output
          + (msg.usage.reasoning ? ' (think ' + msg.usage.reasoning + ')' : '')
          + (msg.ms ? ' · ' + duration(msg.ms) : '');
        usage.title = 'Token 用量：输入 ' + msg.usage.input + '，输出 ' + msg.usage.output
          + '（其中思考 ' + (msg.usage.reasoning || 0) + '），缓存命中 ' + (msg.usage.cached || 0);
        actions.appendChild(usage);
      }
      body.appendChild(actions);
      ref.actions = actions;
    }

    if (msg.role === 'user' && msg.status !== 'streaming') {
      var uactions = document.createElement('div');
      uactions.className = 'msg-actions';
      uactions.appendChild(actionButton('edit', '编辑', function () { editUserMessage(msg.id); }));
      uactions.appendChild(actionButton('copy', '复制', function () {
        copyText(msg.content || '').then(function () { toast('已复制'); });
      }));
      body.appendChild(uactions);
    }

    state.refs[msg.id] = ref;
    return root;
  }

  function actionButton(name, label, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'act-btn';
    btn.innerHTML = svgSize(icon(name), 13) + '<span>' + label + '</span>';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function refreshMessageNode(msg) {
    var ref = state.refs[msg.id];
    if (!ref || !ref.root.parentNode) return;
    var conv = activeConversation();
    var fresh = buildMessageNode(msg, conv);
    ref.root.parentNode.replaceChild(fresh, ref.root);
  }

  function openImage(src) {
    var w = window.open('', '_blank');
    if (!w) return;
    w.document.write('<title>图片</title><body style="margin:0;background:#0a0c10;display:grid;place-items:center;min-height:100vh"><img src="' + src + '" style="max-width:100%;max-height:100vh"></body>');
    w.document.close();
  }

  /* ------------------------------------------------------------- actions --- */

  function onThreadClick(e) {
    var copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      var block = copyBtn.closest('.code-block');
      var code = block ? block.querySelector('pre code') : null;
      if (!code) return;
      copyText(code.textContent).then(function () {
        copyBtn.classList.add('copied');
        copyBtn.textContent = '已复制';
        setTimeout(function () {
          copyBtn.classList.remove('copied');
          copyBtn.textContent = '复制';
        }, 1600);
      });
      return;
    }
  }

  function newConversation() {
    if (state.streaming) stopStreaming();
    // Reuse an empty conversation instead of piling up blanks.
    var empty = state.conversations.find(function (c) { return c.messages.length === 0; });
    if (empty) {
      state.activeId = empty.id;
    } else {
      var conv = { id: uid(), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      state.conversations.unshift(conv);
      state.activeId = conv.id;
    }
    els.search.value = '';
    state.search = '';
    els.input.value = '';
    resizeInput();
    renderSidebar();
    renderThread();
    saveStore();
    closeDrawer();
    els.input.focus();
  }

  function switchConversation(id) {
    if (state.streaming) stopStreaming();
    state.activeId = id;
    renderSidebar();
    renderThread();
    scrollToBottom(true);
    closeDrawer();
    saveStore();
  }

  function deleteConversation(id) {
    if (state.streaming && state.streaming.convId === id) stopStreaming();
    state.conversations = state.conversations.filter(function (c) { return c.id !== id; });
    if (state.activeId === id) {
      state.activeId = state.conversations[0] ? state.conversations[0].id : null;
    }
    renderSidebar();
    renderThread();
    saveStore();
  }

  function regenerate(msgId) {
    if (state.streaming) return;
    var conv = activeConversation();
    if (!conv) return;
    var idx = conv.messages.findIndex(function (m) { return m.id === msgId; });
    if (idx < 0) return;

    // Drop the assistant message (and anything after it) and ask again.
    conv.messages.splice(idx);
    var asst = {
      id: uid(), role: 'assistant', content: '', reasoning: '', ts: Date.now(),
      status: 'streaming', model: state.settings.model, effort: state.settings.effort,
      startedAt: Date.now(), usage: null,
    };
    conv.messages.push(asst);
    renderThread();
    scrollToBottom(true);
    runStream(conv, asst);
  }

  function editUserMessage(msgId) {
    if (state.streaming) return;
    var conv = activeConversation();
    if (!conv) return;
    var idx = conv.messages.findIndex(function (m) { return m.id === msgId; });
    if (idx < 0) return;
    var msg = conv.messages[idx];
    els.input.value = msg.content || '';
    state.pendingImages = (msg.images || []).map(function (dataUrl, i) {
      return { name: 'image-' + (i + 1), dataUrl: dataUrl };
    });
    renderThumbs();
    updateComposerHint();
    conv.messages.splice(idx);
    renderThread();
    saveStore();
    resizeInput();
    els.input.focus();
    toast('已载入原消息，可修改后重新发送');
  }

  function exportConversation() {
    var conv = activeConversation();
    if (!conv || !conv.messages.length) { toast('当前没有可导出的对话'); return; }
    var lines = ['# ' + (conv.title || 'Codex 对话'), ''];
    lines.push('> 模型：' + state.settings.model + ' · 思考强度：' + state.settings.effort);
    lines.push('> 导出时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('');
    conv.messages.forEach(function (m) {
      if (m.role === 'user') {
        lines.push('## 你');
        lines.push('');
        lines.push(m.content || '（图片）');
      } else {
        lines.push('## Codex');
        if (m.reasoning) {
          lines.push('');
          lines.push('<details><summary>思考过程</summary>');
          lines.push('');
          lines.push(m.reasoning);
          lines.push('');
          lines.push('</details>');
        }
        lines.push('');
        lines.push(m.content || '');
      }
      lines.push('');
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (conv.title || 'codex-chat').replace(/[\\/:*?"<>|]/g, '_') + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 600);
    toast('已导出 Markdown');
  }

  /* ------------------------------------------------------- settings / misc --- */

  function openSettings() {
    els.instructionsInput.value = state.settings.instructions || '';
    els.optAutoCollapse.checked = state.settings.autoCollapseReasoning !== false;
    els.optShowUsage.checked = state.settings.showUsage !== false;
    els.optTypewriter.checked = state.settings.typewriter !== false;
    updateInstructionsCount();
    if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal();
  }

  function openDrawer() {
    els.sidebar.classList.add('open');
    els.scrim.hidden = false;
  }

  function closeDrawer() {
    els.sidebar.classList.remove('open');
    els.scrim.hidden = true;
  }

  function isNearBottom() {
    var v = els.viewport;
    return v.scrollHeight - v.scrollTop - v.clientHeight < 140;
  }

  function scrollToBottom(smooth) {
    var v = els.viewport;
    v.scrollTo({ top: v.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    updateToBottom();
  }

  function updateToBottom() {
    var v = els.viewport;
    var far = v.scrollHeight - v.scrollTop - v.clientHeight > 260;
    els.toBottom.hidden = !far;
  }

  /* ----------------------------------------------------------- demo seed --- */

  function maybeSeedDemo() {
    var params = new URLSearchParams(location.search);
    if (params.get('demo') !== '1') return;
    if (state.conversations.length) return;

    var conv = {
      id: uid(),
      title: '用 TS 写一个带重试的 fetch 封装',
      createdAt: Date.now() - 600000,
      updatedAt: Date.now() - 60000,
      messages: [
        {
          id: uid(), role: 'user', ts: Date.now() - 600000, status: 'done',
          content: '帮我写一个带指数退避重试的 fetch 封装，要求支持超时、可取消，并且只在 5xx / 网络错误时重试。',
          images: [],
        },
        {
          id: uid(), role: 'assistant', ts: Date.now() - 590000, status: 'done',
          model: state.settings.model || 'deepseek-v4-pro',
          effort: state.settings.effort || 'high',
          ms: 8400,
          usage: { input: 812, output: 964, reasoning: 421, cached: 0, total: 1776 },
          reasoning: '用户要一个 fetch 封装：指数退避、超时、可取消、只对 5xx 与网络错误重试。\n先确定接口形态 fetchRetry(url, init & { retries, baseDelay, timeout, onRetry })，内部用 AbortController 合并外部 signal 与超时 signal；4xx 不重试；退避用 baseDelay * 2^n 加随机抖动。',
          content: [
            '先给结论：**4xx 一律不重试**，只重试网络错误与 5xx，退避用 `baseDelay * 2^n` 再加抖动，避免重试风暴。',
            '',
            '```ts',
            'export interface RetryOptions {',
            '  retries?: number;      // 最大重试次数，默认 3',
            '  baseDelay?: number;    // 首次退避基数，默认 300ms',
            '  timeout?: number;      // 单次请求超时，默认 10s',
            '  onRetry?: (attempt: number, delay: number, err: unknown) => void;',
            '}',
            '',
            'export class FetchError extends Error {',
            '  constructor(message: string, readonly response?: Response, readonly cause?: unknown) {',
            '    super(message);',
            '  }',
            '}',
            '',
            'const RETRYABLE = (status: number) => status >= 500 && status < 600;',
            '',
            'export async function fetchRetry(',
            '  input: RequestInfo | URL,',
            '  init: RequestInit & RetryOptions = {},',
            ') {',
            '  const { retries = 3, baseDelay = 300, timeout = 10_000, onRetry, signal, ...rest } = init;',
            '',
            '  for (let attempt = 0; attempt <= retries; attempt++) {',
            '    const ctrl = new AbortController();',
            '    const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeout);',
            '    const abort = () => ctrl.abort(signal?.reason);',
            '    signal?.addEventListener("abort", abort);',
            '',
            '    try {',
            '      const res = await fetch(input, { ...rest, signal: ctrl.signal });',
            '      if (!RETRYABLE(res.status)) return res;',
            '      if (attempt === retries) return res;',
            '    } catch (err) {',
            '      if (signal?.aborted) throw err;            // 外部取消：直接抛出',
            '      if (attempt === retries) throw new FetchError("请求失败", undefined, err);',
            '    } finally {',
            '      clearTimeout(timer);',
            '      signal?.removeEventListener("abort", abort);',
            '    }',
            '',
            '    const delay = baseDelay * 2 ** attempt + Math.random() * 120;',
            '    onRetry?.(attempt + 1, delay, null);',
            '    await new Promise(r => setTimeout(r, delay));',
            '  }',
            '  throw new FetchError("unreachable");',
            '}',
            '```',
            '',
            '几个容易踩的点：',
            '',
            '1. **不要把 4xx 当失败重试**，尤其是 401/429 —— 401 重试更无意义，429 应该看 `Retry-After`（可在 `onRetry` 里自行解析）。',
            '2. 外部 `signal` 与超时信号必须**分开**，否则无法区分“用户取消”和“超时”。上面通过 `signal?.aborted` 判断。',
            '3. `setTimeout` 的 timer 要在 `finally` 里清理，否则长连接场景下句柄会堆积。',
            '',
            '| 错误类型 | 是否重试 | 说明 |',
            '| --- | --- | --- |',
            '| 网络错误 / 断网 | ✅ | 瞬态故障 |',
            '| 5xx | ✅ | 服务端抖动 |',
            '| 429 | ⚠️ | 建议按 `Retry-After` 退避 |',
            '| 4xx | ❌ | 请求本身有问题 |',
            '',
            '> 如果调用方还需要“总时长上限”，把 deadline 也传进来，在每次循环开始前检查剩余时间即可。',
          ].join('\n'),
        },
        {
          id: uid(), role: 'user', ts: Date.now() - 60000, status: 'done',
          content: '如果后端返回 429 并带 Retry-After，怎么优雅地接进去？',
          images: [],
        },
      ],
    };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
