/**
 * Trace 可视化：专注调试 — 展示 Agent 的 prompt、输出、使用的 skills/tools、工具执行结果。
 * 数据来源：agent-details.jsonl（按 run 拉取）。
 */
export const TRACE_VIEWER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GraceBot Trace · 调试</title>
  <style>
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117; --surface: #181c24; --surface2: #1e232e;
      --border: #2a3142; --border2: #363d52;
      --txt: #e6edf3; --txt2: #8b949e; --txt3: #6e7681;
      --accent: #58a6ff; --accent-dim: #388bfd66;
      --green: #3fb950; --green-bg: #23863640;
      --red: #f85149; --red-bg: #da363340;
      --orange: #d29922; --orange-bg: #9e6a0340;
      --purple: #a371f7; --purple-bg: #8957e540;
      --cyan: #39c5cf; --cyan-bg: #39c5cf30;
      --font: ui-sans-serif, system-ui, sans-serif;
      --mono: ui-monospace, "Cascadia Code", "SF Mono", monospace;
      --sidebar-w: 320px; --topbar-h: 44px; --radius: 6px;
    }
    html, body { height: 100%; overflow: hidden; }
    body { font-family: var(--font); font-size: 13px; color: var(--txt); background: var(--bg); line-height: 1.5; }

    .topbar {
      position: fixed; top: 0; left: 0; right: 0; height: var(--topbar-h);
      background: var(--surface); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 12px; padding: 0 16px; z-index: 100;
    }
    .topbar .logo { font-weight: 700; color: var(--txt); }
    .topbar .logo span { color: var(--accent); }
    .topbar label { color: var(--txt2); font-size: 12px; }
    .topbar select {
      font: inherit; padding: 6px 10px; min-width: 200px;
      background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius);
      color: var(--txt);
    }
    .topbar select:focus { outline: none; border-color: var(--accent); }

    .layout { display: flex; position: fixed; top: var(--topbar-h); bottom: 0; left: 0; right: 0; }
    .sidebar {
      width: var(--sidebar-w); flex-shrink: 0;
      background: var(--surface); border-right: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .sidebar-title { padding: 10px 14px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--txt3); border-bottom: 1px solid var(--border); }
    .trace-list { flex: 1; overflow-y: auto; }
    .trace-item {
      padding: 10px 14px; border-bottom: 1px solid var(--border);
      cursor: pointer; transition: background .15s;
    }
    .trace-item:hover { background: var(--surface2); }
    .trace-item.active { background: var(--accent-dim); border-left: 3px solid var(--accent); padding-left: 11px; }
    .trace-item .msg { font-size: 12px; color: var(--txt); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .trace-item.active .msg { color: var(--accent); font-weight: 500; }
    .trace-item .id { font-size: 11px; color: var(--txt3); margin-top: 4px; font-family: var(--mono); }
    .trace-item .meta { font-size: 11px; color: var(--txt3); margin-top: 2px; }

    .detail { flex: 1; overflow-y: auto; padding: 20px 24px; }
    .detail-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--txt3); font-size: 14px; }
    .detail-empty .hint { margin-top: 8px; font-size: 12px; }

    .sec { margin-bottom: 20px; }
    .sec-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--txt3); margin-bottom: 8px; }
    .sec-title .badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--surface2); color: var(--txt2); margin-left: 6px; font-weight: 400; text-transform: none; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 12px; }
    .card-hdr { padding: 8px 12px; background: var(--surface2); border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--txt); display: flex; align-items: center; gap: 8px; }
    .card-body { padding: 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; color: var(--txt2); }
    .card-body.wrap { white-space: pre-wrap; }

    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .tag { font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 500; }
    .tag-skill { background: var(--purple-bg); color: var(--purple); }
    .tag-tool { background: var(--cyan-bg); color: var(--cyan); }
    .tag-src { font-size: 10px; opacity: .9; font-weight: 400; }
    .sec-hint { font-size: 11px; color: var(--txt3); margin-bottom: 8px; line-height: 1.5; }
    .sec-hint code { font-family: var(--mono); font-size: 10px; background: var(--surface2); padding: 1px 4px; border-radius: 3px; }
    .tag-stop { background: var(--green-bg); color: var(--green); }
    .tag-stop.tool_use { background: var(--orange-bg); color: var(--orange); }
    .tag-stop.max_tokens { background: var(--red-bg); color: var(--red); }

    .round { margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
    .round-hdr { padding: 10px 14px; background: var(--surface2); border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--txt); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .round-body { padding: 14px; }
    .sub-sec { margin-bottom: 14px; }
    .sub-sec:last-child { margin-bottom: 0; }
    .sub-sec .label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--txt3); margin-bottom: 4px; }
    .sub-sec .content { font-family: var(--mono); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; padding: 8px 10px; background: var(--bg); border-radius: 4px; border: 1px solid var(--border); max-height: 280px; overflow-y: auto; color: var(--txt2); }
    .msg-row { margin-bottom: 8px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
    .msg-row .role { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 4px 8px; }
    .msg-row .role.system { background: #1a3a5c; color: var(--accent); }
    .msg-row .role.user { background: var(--green-bg); color: var(--green); }
    .msg-row .role.assistant { background: var(--purple-bg); color: var(--purple); }
    .msg-row .role.tool_result { background: var(--cyan-bg); color: var(--cyan); }
    .msg-row .body { padding: 8px 10px; font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; color: var(--txt2); }

    .tool-block { margin-bottom: 10px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
    .tool-block .tool-hdr { padding: 6px 10px; background: var(--cyan-bg); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 600; color: var(--cyan); font-family: var(--mono); display: flex; align-items: center; gap: 8px; }
    .tool-block .tool-hdr .err { font-size: 10px; padding: 1px 5px; background: var(--red-bg); color: var(--red); border-radius: 3px; }
    .tool-block .tool-hdr .tool-from { font-size: 10px; color: var(--txt3); font-weight: 400; }
    .tool-block .tool-io { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .tool-block .tool-io > div { padding: 8px 10px; border-right: 1px solid var(--border); font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto; color: var(--txt2); }
    .tool-block .tool-io > div:last-child { border-right: none; }
    .tool-block .tool-io .lbl { font-size: 10px; font-weight: 600; color: var(--txt3); margin-bottom: 4px; }

    .empty-note { color: var(--txt3); font-size: 12px; padding: 12px 0; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
  </style>
</head>
<body>
  <header class="topbar">
    <span class="logo">GraceBot <span>Trace</span></span>
    <label>Run</label>
    <select id="runSel"><option value="">加载中...</option></select>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-title">调用记录</div>
      <div class="trace-list" id="traceList"></div>
    </aside>
    <section class="detail" id="detail">
      <div class="detail-empty">
        <div>选择左侧一条记录查看详情</div>
        <div class="hint">展示：System Prompt、每轮输入/输出、使用的 Skills/Tools、工具执行结果</div>
      </div>
    </section>
  </div>

  <script>
(function() {
  var runSel = document.getElementById('runSel');
  var traceList = document.getElementById('traceList');
  var detail = document.getElementById('detail');
  var state = { run: '', order: [], details: {}, selId: null };

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function getJSON(url) {
    return fetch(url).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });
  }

  function firstUserMessage(det) {
    if (!det || !det.rounds || !det.rounds.length) return '';
    var msgs = det.rounds[0].messagesForLLM || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') return (msgs[i].contentPreview || '').trim();
    }
    return '';
  }

  function allToolNames(det) {
    var set = {};
    if (!det || !det.rounds) return [];
    det.rounds.forEach(function(r) {
      (r.toolResults || []).forEach(function(t) { if (t && t.toolName) set[t.toolName] = 1; });
    });
    return Object.keys(set);
  }
  /** 从 tool 名推断来源：plugin 注册的 tool 为 "pluginName.toolName"，取前缀作为 skill/plugin */
  function toolSource(toolName) {
    if (!toolName || toolName.indexOf('.') === -1) return null;
    return toolName.split('.')[0];
  }

  function loadRuns() {
    return getJSON('/api/trace/runs').then(function(runs) {
      if (!Array.isArray(runs)) runs = [];
      runSel.innerHTML = runs.length === 0
        ? '<option value="">无记录</option>'
        : runs.map(function(r) {
            var n = (r && r.name) ? String(r.name) : '';
            return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
          }).join('');
      var first = runs[0];
      runSel.value = (first && first.name) ? first.name : '';
      return runs;
    });
  }

  function renderList() {
    var ids = state.order.length ? state.order : Object.keys(state.details).sort();
    traceCount.textContent = ids.length + ' 条';
    if (!ids.length) {
      traceList.innerHTML = '<div class="empty-note" style="padding:14px">本 Run 暂无 Agent 详情</div>';
      detail.innerHTML = '<div class="detail-empty"><div>本 Run 暂无数据</div><div class="hint">请先触发一次对话并等待 Agent 执行完成</div></div>';
      return;
    }
    traceList.innerHTML = '';
    ids.forEach(function(mid) {
      var det = state.details[mid];
      var msg = firstUserMessage(det) || mid.slice(0, 24) + '…';
      var tools = allToolNames(det);
      var item = document.createElement('div');
      item.className = 'trace-item' + (state.selId === mid ? ' active' : '');
      item.dataset.id = mid;
      item.innerHTML =
        '<div class="msg">' + esc(msg.length > 50 ? msg.slice(0, 50) + '…' : msg) + '</div>' +
        '<div class="id">' + esc(mid) + '</div>' +
        '<div class="meta">' + (det.rounds ? det.rounds.length + ' 轮' : '') + (tools.length ? ' · ' + tools.length + ' 工具' : '') + '</div>';
      item.addEventListener('click', function() { selectTrace(mid); });
      traceList.appendChild(item);
    });
    if (!state.selId || !state.details[state.selId]) selectTrace(ids[0]);
    else renderDetail(state.selId);
  }

  var traceCount = document.createElement('span');
  traceCount.style.cssText = 'font-size:11px;color:var(--txt3);margin-left:8px;font-weight:400';
  document.querySelector('.sidebar-title').appendChild(traceCount);

  function selectTrace(mid) {
    state.selId = mid;
    traceList.querySelectorAll('.trace-item').forEach(function(el) {
      el.classList.toggle('active', el.dataset.id === mid);
    });
    renderDetail(mid);
  }

  function renderDetail(mid) {
    var det = state.details[mid];
    if (!det) {
      detail.innerHTML = '<div class="detail-empty">无数据</div>';
      return;
    }
    var html = '';

    html += '<div class="sec"><div class="sec-title">Message ID</div><div class="card"><div class="card-body">' + esc(mid) + '</div></div></div>';

    if (det.skillNames && det.skillNames.length) {
      html += '<div class="sec"><div class="sec-title">写入 Prompt 的 Skills</div><p class="sec-hint">上述 System Prompt 中已包含这些 skill 的说明，供模型参考（模型并未直接「调用」skill，而是根据 prompt 决定是否调用下面的 tools）</p><div class="tags">';
      det.skillNames.forEach(function(n) { html += '<span class="tag tag-skill">' + esc(n) + '</span>'; });
      html += '</div></div>';
    }
    var toolNames = allToolNames(det);
    if (toolNames.length) {
      html += '<div class="sec"><div class="sec-title">模型调用的 Tools</div><p class="sec-hint">模型在本请求中实际调用了以下工具；若工具名带前缀（如 <code>xxx.yyy</code>），则 <code>xxx</code> 为来源 skill/plugin</p><div class="tags">';
      toolNames.forEach(function(n) {
        var src = toolSource(n);
        html += '<span class="tag tag-tool">' + esc(n) + (src ? ' <span class="tag-src">← ' + esc(src) + '</span>' : '') + '</span>';
      });
      html += '</div></div>';
    }

    html += '<div class="sec"><div class="sec-title">System Prompt（发给模型的系统提示）</div>';
    html += '<div class="card"><div class="card-body wrap">' + esc(det.systemPromptPreview || '') + '</div></div></div>';

    if (det.rounds && det.rounds.length) {
      html += '<div class="sec"><div class="sec-title">Agent 多轮 <span class="badge">' + det.rounds.length + ' 轮</span></div>';
      det.rounds.forEach(function(r, idx) {
        var res = r.response || {};
        var stopCls = 'tag-stop';
        if (res.stopReason === 'tool_use') stopCls += ' tool_use';
        else if (res.stopReason === 'max_tokens') stopCls += ' max_tokens';
        html += '<div class="round">';
        html += '<div class="round-hdr">Round ' + (idx + 1) + (res.stopReason ? ' <span class="tag ' + stopCls + '">' + esc(res.stopReason) + '</span>' : '') + (res.usage ? ' <span style="color:var(--txt3);font-weight:400">' + res.usage.input + ' in / ' + res.usage.output + ' out tokens</span>' : '') + '</div>';
        html += '<div class="round-body">';

        html += '<div class="sub-sec"><div class="label">输入（发给 LLM 的消息）</div>';
        var msgs = r.messagesForLLM || [];
        if (msgs.length) {
          msgs.forEach(function(m) {
            html += '<div class="msg-row"><div class="role ' + esc(m.role || '') + '">' + esc(m.role || '') + '</div><div class="body">' + esc(m.contentPreview || '') + '</div></div>';
          });
        } else html += '<div class="content">—</div>';
        html += '</div>';

        html += '<div class="sub-sec"><div class="label">LLM 输出</div>';
        if (res.text) {
          html += '<div class="content">' + esc(res.text) + '</div>';
        } else if (res.toolCalls && res.toolCalls.length) {
          html += '<div class="content">调用了 ' + res.toolCalls.length + ' 个工具：';
          res.toolCalls.forEach(function(tc) { html += '<br>' + esc(tc.name) + ': ' + esc(tc.inputPreview || ''); });
          html += '</div>';
        } else html += '<div class="content">—</div>';
        html += '</div>';

        if (r.toolResults && r.toolResults.length) {
          html += '<div class="sub-sec"><div class="label">本轮模型调用的工具及执行结果</div>';
          r.toolResults.forEach(function(t) {
            var src = toolSource(t.toolName);
            html += '<div class="tool-block">';
            html += '<div class="tool-hdr">' + esc(t.toolName) + (src ? ' <span class="tool-from">← ' + esc(src) + '</span>' : '') + (t.isError ? ' <span class="err">error</span>' : '') + '</div>';
            html += '<div class="tool-io" style="display:grid;grid-template-columns:1fr 1fr">';
            html += '<div><div class="lbl">Input</div>' + esc(t.inputPreview || '') + '</div>';
            html += '<div><div class="lbl">Output</div>' + esc(t.contentPreview || '') + '</div>';
            html += '</div></div>';
          });
          html += '</div>';
        }
        html += '</div></div>';
      });
      html += '</div>';
    }
    detail.innerHTML = html;
  }

  function loadDetails() {
    var run = runSel.value;
    state.run = run;
    state.selId = null;
    if (!run) {
      traceList.innerHTML = '<div class="empty-note" style="padding:14px">请选择 Run</div>';
      detail.innerHTML = '<div class="detail-empty"><div>请先选择 Run</div></div>';
      return;
    }
    traceList.innerHTML = '<div class="empty-note" style="padding:14px">加载中...</div>';
    getJSON('/api/trace/details?run=' + encodeURIComponent(run)).then(function(d) {
      if (d && typeof d === 'object' && Array.isArray(d.order)) {
        state.order = d.order;
        state.details = d.details || {};
      } else {
        state.order = [];
        state.details = (d && typeof d === 'object') ? d : {};
      }
      renderList();
    }).catch(function() {
      state.order = [];
      state.details = {};
      traceList.innerHTML = '<div class="empty-note" style="padding:14px">加载失败</div>';
    });
  }

  runSel.addEventListener('change', function() { loadDetails(); });
  loadRuns().then(function() {
    if (runSel.value) loadDetails();
    else traceList.innerHTML = '<div class="empty-note" style="padding:14px">暂无 Run，请先触发一次对话</div>';
  }).catch(function() {
    runSel.innerHTML = '<option value="">加载失败</option>';
  });
})();
  </script>
</body>
</html>`;
