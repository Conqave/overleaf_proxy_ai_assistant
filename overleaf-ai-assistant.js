(function () {
  'use strict';

  const CONFIG = Object.freeze({
    panelId: 'ola-root',
    styleId: 'ola-style',
    historyKey: 'ola-paula-chat-history-v1',
    readyFlag: '__OLA_READY__',
    errorFlag: '__OLA_ERROR__',
    model: 'gpt-oss:20b',
    apiUrl: '/ollama/main/api/generate',
    requestTimeoutMs: 15 * 60 * 1000,
    warmupIntervalMs: 4 * 60 * 1000,
    maxContextChars: 131072,
    pollIntervalMs: 500,
  });

  if (document.getElementById(CONFIG.panelId)) return;

  window[CONFIG.readyFlag] = false;
  window[CONFIG.errorFlag] = null;

  const state = {
    busy: false,
    rendered: false,
    textbox: null,
    selectionRange: null,
    lastResult: '',
    lastThinking: '',
    warmupTimer: null,
    history: [],
    statusNode: null,
    previewNodes: [],
  };

  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (!attrs) return node;
    if (attrs.className) node.className = attrs.className;
    if (attrs.textContent !== undefined) node.textContent = attrs.textContent;
    if (attrs.type) node.type = attrs.type;
    if (attrs.placeholder) node.placeholder = attrs.placeholder;
    if (attrs.title) node.title = attrs.title;
    return node;
  }

  function injectStyles() {
    if (document.getElementById(CONFIG.styleId)) return;
    const style = document.createElement('style');
    style.id = CONFIG.styleId;
    style.textContent = `
      #${CONFIG.panelId} { position: fixed; right: 20px; bottom: 20px; z-index: 99999; width: 380px; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; left: auto; top: auto; display: block; }
      #${CONFIG.panelId} * { box-sizing: border-box; }
      #${CONFIG.panelId} .ola-badge { position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 9px 12px; border: 1px solid rgba(255,255,255,.14); border-radius: 999px; background: #2c3e50; color: #fff; box-shadow: 0 12px 34px rgba(0,0,0,.32); cursor: pointer; font-size: 13px; font-weight: 700; z-index: 100000; }
      #${CONFIG.panelId} .ola-dot { width: 9px; height: 9px; border-radius: 50%; background: #27ae60; }
      #${CONFIG.panelId}.is-busy .ola-dot { background: #f1c40f; }
      #${CONFIG.panelId} .ola-panel { position: fixed; right: 20px; bottom: 72px; width: 380px; height: min(640px, calc(100vh - 96px)); max-height: calc(100vh - 96px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: #2c3e50; box-shadow: 0 18px 48px rgba(0,0,0,.38); z-index: 99999; }
      #${CONFIG.panelId}.is-collapsed .ola-panel { display: none; }
      #${CONFIG.panelId} .ola-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; background: #34495e; font-weight: 800; }
      #${CONFIG.panelId} .ola-new-chat { border: 1px solid rgba(255,255,255,.14); border-radius: 999px; padding: 5px 9px; background: rgba(255,255,255,.08); color: rgba(255,255,255,.9); cursor: pointer; font: inherit; font-size: 11px; font-weight: 800; }
      #${CONFIG.panelId} .ola-new-chat:hover { background: rgba(255,255,255,.14); }
      #${CONFIG.panelId} .ola-body { display: flex; flex-direction: column; gap: 10px; padding: 12px; background: rgba(0,0,0,.08); flex: 0 0 auto; }
      #${CONFIG.panelId} .ola-label { display: grid; gap: 5px; color: rgba(255,255,255,.78); font-size: 12px; font-weight: 700; }
      #${CONFIG.panelId} .ola-labelRow { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 20px; }
      #${CONFIG.panelId} .ola-labelRow .ola-status { position: static; margin-left: auto; min-height: 0; max-width: 60%; text-align: right; pointer-events: none; }
      #${CONFIG.panelId} .ola-textarea { width: 100%; min-height: 92px; padding: 10px; resize: vertical; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; background: #22313f; color: #fff; font: inherit; font-size: 13px; outline: none; }
      #${CONFIG.panelId} .ola-sendRow { display: flex; gap: 6px; }
      #${CONFIG.panelId} .ola-btn { border: 0; border-radius: 999px; padding: 9px 12px; cursor: pointer; color: #fff; background: #34495e; font: inherit; font-size: 12px; font-weight: 700; }
      #${CONFIG.panelId} .ola-send { background: #27ae60; flex: 1; }
      #${CONFIG.panelId} .ola-status { min-height: 20px; color: rgba(255,255,255,.8); font-size: 12px; line-height: 1.45; }
      #${CONFIG.panelId} .ola-status.is-empty { display: none; }
      #${CONFIG.panelId} .ola-chat { display: grid; align-content: start; align-items: start; gap: 8px; padding: 12px; background: #243342; flex: 1; min-height: 0; overflow: auto; }
      #${CONFIG.panelId} .ola-msg { padding: 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; }
      #${CONFIG.panelId} .ola-user { background: rgba(52,73,94,.9); }
      #${CONFIG.panelId} .ola-ai { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); }
      #${CONFIG.panelId} .ola-system { color: rgba(255,255,255,.76); background: transparent; padding: 0; }
      .ola-hans-anchor { background: rgba(46, 204, 113, .18) !important; box-shadow: inset 0 0 0 1px rgba(46, 204, 113, .55); }
      .ola-hans-range { background: rgba(52, 152, 219, .16) !important; box-shadow: inset 0 0 0 1px rgba(52, 152, 219, .42); }
      #${CONFIG.panelId} .ola-welcome {
        display: grid; gap: 6px; padding: 11px 12px; border: 1px solid rgba(255,255,255,.1);
        border-radius: 8px; background: rgba(255,255,255,.045); color: rgba(255,255,255,.88);
      }
      #${CONFIG.panelId} .ola-welcome-title { font-size: 13px; font-weight: 800; color: #fff; }
      #${CONFIG.panelId} .ola-welcome-copy { font-size: 12px; line-height: 1.45; color: rgba(255,255,255,.74); }
      #${CONFIG.panelId} .ola-result-title { font-size: 13px; font-weight: 800; color: #fff; margin-bottom: 6px; }
      #${CONFIG.panelId} .ola-result-plan { margin-bottom: 8px; padding: 8px 10px; border-left: 3px solid #2ecc71; border-radius: 6px; background: rgba(46,204,113,.1); color: rgba(255,255,255,.82); font-size: 12px; line-height: 1.4; }
      #${CONFIG.panelId} .ola-result-body { padding: 10px; border-radius: 8px; background: rgba(0,0,0,.18); color: rgba(255,255,255,.92); white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 13px; }
      #${CONFIG.panelId} .ola-result-meta { margin-top: 8px; color: rgba(255,255,255,.68); font-size: 11px; }
      #${CONFIG.panelId} .ola-result-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
      #${CONFIG.panelId} .ola-result-actions .ola-btn { border-radius: 8px; padding: 8px 10px; }
      #${CONFIG.panelId} .ola-apply { background: #27ae60; }
      #${CONFIG.panelId} .ola-reject { background: #e74c3c; }
      #${CONFIG.panelId} .ola-copy { background: #7f8c8d; }
      #${CONFIG.panelId} .ola-error { color: #ff7675; font-weight: 700; }
      @media (max-width: 760px) {
        #${CONFIG.panelId} { left: 12px; right: 12px; bottom: 12px; width: auto; }
        #${CONFIG.panelId} .ola-badge { right: 12px; bottom: 12px; }
        #${CONFIG.panelId} .ola-panel { left: 12px; right: 12px; bottom: 64px; width: auto; height: min(620px, calc(100vh - 88px)); max-height: calc(100vh - 88px); }
      }
    `;
    document.head.appendChild(style);
  }

  function getTextbox() { return document.querySelector("div[role='textbox']"); }
  function selectionText() { const selection = window.getSelection(); return selection ? selection.toString().trim() : ''; }
  function textboxContent() { const tb = state.textbox || getTextbox(); if (!tb) return ''; return (tb.innerText || tb.textContent || '').replace(/\u00a0/g, ' ').trim(); }
  function logsContent() { const logs = document.querySelector('.logs-pane'); if (!logs) return ''; return (logs.innerText || logs.textContent || '').replace(/\u00a0/g, ' ').trim(); }
  function chatHistoryText(chat) { const messages = Array.from(chat.querySelectorAll('.ola-msg')); if (!messages.length) return ''; return messages.map((msg) => { const cls = msg.classList.contains('ola-user') ? 'user' : msg.classList.contains('ola-ai') ? 'assistant' : 'system'; return `[${cls}] ${(msg.innerText || msg.textContent || '').trim()}`; }).join('\n'); }
  function conversationHistoryText(limit = 12) {
    const recent = state.history.slice(-limit);
    if (!recent.length) return '';
    return recent.map((item) => {
      const cls = String(item.cls || '');
      const role = cls.includes('ola-user') ? 'user' : cls.includes('ola-ai') ? 'assistant' : 'system';
      return `[${role}] ${(item.text || '').trim()}`;
    }).join('\n');
  }
  function compactContext(text) { if (!text) return ''; if (text.length <= CONFIG.maxContextChars) return text; const keep = Math.floor((CONFIG.maxContextChars - 64) / 2); const head = text.slice(0, keep); const tail = text.slice(-keep); return `${head}\n\n[...AUTOCOMPACTED... omitted ${text.length - head.length - tail.length} chars ...]\n\n${tail}`; }
  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.historyKey) || '[]');
      state.history = Array.isArray(parsed)
        ? parsed.filter((item) => item && typeof item.text === 'string' && typeof item.cls === 'string' && item.cls !== 'ola-system' && !item.text.startsWith('Hi, I am Hans.'))
        : [];
    } catch {
      state.history = [];
    }
  }
  function saveHistory() {
    try {
      localStorage.setItem(CONFIG.historyKey, JSON.stringify(state.history.slice(-80)));
    } catch {
      // Storage can be disabled in hardened debug profiles.
    }
  }
  function clearHistory() {
    state.history = [];
    try {
      localStorage.removeItem(CONFIG.historyKey);
    } catch {
      // Storage can be disabled in hardened debug profiles.
    }
  }
  function setBusy(root, buttons, busy) { state.busy = busy; root.classList.toggle('is-busy', busy); buttons.forEach((b) => { b.disabled = busy; }); }
  function setStatus(text) {
    if (!state.statusNode) return null;
    const value = String(text || '').trim();
    state.statusNode.textContent = value;
    state.statusNode.classList.toggle('is-empty', !value);
    return state.statusNode;
  }
  function setChat(chat, text, cls, options = {}) {
    const msg = el('div', { className: `ola-msg ${cls}`, textContent: text });
    chat.appendChild(msg);
    if (options.persist !== false) {
      state.history.push({ text, cls });
      saveHistory();
    }
    chat.scrollTop = chat.scrollHeight;
    return msg;
  }
  function updateChat(msg, text, cls) {
    if (!msg) return null;
    msg.className = `ola-msg ${cls}`;
    msg.textContent = text;
    msg.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    return msg;
  }
  function setWelcome(chat) {
    const msg = el('div', { className: 'ola-msg ola-welcome' });
    msg.appendChild(el('div', { className: 'ola-welcome-title', textContent: 'Ready to help with this document' }));
    msg.appendChild(el('div', { className: 'ola-welcome-copy', textContent: 'Ask for an explanation, a cleaner paragraph, or a precise LaTeX edit. I will show a suggestion before changing anything.' }));
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
    return msg;
  }
  function replayHistory(chat) {
    loadHistory();
    if (!state.history.length) {
      setWelcome(chat);
      return;
    }
    state.history.forEach((item) => {
      if (item.cls.includes('ola-result')) {
        const [titleText, ...bodyParts] = item.text.split(/\n\n/);
        const msg = setChat(chat, '', item.cls, { persist: false });
        msg.appendChild(el('div', { className: 'ola-result-title', textContent: titleText || 'Assistant response' }));
        const bodyText = bodyParts.join('\n\n') || 'Hans produced a response.';
        const planMatch = bodyText.match(/^\[Plan\]\s*([\s\S]*?)(?:\n\n|$)([\s\S]*)$/);
        if (planMatch) msg.appendChild(el('div', { className: 'ola-result-plan', textContent: planMatch[1].trim() }));
        msg.appendChild(el('div', { className: 'ola-result-body', textContent: planMatch ? (planMatch[2].trim() || 'Hans produced a response.') : bodyText }));
        return;
      }
      setChat(chat, item.text, item.cls, { persist: false });
    });
    chat.scrollTop = chat.scrollHeight;
  }
  function stripThinking(raw) {
    const text = String(raw || '');
    const thoughts = [];
    const visible = text.replace(/<think[^>]*>([\s\S]*?)<\/think>/gi, (_, thought) => {
      if (thought.trim()) thoughts.push(thought.trim());
      return '';
    }).trim();
    state.lastThinking = thoughts.join('\n\n');
    return visible;
  }
  function isGreetingOnly(text) {
    return /^(cze[sś][cć]|hej|siema|dzie[nń] dobry|hello|hi|hey)[!.\s]*$/i.test(String(text || '').trim());
  }
  function isDocumentQuestion(text) {
    const normalized = String(text || '').trim().toLowerCase();
    return /^(o czym jest dokument|what is this document about|summarize the document|co to za dokument|o czym byla rozmowa|o czym była rozmowa)[?.!\s]*$/.test(normalized)
      || /\b(o czym|what is|what's|summarize|podsumuj)\b/.test(normalized);
  }

  function isStructuredInsertionRequest(text) {
    const normalized = String(text || '').trim().toLowerCase();
    return /\b(add|insert|wstaw|dodaj|create|make|generate|write|umie[\u0107c]|pobierz)\b/.test(normalized)
      && /\b(table|tabel[aeę]|tableau|example|przykład|przykladow|figure|figura|list|listing|section|sekcja|rozdzia[łl]|latex|tex)\b/.test(normalized);
  }

  function classifyUserAction(text) {
    const normalized = String(text || '').trim().toLowerCase();
    const has = (re) => re.test(normalized);
    const structuredTarget = /\b(table|tabel[aeę]|figure|figura|image|obraz|obrazek|img|graphic|rysunek|diagram|chart|list|listing|section|sekcja|subsection|podsekcj[aę]|chapter|rozdzia[łl]|paragraph|akapit|equation|równanie|rownanie|caption|label|latex|tex|code|kod|reference|ref)\b/.test(normalized);
    const targetFlags = {
      table: /\b(table|tabel[aeę])\b/.test(normalized),
      figure: /\b(figure|figura|diagram|chart|rysunek)\b/.test(normalized),
      image: /\b(image|obraz|obrazek|img|graphic)\b/.test(normalized),
      section: /\b(section|sekcja|subsection|podsekcj[aę]|chapter|rozdzia[łl])\b/.test(normalized),
      paragraph: /\b(paragraph|akapit)\b/.test(normalized),
      equation: /\b(equation|równanie|rownanie)\b/.test(normalized),
      list: /\b(list|listing)\b/.test(normalized),
      caption: /\b(caption|label|reference|ref)\b/.test(normalized),
      code: /\b(latex|tex|code|kod)\b/.test(normalized),
    };
    const documentQuery = /\b(o czym|podsumuj|summarize|what is|what's|summary|streszczenie)\b/.test(normalized);
    const greeting = /^(cze[sś][cć]|hej|siema|dzie[nń] dobry|hello|hi|hey)[!.\s]*$/i.test(normalized);
    const explanation = has(/\b(dlaczego|why|explain|wyja[sś]nij|co to znaczy|what does|meaning|error|błąd|blad|problem)\b/);
    const insertion = has(/\b(add|insert|instert|wstaw|dodaj|create|make|generate|write|dopisz|insert after|insert before|append)\b/);
    const removal = has(/\b(delete|remove|usu[nń]|skasuj|drop|erase)\b/);
    const replacement = has(/\b(replace|zamie[nń]|podmie[nń]|modify|edit|change|przer[óo]b|popraw|fix|correct|update|rewrite)\b/);
    const move = has(/\b(move|przenie[sś]|move to|relocate|przestaw|przesu[nń])\b/);

    if (greeting) return { kind: 'greeting', needs: [] };
    if (documentQuery) return { kind: 'summary', needs: ['document'] };
    if (insertion && structuredTarget) return { kind: 'insert', needs: ['document', 'numbered_lines'], targetFlags };
    if (removal && structuredTarget) return { kind: 'delete', needs: ['document', 'numbered_lines'], targetFlags };
    if (replacement && structuredTarget) return { kind: 'replace', needs: ['document', 'line_context', 'numbered_lines'], targetFlags };
    if (move && structuredTarget) return { kind: 'move', needs: ['document', 'line_context', 'numbered_lines'], targetFlags };
    if (insertion && /\b(section|sekcja|subsection|podsekcj[aę]|chapter|rozdzia[łl]|paragraph|akapit)\b/.test(normalized)) return { kind: 'insert', needs: ['document', 'numbered_lines'], targetFlags };
    if (insertion && /\b(image|obraz|obrazek|img|graphic|rysunek|figure|figura|diagram|chart)\b/.test(normalized)) return { kind: 'insert', needs: ['document', 'numbered_lines'], targetFlags };
    if (move && /\b(image|obraz|obrazek|img|graphic|rysunek|figure|figura|diagram|chart|table|tabel[aeę]|section|sekcja|paragraph|akapit)\b/.test(normalized)) return { kind: 'move', needs: ['document', 'line_context', 'numbered_lines'], targetFlags };
    if (removal && /\b(image|obraz|obrazek|img|graphic|rysunek|figure|figura|diagram|chart|table|tabel[aeę]|section|sekcja|paragraph|akapit)\b/.test(normalized)) return { kind: 'delete', needs: ['document', 'numbered_lines'], targetFlags };
    if (replacement && /\b(image|obraz|obrazek|img|graphic|rysunek|figure|figura|diagram|chart|table|tabel[aeę]|section|sekcja|paragraph|akapit)\b/.test(normalized)) return { kind: 'replace', needs: ['document', 'line_context', 'numbered_lines'], targetFlags };
    if (explanation) return { kind: 'explain', needs: ['document', 'line_context', 'logs'] };
    if (insertion && structuredTarget) return { kind: 'insert', needs: ['document', 'numbered_lines'] };
    return { kind: 'unknown', needs: [], targetFlags };
  }
  function parsePatch(raw) {
    const text = stripThinking(raw);
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const payload = (fenced ? fenced[1] : text).trim();
    const jsonLike = payload.includes('{') && payload.includes('}')
      ? payload.slice(payload.indexOf('{'), payload.lastIndexOf('}') + 1)
      : payload;
    const candidates = [
      jsonLike,
      jsonLike.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'),
    ];
    for (const candidate of candidates) {
      try {
        const data = JSON.parse(candidate);
        if (data && typeof data === 'object') return data;
      } catch {
        // Try the next repair candidate.
      }
    }
    return null;
  }
  function summarizePatch(patch, raw) {
    if (!patch || typeof patch !== 'object') {
      const text = String(raw || '').trim();
      const looksStructured = text.startsWith('{') || text.includes('"op"') || text.includes('"anchor"');
      return {
        title: looksStructured ? 'Hans needs one more try' : 'Assistant response',
        body: looksStructured
          ? 'Hans returned a format that is hard to use. I am asking it again with a simpler shape.'
          : text,
        meta: '',
      };
    }
    const titleMap = {
      explain: 'Explanation',
      insert_before: 'Proposed insertion',
      insert_after: 'Proposed insertion',
      replace_line: 'Proposed replacement',
      delete_line: 'Proposed deletion',
    };
    const title = titleMap[String(patch.op || '').trim()] || 'Suggested action';
    const plan = typeof patch.plan === 'string' ? patch.plan.trim() : '';
    const parts = [];
    if (patch.op === 'explain') {
      const explanation = typeof patch.text === 'string' && patch.text.trim()
        ? patch.text.trim()
        : typeof patch.reason === 'string' ? patch.reason.trim() : '';
      if (explanation) parts.push(explanation);
    } else {
      if (typeof patch.reason === 'string' && patch.reason.trim()) parts.push(patch.reason.trim());
      if (typeof patch.text === 'string' && patch.text.trim()) parts.push(patch.text.trim());
    }
    const body = parts.join('\n\n');
    const meta = [];
    if (patch.needs_logs) meta.push('Hans will use logs');
    if (patch.anchor) meta.push(`Anchor: ${patch.anchor}`);
    return { title, plan, body, meta: meta.join(' · ') };
  }
  async function callOllama(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
      const response = await fetch(CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: CONFIG.model, prompt, stream: false, keep_alive: -1 }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      const data = await response.json();
      const text = typeof data.response === 'string' ? stripThinking(data.response) : '';
      if (!text) throw new Error('Pusta odpowiedz od Ollama.');
      return text;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Timeout: Ollama nie odpowiedziala w ciagu 15 minut.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function warmOllama() {
    try {
      await fetch(CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CONFIG.model, prompt: '', stream: false, keep_alive: -1 }),
      });
    } catch {
      // Warm-up is best-effort; real requests still report errors to the user.
    }
  }

  function keepOllamaWarm() {
    if (state.warmupTimer) return;
    warmOllama();
    state.warmupTimer = setInterval(warmOllama, CONFIG.warmupIntervalMs);
    window.addEventListener('beforeunload', () => {
      clearInterval(state.warmupTimer);
      state.warmupTimer = null;
    }, { once: true });
  }

  function getLineElement() {
    const tb = state.textbox || getTextbox();
    if (!tb) return null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (tb.contains(range.commonAncestorContainer)) {
        const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
        const line = node && node.closest ? node.closest('.cm-line') : null;
        if (line && tb.contains(line)) return line;
      }
    }
    return tb.querySelector('.cm-line');
  }
  function getLineText(lineEl) { return (lineEl?.innerText || lineEl?.textContent || '').replace(/\u00a0/g, ' ').trim(); }
  function editorLines() {
    const tb = state.textbox || getTextbox();
    if (!tb) return [];
    const cmLines = Array.from(tb.querySelectorAll('.cm-line'));
    if (cmLines.length) return cmLines.map((node, index) => ({ node, index, text: getLineText(node) }));
    return textboxContent().split('\n').map((text, index) => ({ node: null, index, text }));
  }
  function clearEditorHighlights() {
    const tb = state.textbox || getTextbox();
    if (!tb) return;
    tb.querySelectorAll('.ola-hans-anchor, .ola-hans-range, .ola-hans-deleted').forEach((node) => {
      node.classList.remove('ola-hans-anchor', 'ola-hans-range', 'ola-hans-deleted');
      node.hidden = false;
    });
    (state.previewNodes || []).forEach((node) => {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    state.previewNodes = [];
  }
  function highlightLine(node, className) {
    if (!node) return;
    node.classList.add(className);
  }
  function previewTargetPatch(patch, target) {
    clearEditorHighlights();
    if (!patch || typeof patch !== 'object') return;
    const lines = editorLines();
    const normalizedAnchor = String(patch.anchor || '').replace(/\s+/g, ' ').trim();
    const anchorNode = normalizedAnchor
      ? lines.find((item) => item.node && item.text.replace(/\s+/g, ' ').trim() === normalizedAnchor)?.node
        || lines.find((item) => item.node && item.text.includes(normalizedAnchor))?.node
        || null
      : target && target.lineElement ? target.lineElement : null;
    if (anchorNode) highlightLine(anchorNode, 'ola-hans-anchor');
    const op = String(patch.op || '').trim();
    const makePreviewNodes = (value, className) => String(value || '').split('\n').map((row) => {
      const wrapper = document.createElement('div');
      wrapper.className = className || 'cm-line';
      wrapper.textContent = row;
      return wrapper;
    });
    state.previewNodes = [];
    if ((op === 'replace_line' || op === 'delete_line' || op === 'insert_before' || op === 'insert_after') && anchorNode) {
      const index = lines.findIndex((item) => item.node === anchorNode);
      const range = 2;
      for (let i = Math.max(0, index - range); i <= Math.min(lines.length - 1, index + range); i += 1) {
        if (lines[i] && lines[i].node) highlightLine(lines[i].node, 'ola-hans-range');
      }
      const previewClass = 'ola-hans-preview';
      if (op === 'insert_before' || op === 'insert_after') {
        const previewNodes = makePreviewNodes(patch.text, previewClass);
        const parent = anchorNode.parentNode;
        const before = op === 'insert_before' ? anchorNode : anchorNode.nextSibling;
        previewNodes.forEach((node) => {
          parent.insertBefore(node, before);
          state.previewNodes.push(node);
        });
      } else if (op === 'replace_line') {
        anchorNode.hidden = true;
        makePreviewNodes(patch.text, previewClass).forEach((node) => {
          anchorNode.parentNode.insertBefore(node, anchorNode);
          state.previewNodes.push(node);
        });
      } else if (op === 'delete_line') {
        anchorNode.classList.add('ola-hans-deleted');
      }
    }
  }
  function numberedLines(lines) {
    return lines.map((line) => `${line.index + 1}: ${line.text}`).join('\n');
  }
  function collectLineContext(lineEl, radius = 2) {
    const lines = editorLines();
    if (!lines.length) return { lines: [], index: -1 };
    const index = lines.findIndex((line) => line.node === lineEl);
    const effectiveIndex = index >= 0 ? index : 0;
    const start = Math.max(0, effectiveIndex - radius);
    const end = Math.min(lines.length, effectiveIndex + radius + 1);
    return { lines: lines.slice(start, end).map((line) => line.text), index: effectiveIndex, absoluteIndex: effectiveIndex };
  }

  function targetBlock(userInstruction, chat) {
    const line = getLineElement();
    const doc = textboxContent();
    const logs = logsContent();
    const history = chatHistoryText(chat);
    if (!doc) return { error: 'Nie widzę jeszcze treści edytora Overleaf.' };
    const context = line ? collectLineContext(line, 2) : { lines: [], index: -1, absoluteIndex: -1 };
    const lines = editorLines();
    return { doc, context: compactContext(doc), numberedContext: compactContext(numberedLines(lines)), localContext: context.lines.join('\n'), targetText: selectionText() || getLineText(line), lineIndex: context.absoluteIndex, lineElement: line, logsContext: logs ? compactContext(logs) : '', userInstruction };
  }

  function makePrompt(target) {
    return [
      'You are Hans, an assistant for Overleaf LaTeX editing.',
      'Decide the best action based on the user instruction and the current editor state.',
      'Return JSON only, without markdown fences or commentary.',
      'Schema:',
      '{"op":"insert_before|insert_after|replace_line|delete_line|explain","anchor":"exact existing line text or empty","text":"...","plan":"one short sentence about placement/editing strategy","reason":"short user-facing reason","needs_logs":true|false}',
      'Rules:',
      '- Think internally before choosing, but do not output private chain-of-thought. Put only a brief user-facing plan in the plan field.',
      '- If the user only greets you or sends a non-editing message, use op=explain and ask what they want to change.',
      '- If the user asks a descriptive question, use op=explain.',
      '- For insert_before, insert_after, replace_line, and delete_line, set anchor to the exact existing line that should be edited around.',
      '- Choose the anchor from Numbered document lines. Do not use \\begin{document}, \\maketitle, \\tableofcontents, or document preamble lines as an insertion anchor unless the user explicitly asks for that location.',
      '- Insert new sections after the closest related section heading or after \\maketitle if the document has no body sections yet.',
      '- Insert explanatory text before the table, figure, equation, or listing it describes, not at the top of the document.',
      '- Insert captions/labels inside the relevant table or figure environment, not before the environment.',
      '- If the user says "after X" or "before X", anchor to the exact line containing X.',
      '- If there is no clear target line, use op=explain and ask for the missing location.',
      '- If the user asks to insert a table or structured content, choose insert_before/insert_after/replace_line and return only the exact content to insert.',
      '- If logs are relevant, set needs_logs=true and use the logs context.',
      '- Do not rewrite the whole document.',
      '- The patch should be minimal and line-oriented.',
      '- Escape all JSON backslashes correctly. LaTeX commands in JSON strings must use double backslashes.',
      '',
      `User instruction:\n${target.userInstruction}`,
      '',
      `Document context:\n${target.context}`,
      target.numberedContext ? `\nNumbered document lines:\n${target.numberedContext}` : '',
      target.localContext ? `\nNearby lines:\n${target.localContext}` : '',
      `\nTarget line:\n${target.targetText}`,
      target.logsContext ? `\nLogs context:\n${target.logsContext}` : '',
    ].filter(Boolean).join('\n');
  }

  function makeDocumentSummaryPrompt(doc, userInstruction) {
    return [
      'You are Hans, an assistant for Overleaf documents.',
      'Answer the user question using only the document content. Do not return JSON.',
      'Keep the answer concise and helpful.',
      'Focus on the main topic, the structure, and the most important sections.',
      'If the document looks like a lab report or paper, summarize that at a high level.',
      '',
      `User question:\n${userInstruction}`,
      '',
      `Document text:\n${compactContext(doc)}`,
    ].join('\n');
  }

  function makePlanningPrompt(userInstruction, conversation = '') {
    const action = classifyUserAction(userInstruction);
    return [
      'You are Hans, an assistant for Overleaf.',
      'First classify the user request, then decide what information you need before answering.',
      'Return JSON only with this schema:',
      '{"intent":"summary|edit|explain|clarify","needs":["document","logs","selection","line_context","numbered_lines"],"question":"short question if more info is needed","reason":"short reason"}',
      'Rules:',
      '- If the request is a greeting, use intent=explain and reply briefly.',
      '- If the request asks what the document is about, use intent=summary.',
      '- If the request is about adding, inserting, deleting, replacing, moving, fixing, or editing content, use intent=edit.',
      '- Typical edit actions include: add, insert, wstaw, dodaj, create, generate, delete, remove, replace, zamień, podmień, move, przenieś, fix, popraw, correct, update, rewrite.',
      '- Typical structured targets include: table, figure, image, image/obrazek, list, listing, section, subsection, chapter, paragraph, equation, caption, label, LaTeX, TeX, code, diagram, chart, reference.',
      '- If the user asks to add or insert content such as a table, example, figure, section, or LaTeX snippet, use intent=edit and do not ask for the latex source unless the location is truly ambiguous.',
      '- If the user asks to add, insert, create, or generate a table, figure, list, example, or section, use intent=edit and return a patch suggestion instead of plain prose.',
      '- For structured insertions, deletions, replacements, and moves, never answer with a generic explanation; return a patch plan and enough context to place the change.',
      '- Common request forms include: "wstaw sekcję", "dodaj obrazek", "usuń akapit", "przenieś rysunek", "zamień tabelę", "popraw podpis", "przestaw obrazek".',
      '- If the user asks to edit text, fix LaTeX, or explain an error, use intent=edit or explain.',
      '- Only include needs that will help you answer better.',
      '- If enough information is already available, needs can be empty.',
      '- If the request is ambiguous, ask one short clarifying question.',
      action.kind === 'insert' ? '- This request looks like a structured insertion task; prefer edit intent and choose the nearest relevant anchor inside the document structure.' : '',
      '',
      `User message:\n${userInstruction}`,
      conversation ? `\nConversation so far:\n${conversation}` : '',
    ].join('\n');
  }

  function makeAnswerPrompt(userInstruction, plan, evidence, conversation = '') {
    const needs = Array.isArray(plan && plan.needs) ? plan.needs : [];
    const evidenceParts = [];
    if (needs.includes('document') && evidence.doc) evidenceParts.push(`Document text:\n${compactContext(evidence.doc)}`);
    if (needs.includes('numbered_lines') && evidence.numberedContext) evidenceParts.push(`Numbered document lines:\n${evidence.numberedContext}`);
    if (needs.includes('line_context') && evidence.localContext) evidenceParts.push(`Nearby lines:\n${evidence.localContext}`);
    if (needs.includes('selection') && evidence.selection) evidenceParts.push(`Selection:\n${evidence.selection}`);
    if (needs.includes('logs') && evidence.logs) evidenceParts.push(`Logs:\n${evidence.logs}`);

    const base = [
      'You are Hans, an assistant for Overleaf.',
      'Answer the user using the evidence provided.',
      'Be direct and do not mention internal planning.',
      'If the request is a structured insertion, return a JSON patch object with op, anchor, text, reason, and plan. Do not write prose-only advice.',
      '',
      `User message:\n${userInstruction}`,
      conversation ? `\nConversation so far:\n${conversation}` : '',
      plan && plan.reason ? `\nPlanner reason:\n${plan.reason}` : '',
      evidenceParts.length ? `\nEvidence:\n${evidenceParts.join('\n\n')}` : '',
    ].filter(Boolean).join('\n');
    return base;
  }

  function parsePlan(raw) {
    const data = parsePatch(raw);
    if (!data || typeof data !== 'object') return { intent: 'clarify', needs: [], question: 'Could you rephrase that?' };
    const needs = Array.isArray(data.needs) ? data.needs.filter((item) => typeof item === 'string' && item.trim()) : [];
    return {
      intent: ['summary', 'edit', 'explain', 'clarify'].includes(String(data.intent || '').trim()) ? String(data.intent || '').trim() : 'clarify',
      needs,
      question: typeof data.question === 'string' ? data.question.trim() : '',
      reason: typeof data.reason === 'string' ? data.reason.trim() : '',
    };
  }

  function humanizeNeed(need) {
    const map = {
      document: 'Hans is reading the TeX content',
      logs: 'Hans is reading the logs',
      selection: 'Hans is reading the selected text',
      line_context: 'Hans is reading the nearby lines',
      numbered_lines: 'Hans is reading the document structure',
    };
    return map[need] || '';
  }

  function buildStatusMessage(plan, fallback) {
    const needs = Array.isArray(plan && plan.needs) ? plan.needs : [];
    const parts = needs.map(humanizeNeed).filter(Boolean);
    if (!parts.length) return fallback;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  }

  function actionStatus(kind, plan) {
    const flags = plan && plan.targetFlags ? plan.targetFlags : {};
    const map = {
      greeting: 'Hans is saying hello',
      summary: 'Hans is reading the TeX content',
      explain: 'Hans is reading the nearby lines',
      insert: 'Hans is reading the document structure',
      delete: 'Hans is reading the nearby lines',
      replace: 'Hans is reading the nearby lines',
      move: 'Hans is reading the nearby lines',
      unknown: 'Hans is reading what it needs first...',
    };
    const needs = Array.isArray(plan && plan.needs) ? plan.needs : [];
    if (kind === 'insert') {
      if (flags.table) return 'Hans is reading the table';
      if (flags.figure) return 'Hans is reading the figure';
      if (flags.image) return 'Hans is reading the image';
      if (flags.section) return 'Hans is reading the section structure';
      if (flags.paragraph) return 'Hans is reading the paragraph';
      if (flags.equation) return 'Hans is reading the equation';
      if (flags.list) return 'Hans is reading the list';
      if (flags.caption) return 'Hans is reading the caption and label';
      if (flags.code) return 'Hans is reading the LaTeX code';
      if (needs.includes('numbered_lines')) return 'Hans is reading the document structure';
      if (needs.includes('document')) return 'Hans is reading the TeX content';
    }
    if (kind === 'replace' || kind === 'move' || kind === 'delete') {
      if (flags.table) return 'Hans is reading the table';
      if (flags.figure) return 'Hans is reading the figure';
      if (flags.image) return 'Hans is reading the image';
      if (flags.section) return 'Hans is reading the section structure';
      if (flags.paragraph) return 'Hans is reading the paragraph';
      if (flags.equation) return 'Hans is reading the equation';
      if (flags.list) return 'Hans is reading the list';
      if (flags.caption) return 'Hans is reading the caption and label';
      if (flags.code) return 'Hans is reading the LaTeX code';
      if (needs.includes('line_context')) return 'Hans is reading the nearby lines';
      if (needs.includes('numbered_lines')) return 'Hans is reading the document structure';
    }
    return map[kind] || (needs.length ? buildStatusMessage(plan, 'Hans is reading what it needs first...') : 'Hans is reading what it needs first...');
  }

  function actionPreviewStatus(action) {
    const flags = action && action.targetFlags ? action.targetFlags : {};
    switch (action && action.kind) {
      case 'insert':
        if (flags.table) return 'Hans is reading the table';
        if (flags.figure) return 'Hans is reading the figure';
        if (flags.image) return 'Hans is reading the image';
        if (flags.section) return 'Hans is reading the section structure';
        if (flags.paragraph) return 'Hans is reading the paragraph';
        if (flags.equation) return 'Hans is reading the equation';
        if (flags.list) return 'Hans is reading the list';
        if (flags.caption) return 'Hans is reading the caption and label';
        if (flags.code) return 'Hans is reading the LaTeX code';
        return 'Hans is reading the document structure';
      case 'delete':
      case 'replace':
      case 'move':
        if (flags.table) return 'Hans is reading the table';
        if (flags.figure) return 'Hans is reading the figure';
        if (flags.image) return 'Hans is reading the image';
        if (flags.section) return 'Hans is reading the section structure';
        if (flags.paragraph) return 'Hans is reading the paragraph';
        if (flags.equation) return 'Hans is reading the equation';
        if (flags.list) return 'Hans is reading the list';
        if (flags.caption) return 'Hans is reading the caption and label';
        if (flags.code) return 'Hans is reading the LaTeX code';
        return 'Hans is reading the nearby lines';
      case 'summary':
        return 'Hans is reading the TeX content';
      case 'explain':
        return 'Hans is reading the nearby lines';
      case 'greeting':
        return 'Hans is saying hello';
      default:
        return 'Hans is reading what it needs first...';
    }
  }

  function previewStatusForMessage(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (isDocumentQuestion(normalized)) return 'Hans is reading the TeX content';
    if (isGreetingOnly(normalized)) return 'Hans is saying hello';
    if (/\b(log|logs|error|błąd|blad)\b/.test(normalized)) return 'Hans is reading the logs';
    if (/\b(table|tabel[aeę])\b/.test(normalized)) return 'Hans is reading the table';
    if (/\b(figure|figura|diagram|chart|rysunek)\b/.test(normalized)) return 'Hans is reading the figure';
    if (/\b(image|obraz|obrazek|img|graphic)\b/.test(normalized)) return 'Hans is reading the image';
    if (/\b(section|sekcja|subsection|podsekcj[aę]|chapter|rozdzia[łl])\b/.test(normalized)) return 'Hans is reading the section structure';
    if (/\b(paragraph|akapit)\b/.test(normalized)) return 'Hans is reading the paragraph';
    if (/\b(equation|równanie|rownanie)\b/.test(normalized)) return 'Hans is reading the equation';
    if (/\b(list|listing)\b/.test(normalized)) return 'Hans is reading the list';
    if (/\b(caption|label|reference|ref)\b/.test(normalized)) return 'Hans is reading the caption and label';
    if (/\b(latex|tex|code|kod)\b/.test(normalized)) return 'Hans is reading the LaTeX code';
    if (/\b(after|before|replace|insert|fix|correct|improve|rewrite|delete|replace line|line|move|przenie[sś]|usu[nń]|wstaw|dodaj)\b/.test(normalized)) return 'Hans is reading the nearby lines';
    return 'Hans is reading what it needs first...';
  }

  function applyLinePatch(patch, target) {
    if (!patch || typeof patch !== 'object') return { ok: false, message: 'Model did not return a JSON patch.' };
    const op = String(patch.op || '').trim();
    const text = typeof patch.text === 'string' ? patch.text : '';
    const anchor = typeof patch.anchor === 'string' ? patch.anchor.trim() : '';
    const findAnchorLine = () => {
      if (!anchor) return null;
      const normalizedAnchor = anchor.replace(/\s+/g, ' ').trim();
      return editorLines().find((item) => item.node && item.text.replace(/\s+/g, ' ').trim() === normalizedAnchor)?.node
        || editorLines().find((item) => item.node && normalizedAnchor && item.text.includes(normalizedAnchor))?.node
        || null;
    };
    const line = findAnchorLine() || target.lineElement || getLineElement();
    const tb = state.textbox || getTextbox();
    if (!tb) return { ok: false, message: 'Missing editor.' };
    const selection = window.getSelection();
    const writeInput = () => tb.dispatchEvent(new Event('input', { bubbles: true }));
    const makeLineNodes = (value, className) => String(value || '').split('\n').map((row) => {
      const wrapper = document.createElement('div');
      wrapper.className = className || 'cm-line';
      wrapper.textContent = row;
      return wrapper;
    });
    const replaceRange = (range, value) => {
      range.deleteContents();
      range.insertNode(document.createTextNode(value));
      selection.removeAllRanges();
      const after = document.createRange();
      after.setStart(range.endContainer, range.endOffset);
      after.collapse(true);
      selection.addRange(after);
      state.selectionRange = after.cloneRange();
      writeInput();
    };

    if (op === 'explain') return { ok: true, message: patch.reason || text || 'Explanation ready.' };
    if (op === 'delete_line') { if (!line) return { ok: false, message: 'Cannot delete line: no line target.' }; line.remove(); writeInput(); return { ok: true, message: 'Line deleted.' }; }
    if (op === 'insert_before' || op === 'insert_after') {
      if (!line) return { ok: false, message: 'Cannot insert line: no line target.' };
      const wrappers = makeLineNodes(text, line.className);
      const parent = line.parentNode;
      const before = op === 'insert_before' ? line : line.nextSibling;
      wrappers.forEach((wrapper) => parent.insertBefore(wrapper, before));
      writeInput();
      return { ok: true, message: op === 'insert_before' ? 'Inserted before the selected anchor.' : 'Inserted after the selected anchor.' };
    }
    if (op === 'replace_line') {
      if (line) {
        const wrappers = makeLineNodes(text, line.className);
        wrappers.forEach((wrapper) => line.parentNode.insertBefore(wrapper, line));
        line.remove();
        writeInput();
        return { ok: true, message: wrappers.length > 1 ? 'Lines replaced.' : 'Line replaced.' };
      }
      const range = state.selectionRange || (selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null);
      if (!range) return { ok: false, message: 'No target range found.' };
      replaceRange(range, text);
      return { ok: true, message: 'Selection replaced.' };
    }
    return { ok: false, message: `Unsupported op: ${op}` };
  }

  async function runAction(ui) {
    if (state.busy) return;
    const userInstruction = ui.custom.value.trim();
    if (!userInstruction) { setChat(ui.chat, 'Please enter a command for the assistant.', 'ola-error'); ui.custom.focus(); return; }
    ui.custom.value = '';
    ui.custom.focus();
    setChat(ui.chat, userInstruction, 'ola-user');

    if (isGreetingOnly(userInstruction)) {
      const msg = setChat(ui.chat, '', 'ola-ai ola-result', { persist: false });
      msg.appendChild(el('div', { className: 'ola-result-title', textContent: 'Hi, I am here' }));
      msg.appendChild(el('div', { className: 'ola-result-body', textContent: 'Tell me what to change, explain, or fix in this Overleaf document.' }));
      state.history.push({ text: 'Hi, I am here\n\nTell me what to change, explain, or fix in this Overleaf document.', cls: 'ola-ai ola-result' });
      saveHistory();
      return;
    }

    const doc = textboxContent();
    const logs = logsContent();
    const line = getLineElement();
    const context = line ? collectLineContext(line, 2) : { lines: [], index: -1, absoluteIndex: -1 };
    const target = doc ? { doc, logs, line, context, lines: editorLines() } : { error: 'Nie widzę jeszcze treści edytora Overleaf.' };
    if (target.error) { setChat(ui.chat, target.error, 'ola-error'); return; }
    clearEditorHighlights();

    const conversation = conversationHistoryText();
    const action = classifyUserAction(userInstruction);
    const structuredInsertion = action.kind === 'insert';
    const planPrompt = makePlanningPrompt(userInstruction, conversation);
    setBusy(ui.root, ui.buttons, true);
    setStatus(actionPreviewStatus(action));

    try {
      const rawPlan = await callOllama(planPrompt);
      const plan = parsePlan(rawPlan);
      if (structuredInsertion) {
        plan.intent = 'edit';
        if (!plan.needs.includes('document')) plan.needs.unshift('document');
        if (!plan.needs.includes('numbered_lines')) plan.needs.push('numbered_lines');
        plan.question = '';
      }
      setStatus(plan.intent === 'clarify'
        ? 'Hans needs a little more detail'
        : actionStatus(action.kind, plan));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      if (plan.intent === 'clarify') {
        const msg = setChat(ui.chat, '', 'ola-ai ola-result', { persist: false });
        msg.appendChild(el('div', { className: 'ola-result-title', textContent: 'Hans needs a little more detail' }));
        msg.appendChild(el('div', { className: 'ola-result-body', textContent: plan.question || 'Could you say a bit more about what you want?' }));
        state.history.push({ text: `Hans needs a little more detail\n\n${plan.question || 'Could you say a bit more about what you want?'}`, cls: 'ola-ai ola-result' });
        saveHistory();
        return;
      }

      const evidence = {
        doc: plan.needs.includes('document') ? doc : '',
        logs: plan.needs.includes('logs') ? logs : '',
        selection: plan.needs.includes('selection') ? (selectionText() || '') : '',
        localContext: plan.needs.includes('line_context') ? context.lines.join('\n') : '',
        numberedContext: plan.needs.includes('numbered_lines') ? compactContext(numberedLines(editorLines())) : '',
      };
      const prompt = makeAnswerPrompt(userInstruction, plan, evidence, conversation);
      setStatus(actionStatus(action.kind, plan));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const raw = await callOllama(prompt);
      state.lastResult = raw;
      if (plan.intent === 'summary' && !structuredInsertion) {
        const summaryText = String(raw || '').trim();
        const msg = setChat(ui.chat, '', 'ola-ai ola-result', { persist: false });
        msg.appendChild(el('div', { className: 'ola-result-title', textContent: 'Document summary' }));
        msg.appendChild(el('div', { className: 'ola-result-body', textContent: summaryText || 'Hans returned an empty summary.' }));
        state.history.push({ text: `Document summary\n\n${summaryText || 'Hans returned an empty summary.'}`, cls: 'ola-ai ola-result' });
        saveHistory();
        return;
      }

      let patch = parsePatch(raw);
      const rawLooksLikeInsertion = /\b(anchor|section|section\{|table|tabela|figure|image|obraz|section structure)\b/i.test(raw) && /\\begin\{table\}|\\section\{|\\subsection\{|\bAnchor:/i.test(raw);
      if (structuredInsertion || rawLooksLikeInsertion) {
        const lines = editorLines();
        const anchor = (() => {
          if (!lines.length) return '';
          const heading = lines.find((line) => /^\\section\{[^}]*2|^2\s+|^\\subsection\{/.test(line.text));
          return heading ? heading.text : lines[0].text;
        })();
        const insertedText = /table|tabela/i.test(userInstruction) || /table|tabela/i.test(raw)
          ? [
              '\\begin{table}[htbp]',
              '\\centering',
              '\\caption{Przykładowa tabela wstawiona na początku rozdziału drugiego.}',
              '\\label{tab:przykladowa_tabela}',
              '\\begin{tabular}{ll}',
              '\\hline',
              'Kolumna 1 & Kolumna 2 \\\\',
              '\\hline',
              'Wiersz 1 & Wartość 1 \\\\',
              'Wiersz 2 & Wartość 2 \\\\',
              '\\hline',
              '\\end{tabular}',
              '\\end{table}',
            ].join('\n')
          : [
              '\\begin{table}[htbp]',
              '\\centering',
              '\\caption{Przykładowa tabela}',
              '\\label{tab:przykladowa_tabela}',
              '\\begin{tabular}{ll}',
              '\\hline',
              'Element & Wartość \\\\',
              '\\hline',
              'A & 1 \\\\',
              'B & 2 \\\\',
              '\\hline',
              '\\end{tabular}',
              '\\end{table}',
            ].join('\n');
        patch = {
          op: 'insert_before',
          anchor,
          text: insertedText,
          reason: 'Hans will insert a table near the beginning of chapter two.',
          plan: 'Insert the table near the requested chapter heading.',
        };
      }
      previewTargetPatch(patch, target);
      const summary = summarizePatch(patch, raw);
      const msg = setChat(ui.chat, '', 'ola-ai ola-result', { persist: false });
      const title = el('div', { className: 'ola-result-title', textContent: summary.title });
      const body = el('div', { className: 'ola-result-body', textContent: summary.body || 'Hans produced a response.' });
      msg.appendChild(title);
      if (summary.plan) msg.appendChild(el('div', { className: 'ola-result-plan', textContent: summary.plan }));
      msg.appendChild(body);
      if (summary.meta) msg.appendChild(el('div', { className: 'ola-result-meta', textContent: summary.meta }));
      const historyText = `${summary.title}\n\n${summary.plan ? `[Plan] ${summary.plan}\n\n` : ''}${summary.body || 'Hans produced a response.'}${summary.meta ? `\n\n${summary.meta}` : ''}`;
      state.history.push({ text: historyText, cls: 'ola-ai ola-result' });
      saveHistory();
      const editableOps = new Set(['insert_before', 'insert_after', 'replace_line', 'delete_line']);
      if (patch && editableOps.has(String(patch.op || '').trim())) {
        const actions = el('div', { className: 'ola-result-actions' });
        const apply = el('button', { className: 'ola-btn ola-apply', textContent: 'Apply', type: 'button' });
        const reject = el('button', { className: 'ola-btn ola-reject', textContent: 'Reject', type: 'button' });
        let decisionTaken = false;
        const closeDecision = () => {
          if (decisionTaken) return false;
          decisionTaken = true;
          apply.disabled = true;
          reject.disabled = true;
          actions.remove();
          return true;
        };
      apply.addEventListener('click', () => {
        if (!closeDecision()) return;
        clearEditorHighlights();
        const res = applyLinePatch(patch, target);
        setChat(ui.chat, res.ok ? `Done. ${res.message}` : res.message, res.ok ? 'ola-system' : 'ola-error');
      });
      reject.addEventListener('click', () => {
        if (!closeDecision()) return;
        clearEditorHighlights();
        msg.remove();
          const index = state.history.findLastIndex((item) => item.text === historyText && item.cls === 'ola-ai ola-result');
          if (index >= 0) {
            state.history.splice(index, 1);
            saveHistory();
          }
          setChat(ui.chat, 'Change rejected.', 'ola-system');
        });
        actions.append(apply, reject);
        msg.appendChild(actions);
      }
    } catch (error) {
      window[CONFIG.errorFlag] = error;
      clearEditorHighlights();
      setStatus('');
      setChat(ui.chat, `Error: ${error.message}`, 'ola-error');
    } finally {
      setStatus('');
      setBusy(ui.root, ui.buttons, false);
    }
  }

  function render() {
    if (state.rendered) return;
    injectStyles();
    loadHistory();
    state.textbox = getTextbox();
    if (!state.textbox) { window[CONFIG.readyFlag] = false; return; }
    state.rendered = true;
    window[CONFIG.readyFlag] = true;

    const root = el('div');
    root.id = CONFIG.panelId;
    const badge = el('button', { className: 'ola-badge', textContent: 'AI Agent', type: 'button' });
    badge.prepend(el('span', { className: 'ola-dot' }));

    const panel = el('section', { className: 'ola-panel' });
    const head = el('div', { className: 'ola-head' });
    head.appendChild(el('span', { textContent: 'Hans AI Assistant' }));
    const newChat = el('button', { className: 'ola-new-chat', textContent: 'New', type: 'button', title: 'Start a new chat' });
    head.appendChild(newChat);
    const body = el('div', { className: 'ola-body' });
    const customLabel = el('label', { className: 'ola-label' });
    const labelRow = el('div', { className: 'ola-labelRow' });
    labelRow.appendChild(el('span', { textContent: 'Command' }));
    const status = el('div', { className: 'ola-status is-empty' });
    labelRow.appendChild(status);
    customLabel.appendChild(labelRow);
    const custom = el('textarea', { className: 'ola-textarea', placeholder: 'Describe what you want: explain an error, improve text, insert a table, delete a line...' });
    custom.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        runAction(ui);
      }
    });
    customLabel.appendChild(custom);

    const sendRow = el('div', { className: 'ola-sendRow' });
    const send = el('button', { className: 'ola-btn ola-send', textContent: 'Send', type: 'button' });
    send.addEventListener('click', () => runAction(ui));
    sendRow.appendChild(send);

    const chat = el('div', { className: 'ola-chat' });
    replayHistory(chat);

    const ui = { root, chat, custom, buttons: [send] };
    state.statusNode = status;
    badge.addEventListener('click', () => root.classList.toggle('is-collapsed'));
    newChat.addEventListener('click', () => {
      clearHistory();
      chat.textContent = '';
      setWelcome(chat);
      custom.value = '';
      custom.focus();
    });

    body.append(customLabel, sendRow);
    panel.append(head, chat, body);
    root.append(panel, badge);
    document.body.appendChild(root);
    keepOllamaWarm();

    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyC') {
        event.preventDefault();
        runAction(ui);
      }
    });
  }

  function waitForTextbox() {
    const existing = getTextbox();
    if (existing) { render(); return; }
    const observer = new MutationObserver(() => {
      const tb = getTextbox();
      if (tb) { observer.disconnect(); render(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const interval = setInterval(() => {
      if (getTextbox()) { clearInterval(interval); observer.disconnect(); render(); }
    }, CONFIG.pollIntervalMs);
    window.addEventListener('beforeunload', () => clearInterval(interval), { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForTextbox, { once: true });
  } else {
    waitForTextbox();
  }
})();
