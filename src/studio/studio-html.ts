export function renderStudioHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsPower Flow Studio — Diseñador de Flujos</title>
  <style>
    :root {
      --bg: #090d16;
      --panel: #111827;
      --panel-border: #1f2937;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --node-trigger: #10b981;
      --node-msg: #3b82f6;
      --node-input: #06b6d4;
      --node-action: #8b5cf6;
      --node-cond: #f59e0b;
      --node-ab: #ec4899;
      --node-handoff: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

    /* Header */
    header { background: var(--panel); border-bottom: 1px solid var(--panel-border); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 20; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 32px; height: 32px; background: linear-gradient(135deg, #10b981, #2563eb); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 16px; }
    .brand-title { font-size: 16px; font-weight: 700; color: #fff; }
    .brand-sub { font-size: 12px; color: var(--text-muted); background: #1e293b; padding: 2px 8px; border-radius: 12px; }
    .actions-bar { display: flex; align-items: center; gap: 12px; }
    select, button { padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid var(--panel-border); }
    select { background: #1f2937; color: #fff; outline: none; }
    .btn-primary { background: var(--accent); color: #fff; border: none; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { background: #1f2937; color: #e5e7eb; }
    .btn-secondary:hover { background: #374151; }

    /* Main workspace */
    .workspace { display: flex; flex: 1; overflow: hidden; position: relative; }

    /* Palette Sidebar */
    .palette { width: 240px; background: var(--panel); border-right: 1px solid var(--panel-border); padding: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 10; overflow-y: auto; }
    .palette-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700; margin-bottom: 4px; }
    .palette-item { background: #1f2937; border: 1px solid #374151; padding: 8px 10px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 12px; transition: all 0.2s; }
    .palette-item:hover { border-color: var(--accent); transform: translateX(2px); background: #283548; }
    .palette-icon { width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; }

    /* Canvas */
    .canvas-container { flex: 1; position: relative; overflow: auto; background-image: radial-gradient(#1f2937 1px, transparent 1px); background-size: 20px 20px; background-color: var(--bg); }
    #canvas { width: 2600px; height: 1800px; position: relative; }
    svg#edgesSvg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }

    /* Nodes */
    .node { position: absolute; width: 260px; background: #1f2937; border: 1px solid #374151; border-radius: 10px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.4); user-select: none; transition: box-shadow 0.2s; }
    .node:hover { box-shadow: 0 10px 25px -3px rgba(0,0,0,0.6); }
    .node-header { padding: 8px 12px; border-top-left-radius: 9px; border-top-right-radius: 9px; display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: #fff; }
    .node-trigger .node-header { background: #064e3b; border-bottom: 2px solid var(--node-trigger); }
    .node-send_message .node-header { background: #1e3a8a; border-bottom: 2px solid var(--node-msg); }
    .node-user_input .node-header { background: #155e75; border-bottom: 2px solid var(--node-input); }
    .node-condition .node-header { background: #78350f; border-bottom: 2px solid var(--node-cond); }
    .node-action .node-header { background: #4c1d95; border-bottom: 2px solid var(--node-action); }
    .node-crm_action .node-header { background: #4c1d95; border-bottom: 2px solid var(--node-action); }
    .node-ab_split .node-header { background: #831843; border-bottom: 2px solid var(--node-ab); }
    .node-handoff .node-header { background: #7f1d1d; border-bottom: 2px solid var(--node-handoff); }
    .node-body { padding: 10px 12px; font-size: 12px; color: #d1d5db; line-height: 1.4; }
    .node-buttons { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .node-btn-opt { background: #111827; border: 1px solid #374151; border-radius: 4px; padding: 4px 8px; font-size: 11px; color: #93c5fd; display: flex; justify-content: space-between; }

    /* Simulator Sidebar */
    .simulator { width: 340px; background: var(--panel); border-left: 1px solid var(--panel-border); display: flex; flex-direction: column; z-index: 10; }
    .sim-header { padding: 12px 16px; border-bottom: 1px solid var(--panel-border); display: flex; justify-content: space-between; align-items: center; }
    .sim-title { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .sim-badge { font-size: 10px; background: #064e3b; color: #6ee7b7; padding: 2px 6px; border-radius: 9999px; }
    .sim-phone { flex: 1; display: flex; flex-direction: column; background: #0b141a; padding: 12px; overflow-y: auto; gap: 8px; }
    .sim-bubble { max-width: 82%; padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.4; word-break: break-word; }
    .sim-bubble-in { background: #202c33; color: #e9edef; align-self: flex-start; border-bottom-left-radius: 2px; }
    .sim-bubble-out { background: #005c4b; color: #e9edef; align-self: flex-end; border-bottom-right-radius: 2px; }
    .sim-action-log { background: #3b0764; color: #e9d5ff; border: 1px solid #7e22ce; padding: 4px 8px; border-radius: 6px; font-size: 10px; align-self: center; margin: 2px 0; text-align: center; }
    .sim-tag-log { background: #064e3b; color: #a7f3d0; border: 1px solid #059669; padding: 4px 8px; border-radius: 6px; font-size: 10px; align-self: center; margin: 2px 0; text-align: center; }
    .sim-input-box { padding: 10px; background: #202c33; display: flex; gap: 8px; }
    .sim-input { flex: 1; background: #2a3942; border: none; border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 12px; outline: none; }
    .sim-send { background: #00a884; color: #fff; border: none; border-radius: 8px; width: 34px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-weight: bold; }
    /* ---- Lienzo interactivo: arrastrar y conectar nodos ---- */
    .node { cursor: grab; touch-action: none; }
    body.is-dragging .node { cursor: grabbing; }
    body.is-dragging * { user-select: none; }
    .node.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(37,99,235,.6), 0 10px 15px -3px rgba(0,0,0,.45); }
    .node.is-moving { opacity: .96; }

    /* Puertos: el punto de la derecha es el tirador para crear una flecha */
    .port { position: absolute; border: none; background: transparent; padding: 0; z-index: 3; }
    .port-out { right: -12px; display: flex; flex-direction: row-reverse; align-items: center; gap: 5px; cursor: crosshair; }
    .port-dot { display: block; width: 14px; height: 14px; border-radius: 50%; background: #3b82f6; border: 2px solid #0b1220; box-shadow: 0 0 0 1px #60a5fa; transition: transform .12s; }
    .port-out:hover .port-dot { background: #22d3ee; transform: scale(1.2); }
    .port-alt .port-dot { background: #f59e0b; box-shadow: 0 0 0 1px #fbbf24; }
    .port-label { font-size: 10px; color: #cbd5e1; opacity: 0; transition: opacity .12s; white-space: nowrap; }
    .port-out:hover .port-label, .node.is-selected .port-label { opacity: 1; }
    .port-in { left: -7px; top: 31px; width: 10px; height: 10px; border-radius: 50%; background: #111827; border: 2px solid #4b5563; pointer-events: none; }

    /* Flechas */
    .edge { fill: none; stroke: #3b82f6; stroke-width: 2; pointer-events: stroke; cursor: pointer; }
    .edge:hover { stroke: #60a5fa; stroke-width: 3; }
    .edge.is-selected { stroke: #f59e0b; stroke-width: 3; }
    .edge-temp { fill: none; stroke: #22d3ee; stroke-width: 2; stroke-dasharray: 6 4; pointer-events: none; }

    /* Aviso de uso y mensajes del lienzo */
    .canvas-hint { position: absolute; left: 256px; bottom: 12px; z-index: 6; max-width: 620px; background: rgba(17,24,39,.94); border: 1px solid var(--panel-border); color: #9ca3af; font-size: 11px; line-height: 1.35; padding: 6px 10px; border-radius: 8px; pointer-events: none; }
    .studio-toast { position: absolute; right: 356px; bottom: 12px; z-index: 16; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; }
    .toast-line { background: #1e293b; border: 1px solid #334155; color: #e5e7eb; font-size: 12px; padding: 6px 10px; border-radius: 8px; }
    .save-state { font-size: 11px; color: var(--text-muted); }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">⚡</div>
      <div>
        <div class="brand-title">WhatsPower Flow Studio</div>
      </div>
      <span class="brand-sub">Nivel 2 · Flujos conversacionales</span>
    </div>

    <div class="actions-bar">
      <select id="flowSelect"></select>
      <span class="save-state" id="saveState">Sin cambios</span>
      <button class="btn-primary" onclick="saveCurrentFlow()">💾 Guardar y Activar</button>
    </div>
  </header>

  <div class="workspace">
    <div class="canvas-hint" id="canvasHint"></div>
    <div class="studio-toast" id="studioToast"></div>
    <!-- Palette -->
    <div class="palette">
      <div class="palette-title">Catálogo de Nodos</div>
      <div class="palette-item" onclick="addNode('send_message')">
        <div class="palette-icon" style="background:#1e3a8a;">💬</div>
        <span>Enviar Mensaje</span>
      </div>
      <div class="palette-item" onclick="addNode('user_input')">
        <div class="palette-icon" style="background:#155e75;">📥</div>
        <span>Captura User Input</span>
      </div>
      <div class="palette-item" onclick="addNode('condition')">
        <div class="palette-icon" style="background:#78350f;">🔀</div>
        <span>Bifurcación Condición</span>
      </div>
      <div class="palette-item" onclick="addNode('action_tag')">
        <div class="palette-icon" style="background:#4c1d95;">🏷️</div>
        <span>Etiquetar (Tag)</span>
      </div>
      <div class="palette-item" onclick="addNode('crm_action')">
        <div class="palette-icon" style="background:#4c1d95;">⚡</div>
        <span>Acción CRM ALBRA</span>
      </div>
      <div class="palette-item" onclick="addNode('ab_split')">
        <div class="palette-icon" style="background:#831843;">🎲</div>
        <span>Split Test A/B</span>
      </div>
      <div class="palette-item" onclick="addNode('handoff')">
        <div class="palette-icon" style="background:#7f1d1d;">👤</div>
        <span>Handoff a Asesor</span>
      </div>

      <div style="margin-top:auto; padding-top:12px; border-top:1px solid var(--panel-border); font-size:10px; color:#6b7280; line-height:1.4;">
        <strong>100% Integrado:</strong><br>
        Tags, Custom Fields, Drip Sequences y CRM Canónico.
      </div>
    </div>

    <!-- Canvas -->
    <div class="canvas-container">
      <div id="canvas">
        <svg id="edgesSvg"></svg>
        <div id="nodesLayer"></div>
      </div>
    </div>

    <!-- Live WhatsApp Simulator -->
    <div class="simulator">
      <div class="sim-header">
        <div class="sim-title">
          <span>📱 Simulador de Conversación</span>
          <span class="sim-badge">En Vivo</span>
        </div>
        <button class="btn-secondary" style="padding:2px 6px; font-size:10px;" onclick="clearSim()">Reiniciar</button>
      </div>

      <div class="sim-phone" id="simPhone">
        <div class="sim-bubble sim-bubble-in" style="align-self:center; background:#182229; font-size:10px; color:#8696a0; text-align:center;">
          🔒 Simulación de conversación en vivo. Escribe <strong>"PRECIO"</strong> o <strong>"INFO"</strong> para iniciar.
        </div>
      </div>

      <div class="sim-input-box">
        <input class="sim-input" id="simInput" placeholder="Escribe un mensaje de WhatsApp..." onkeydown="if(event.key==='Enter') sendSimMessage()">
        <button class="sim-send" onclick="sendSimMessage()">➤</button>
      </div>
    </div>
  </div>

  <script>
  // ============================================================
  // (tercera reparación 4.F) Canje de sesión por cookie HttpOnly:
  // el secreto administrativo se envía UNA vez a /studio/login y el backend
  // responde con cookie HttpOnly + SameSite=Strict. El secreto JAMÁS toca
  // sessionStorage (antes un XSS podía leerlo). La org del operador NO es
  // secreto y viaja como X-Org-Id en toda llamada /api/.
  // ============================================================
  (function () {
    const _fetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (u.includes('/api/') && !u.includes('/api/health')) {
          init = init || {};
          init.credentials = 'same-origin';
          init.headers = Object.assign({}, init.headers || {}, { 'X-Org-Id': (sessionStorage.getItem('wp_org') || 'default') });
        }
      } catch (e) {}
      return _fetch(input, init);
    };
    async function studioLogin() {
      const k = window.prompt('Introduce el secreto administrativo (se canjea UNA vez por una cookie HttpOnly; jamás se guarda en JS):');
      if (!k) {
        document.body.innerHTML = '<p style="font-family:system-ui;padding:24px">Se requiere el secreto administrativo para usar el studio.</p>';
        return;
      }
      try {
        const res = await _fetch('/studio/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: k }) });
        if (!res.ok) {
          document.body.innerHTML = '<p style="font-family:system-ui;padding:24px">Credencial inválida. Recarga e inténtalo de nuevo.</p>';
          return;
        }
      } catch (e) {
        document.body.innerHTML = '<p style="font-family:system-ui;padding:24px">Error de red en el login.</p>';
        return;
      }
    }
    window.addEventListener('DOMContentLoaded', async function () {
      try { await _fetch('/api/health'); } catch (e) {}
      const probe = await _fetch('/api/flows');
      if (probe.status === 401) { await studioLogin(); }
      if (!sessionStorage.getItem('wp_org')) {
        const org = window.prompt('Organización de trabajo (X-Org-Id):', 'default');
        sessionStorage.setItem('wp_org', (org || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default');
      }
      loadFlows();
    });
  })();
  </script>
  <script>
    let currentFlow = null;
    let flowsList = [];

    // (tercera reparación 4.F/5.C-paridad) Escape de HTML para TODO dato de flujo
    // renderizado: el contenido de los flujos viaja por API y jamás se interpola
    // sin escapar (defensa en profundidad anti-XSS almacenado).
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escMultiline(v) {
      return esc(v).replace(/\\n/g, '<br>');
    }

    async function loadFlows() {
      try {
        const res = await fetch('/api/flows');
        flowsList = await res.json();
        const sel = document.getElementById('flowSelect');
        sel.innerHTML = '';
        flowsList.forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = f.name;
          sel.appendChild(opt);
        });
        if (flowsList.length > 0) {
          selectFlow(flowsList[0].id);
        }
      } catch (err) {
        console.error('Error cargando flujos:', err);
      }
    }

    document.getElementById('flowSelect').addEventListener('change', (e) => {
      selectFlow(e.target.value);
    });

    function selectFlow(flowId) {
      currentFlow = flowsList.find(f => f.id === flowId);
      if (currentFlow) {
        renderCanvas();
      }
    }

    function renderCanvas() {
      const container = document.getElementById('nodesLayer');
      container.innerHTML = '';
      if (!currentFlow) return;

      currentFlow.nodes.forEach(node => {
        const div = document.createElement('div');
        div.className = 'node node-' + node.type;
        div.dataset.nodeId = node.id;
        div.dataset.nodeType = node.type;
        if (selectedNodeId === node.id) div.className += ' is-selected';
        const npos = nodePos(node);
        div.style.left = npos.x + 'px';
        div.style.top = npos.y + 'px';

        let icon = '💬';
        let bodyHtml = '';
        // Un nodo recién creado puede no traer data: sin esto la página entera
        // se caía al pintar el lienzo ("reading 'keywords'").
        const nd = node.data || {};

        if (node.type === 'trigger') {
          icon = '🚀';
          bodyHtml = '<strong>Keywords:</strong> ' + (nd.keywords || []).map(k => '<span style=\"background:#064e3b; padding:1px 5px; border-radius:3px; font-size:10px;\">' + esc(k) + '</span>').join(' ');
        } else if (node.type === 'send_message') {
          icon = '💬';
          bodyHtml = '<div>' + escMultiline(nd.messageText || '') + '</div>';
          if (nd.buttons && nd.buttons.length > 0) {
            bodyHtml += '<div class=\"node-buttons\">' + nd.buttons.map((b, i) => '<div class=\"node-btn-opt\"><span>' + (i+1) + '. ' + esc(b) + '</span><span style=\"color:#60a5fa;\">Opción ' + (i+1) + '</span></div>').join('') + '</div>';
          }
        } else if (node.type === 'user_input') {
          icon = '📥';
          bodyHtml = '<div>Prompt: <em>\"' + esc(nd.inputPrompt || '') + '\"</em></div><div style=\"color:#38bdf8; margin-top:4px;\">Guardar en: <code>' + esc(nd.saveToCustomField || '') + '</code></div>';
        } else if (node.type === 'condition') {
          icon = '🔀';
          bodyHtml = '<div>Reglas: ' + (nd.rules || []).map(r => '<code>' + esc(r.type) + ': ' + esc(r.value) + '</code>').join('<br>') + '</div><div style=\"display:flex; justify-content:space-between; margin-top:6px;\"><span style=\"color:#10b981;\">✔ Sí</span><span style=\"color:#ef4444;\">✖ No</span></div>';
        } else if (node.type === 'action') {
          icon = '🏷️';
          bodyHtml = '<div>Acción: <code>' + (nd.actionType || '') + '</code></div><div style=\"color:#c084fc;\">Etiqueta: ' + esc(nd.tag || '') + '</div>';
        } else if (node.type === 'crm_action') {
          icon = '⚡';
          bodyHtml = '⚡ <strong>Acción ALBRA:</strong> <code>' + esc(nd.crmAction || '') + '</code><br><span style=\"color:#c084fc;\">Monto: $' + esc(nd.crmParams?.amount || 0) + '</span>';
        } else if (node.type === 'ab_split') {
          icon = '🎲';
          bodyHtml = '<div>Split Ratio: <strong>' + (nd.splitRatio || 50) + '% / ' + (100 - (nd.splitRatio || 50)) + '%</strong></div><div style=\"display:flex; justify-content:space-between; margin-top:6px;\"><span style=\"color:#f472b6;\">Rama A</span><span style=\"color:#38bdf8;\">Rama B</span></div>';
        } else if (node.type === 'handoff') {
          icon = '👤';
          bodyHtml = '🚨 <strong>Silenciar Bot</strong> y transferir a asesor comercial humano.';
        }

        div.innerHTML = \`
          <div class="node-header">
            <span>\${icon}</span>
            <span>\${esc(node.title)}</span>
          </div>
          <div class="node-body">\${bodyHtml}</div>
        \`;
        appendPorts(div, node);
        container.appendChild(div);
      });

      renderEdges();
    }

    // (producción real F6) La paleta anuncaba 7 nodos pero addNode NO existía:
    // el clic lanzaba ReferenceError y jamás aparecía el nodo en el lienzo.
    // Defaults por clave de paleta; el tipo debe ser un FlowNodeType válido del
    // motor (la paleta usa 'action_tag' como clave comercial, el motor espera
    // type 'action'). Si no hay flujo seleccionado se crea un borrador local
    // (se persiste con "Guardar y Activar").
    const NODE_PALETTE_DEFAULTS = {
      'send_message': { title: 'Enviar Mensaje', data: { messageText: '' } },
      'user_input': { title: 'Captura User Input', data: { inputPrompt: '', saveToCustomField: '' } },
      'condition': { title: 'Bifurcación Condición', data: { rules: [] } },
      'action_tag': { type: 'action', title: 'Etiquetar (Tag)', data: { actionType: 'add_tag', tag: '' } },
      'crm_action': { title: 'Acción CRM ALBRA', data: { crmAction: 'add_note', crmParams: {} } },
      'ab_split': { title: 'Split Test A/B', data: { splitRatio: 50 } },
      'handoff': { title: 'Handoff a Asesor', data: {} },
    };
    function addNode(paletteKey) {
      const def = NODE_PALETTE_DEFAULTS[paletteKey];
      if (!def) return;
      if (!currentFlow) {
        const draft = {
          id: 'flow_' + Date.now(),
          name: 'Flujo sin título',
          triggerKeywords: [],
          isActive: false,
          nodes: [],
          edges: [],
        };
        currentFlow = draft;
        flowsList.push(draft);
        draftMode = true;
        const sel = document.getElementById('flowSelect');
        const opt = document.createElement('option');
        opt.value = draft.id;
        opt.textContent = draft.name + ' (borrador sin guardar)';
        sel.appendChild(opt);
        sel.value = draft.id;
      }
      const index = currentFlow.nodes.length;
      const node = {
        id: 'n' + (index + 1) + '_' + Math.random().toString(36).slice(2, 7),
        type: def.type || paletteKey,
        title: def.title,
        position: { x: 40 + (index % 4) * 210, y: 40 + Math.floor(index / 4) * 150 },
        data: JSON.parse(JSON.stringify(def.data)),
      };
      snapshot();
      currentFlow.nodes.push(node);
      renderCanvas();
      scheduleSave('Nodo añadido');
    }

    function renderEdges() {
      const svg = document.getElementById('edgesSvg');
      svg.innerHTML = '';
      // Cabeza de flecha: se dibuja una sola vez por pintado y la usan todas.
      const defs = document.createElementNS(SVG_NS, 'defs');
      defs.innerHTML = '<marker id="edgeArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6"></path></marker>';
      svg.appendChild(defs);
      if (!currentFlow || !currentFlow.edges) return;

      currentFlow.edges.forEach(edge => {
        const sourceNode = currentFlow.nodes.find(n => n.id === edge.source);
        const targetNode = currentFlow.nodes.find(n => n.id === edge.target);
        if (!sourceNode || !targetNode) return;

        const spos = nodePos(sourceNode);
        const tpos = nodePos(targetNode);
        const x1 = spos.x + NODE_W;
        const y1 = spos.y + PORT_TOP;
        const x2 = tpos.x;
        const y2 = tpos.y + PORT_TOP;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const dx = Math.abs(x2 - x1) * 0.5;
        const d = \`M \${x1} \${y1} C \${x1 + dx} \${y1}, \${x2 - dx} \${y2}, \${x2} \${y2}\`;
        path.setAttribute('d', d);
        const eid = edgeKey(edge);
        path.setAttribute('class', 'edge' + (eid === selectedEdgeId ? ' is-selected' : ''));
        path.dataset.edgeId = eid;
        path.setAttribute('stroke', '#3b82f6');
        path.setAttribute('marker-end', 'url(#edgeArrow)');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('fill', 'none');
        svg.appendChild(path);
      });
    }

    async function saveCurrentFlow() {
      if (!currentFlow) return;
      try {
        const res = await fetch('/api/flows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentFlow)
        });
        if (res.ok) {
          alert('✅ Flujo guardado y activado exitosamente en WhatsPower.');
        }
      } catch (err) {
        alert('Error guardando flujo: ' + err.message);
      }
    }

    // Simulador
    // ============================================================
    // LIENZO INTERACTIVO: arrastrar nodos y conectarlos.
    //  · Arrastrar la caja de un nodo mueve su posición y se guarda sola.
    //  · Cada nodo tiene puertos de salida a la derecha; arrastrar desde un
    //    puerto hasta otro nodo crea la flecha (edge) con el sourceHandle que
    //    el motor espera: default, yes/no (condición) o a/b (split).
    //  · Supr borra la flecha o el nodo seleccionado; Ctrl+Z deshace.
    // Los manejadores van por delegación en #canvas, así que repintar el
    // lienzo (renderCanvas) no los pierde nunca.
    // ============================================================
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NODE_W = 260;
    const PORT_TOP = 35;
    let dragState = null;
    let linkState = null;
    let selectedNodeId = null;
    let selectedEdgeId = null;
    let undoStack = [];
    let saveTimer = null;
    let draftMode = false;

    function nodeById(id) {
      if (!currentFlow || !currentFlow.nodes) return null;
      return currentFlow.nodes.find(function (n) { return n.id === id; }) || null;
    }

    function nodePos(node) {
      const p = node && node.position ? node.position : {};
      return { x: typeof p.x === 'number' ? p.x : 100, y: typeof p.y === 'number' ? p.y : 100 };
    }

    function edgeKey(edge) {
      return edge.id || ('e_' + edge.source + '_' + edge.target);
    }

    function outPorts(node) {
      if (node.type === 'condition') return [{ handle: 'yes', label: 'Sí' }, { handle: 'no', label: 'No' }];
      if (node.type === 'ab_split') return [{ handle: 'a', label: 'A' }, { handle: 'b', label: 'B' }];
      return [{ handle: 'default', label: 'Salida' }];
    }

    function curvePath(x1, y1, x2, y2) {
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    }

    function canvasPoint(ev) {
      const rect = document.getElementById('canvas').getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function setSaveState(text) {
      const el = document.getElementById('saveState');
      if (el) el.textContent = text;
    }

    function toast(text) {
      const box = document.getElementById('studioToast');
      if (!box) return;
      const line = document.createElement('div');
      line.className = 'toast-line';
      line.textContent = text;
      box.appendChild(line);
      setTimeout(function () { if (line.parentNode) line.parentNode.removeChild(line); }, 2800);
    }

    // Foto del flujo antes de cada cambio, para poder deshacer.
    function snapshot() {
      if (!currentFlow) return;
      try {
        undoStack.push(JSON.stringify({ nodes: currentFlow.nodes, edges: currentFlow.edges || [] }));
        if (undoStack.length > 40) undoStack.shift();
      } catch (e) {}
    }

    function undo() {
      if (!currentFlow || undoStack.length === 0) { toast('No hay nada que deshacer'); return; }
      const prev = JSON.parse(undoStack.pop());
      currentFlow.nodes = prev.nodes || [];
      currentFlow.edges = prev.edges || [];
      selectedNodeId = null;
      selectedEdgeId = null;
      renderCanvas();
      paintSelectionInfo();
      scheduleSave('Cambio deshecho');
    }

    // Guardado automático con un pequeño retardo: mover o conectar no se
    // pierde al recargar, y arrastrar no dispara una petición por píxel.
    function scheduleSave(label) {
      setSaveState('Guardando…');
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { persistFlow(label); }, 700);
    }

    async function persistFlow(label) {
      if (!currentFlow) return;
      try {
        const res = await fetch('/api/flows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentFlow)
        });
        if (!res.ok) {
          setSaveState('Sin guardar (HTTP ' + res.status + ')');
          toast('No se pudo guardar: HTTP ' + res.status);
          return;
        }
        setSaveState('Guardado ✓');
        if (draftMode) {
          draftMode = false;
          const sel = document.getElementById('flowSelect');
          if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt) opt.textContent = currentFlow.name;
          }
        }
        if (label) toast(label);
      } catch (err) {
        setSaveState('Sin conexión con el servidor');
        toast('No se pudo guardar: ' + err.message);
      }
    }

    function appendPorts(div, node) {
      outPorts(node).forEach(function (p, i) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'port port-out' + (p.handle === 'no' || p.handle === 'b' ? ' port-alt' : '');
        btn.dataset.nodeId = node.id;
        btn.dataset.handle = p.handle;
        btn.title = 'Arrastra desde aquí hasta otro nodo para unirlos (' + p.label + ')';
        btn.style.top = (PORT_TOP + i * 26) + 'px';
        const dot = document.createElement('span');
        dot.className = 'port-dot';
        const lab = document.createElement('span');
        lab.className = 'port-label';
        lab.textContent = p.label;
        btn.appendChild(dot);
        btn.appendChild(lab);
        div.appendChild(btn);
      });
      const inDot = document.createElement('span');
      inDot.className = 'port port-in';
      div.appendChild(inDot);
    }

    function paintSelectionInfo() {
      const hint = document.getElementById('canvasHint');
      if (!hint) return;
      const node = selectedNodeId ? nodeById(selectedNodeId) : null;
      if (node) { hint.textContent = 'Seleccionado: ' + node.title + ' · arrastra para moverlo · Supr lo borra con sus flechas'; return; }
      if (selectedEdgeId) { hint.textContent = 'Flecha seleccionada · Supr la elimina'; return; }
      hint.textContent = 'Arrastra un nodo para moverlo · arrastra desde un punto de la derecha hasta otro nodo para conectarlos · Supr borra · Ctrl+Z deshace';
    }

    function selectNode(id) {
      selectedNodeId = id;
      if (id) selectedEdgeId = null;
      const layer = document.getElementById('nodesLayer');
      if (layer) {
        Array.prototype.forEach.call(layer.children, function (el) {
          if (el.dataset && el.dataset.nodeId === id) el.classList.add('is-selected');
          else el.classList.remove('is-selected');
        });
      }
      paintSelectionInfo();
    }

    function selectEdge(id) {
      selectedEdgeId = id;
      if (id) selectedNodeId = null;
      const svg = document.getElementById('edgesSvg');
      if (svg) {
        Array.prototype.forEach.call(svg.querySelectorAll('.edge'), function (el) {
          if (el.dataset && el.dataset.edgeId === id) el.classList.add('is-selected');
          else el.classList.remove('is-selected');
        });
      }
      paintSelectionInfo();
    }

    function deleteEdge(id) {
      if (!currentFlow || !currentFlow.edges) return;
      const idx = currentFlow.edges.findIndex(function (e) { return edgeKey(e) === id; });
      if (idx < 0) return;
      snapshot();
      currentFlow.edges.splice(idx, 1);
      selectedEdgeId = null;
      renderEdges();
      paintSelectionInfo();
      scheduleSave('Flecha eliminada');
    }

    function deleteNode(id) {
      if (!currentFlow || !currentFlow.nodes) return;
      if (!nodeById(id)) return;
      snapshot();
      currentFlow.nodes = currentFlow.nodes.filter(function (n) { return n.id !== id; });
      currentFlow.edges = (currentFlow.edges || []).filter(function (e) { return e.source !== id && e.target !== id; });
      selectedNodeId = null;
      renderCanvas();
      paintSelectionInfo();
      scheduleSave('Nodo eliminado');
    }

    function startDrag(el, ev) {
      const node = nodeById(el.dataset.nodeId);
      if (!node) return;
      const pos = nodePos(node);
      node.position = { x: pos.x, y: pos.y };
      const p = canvasPoint(ev);
      snapshot();
      dragState = { node: node, el: el, dx: p.x - pos.x, dy: p.y - pos.y, moved: false };
      selectNode(node.id);
      document.body.classList.add('is-dragging');
      el.classList.add('is-moving');
    }

    function onDragMove(ev) {
      if (!dragState) return;
      const p = canvasPoint(ev);
      const x = Math.max(0, Math.round(p.x - dragState.dx));
      const y = Math.max(0, Math.round(p.y - dragState.dy));
      if (x === dragState.node.position.x && y === dragState.node.position.y) return;
      dragState.node.position = { x: x, y: y };
      dragState.el.style.left = x + 'px';
      dragState.el.style.top = y + 'px';
      dragState.moved = true;
      renderEdges();
    }

    function endDrag() {
      const st = dragState;
      dragState = null;
      document.body.classList.remove('is-dragging');
      if (!st) return;
      if (st.el) st.el.classList.remove('is-moving');
      if (!st.moved) {
        // Un clic sin mover no es un cambio: se tira la foto para deshacer.
        undoStack.pop();
        return;
      }
      scheduleSave('Posición guardada');
    }

    function startLink(nodeId, handle, ev) {
      const src = nodeById(nodeId);
      if (!src) return;
      const svg = document.getElementById('edgesSvg');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'edge edge-temp');
      svg.appendChild(path);
      linkState = { sourceId: nodeId, handle: handle || 'default', path: path };
      selectNode(nodeId);
      onLinkMove(ev);
    }

    function onLinkMove(ev) {
      if (!linkState) return;
      const src = nodeById(linkState.sourceId);
      if (!src) return;
      const pos = nodePos(src);
      const p = canvasPoint(ev);
      linkState.path.setAttribute('d', curvePath(pos.x + NODE_W, pos.y + PORT_TOP, p.x, p.y));
    }

    function endLink(ev) {
      const st = linkState;
      linkState = null;
      if (!st) return;
      if (st.path && st.path.parentNode) st.path.parentNode.removeChild(st.path);
      if (!ev) { renderEdges(); return; }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetEl = under && under.closest ? under.closest('.node') : null;
      if (!targetEl) {
        renderEdges();
        toast('Suelta la flecha encima de otro nodo para unirlos');
        return;
      }
      connectNodes(st.sourceId, targetEl.dataset.nodeId, st.handle);
    }

    function connectNodes(sourceId, targetId, handle) {
      if (!currentFlow || !sourceId || !targetId) return;
      if (sourceId === targetId) { renderEdges(); toast('Un nodo no puede unirse consigo mismo'); return; }
      currentFlow.edges = currentFlow.edges || [];
      const dup = currentFlow.edges.some(function (e) {
        return e.source === sourceId && e.target === targetId && (e.sourceHandle || 'default') === handle;
      });
      if (dup) { renderEdges(); toast('Esos dos nodos ya están unidos por esa salida'); return; }
      snapshot();
      currentFlow.edges.push({
        id: 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        source: sourceId,
        target: targetId,
        sourceHandle: handle
      });
      renderEdges();
      scheduleSave('Conexión creada');
    }

    (function wireCanvas() {
      const canvas = document.getElementById('canvas');
      if (!canvas) return;

      canvas.addEventListener('pointerdown', function (ev) {
        if (!currentFlow || ev.button !== 0) return;
        const t = ev.target;
        const portEl = t && t.closest ? t.closest('.port-out') : null;
        if (portEl) {
          ev.preventDefault();
          startLink(portEl.dataset.nodeId, portEl.dataset.handle, ev);
          return;
        }
        const nodeEl = t && t.closest ? t.closest('.node') : null;
        if (nodeEl) {
          ev.preventDefault();
          startDrag(nodeEl, ev);
          return;
        }
        const edgeEl = t && t.closest ? t.closest('.edge') : null;
        if (edgeEl) { selectEdge(edgeEl.dataset.edgeId); return; }
        selectNode(null);
        selectEdge(null);
      });

      window.addEventListener('pointermove', function (ev) {
        if (dragState) onDragMove(ev);
        else if (linkState) onLinkMove(ev);
      });

      window.addEventListener('pointerup', function (ev) {
        if (dragState) { endDrag(); return; }
        if (linkState) endLink(ev);
      });

      window.addEventListener('pointercancel', function () {
        if (dragState) endDrag();
        if (linkState) endLink(null);
      });

      document.addEventListener('keydown', function (ev) {
        const tag = (ev.target && ev.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); undo(); return; }
        if (ev.key === 'Delete' || ev.key === 'Backspace') {
          if (selectedEdgeId) { ev.preventDefault(); deleteEdge(selectedEdgeId); }
          else if (selectedNodeId) { ev.preventDefault(); deleteNode(selectedNodeId); }
          return;
        }
        if (ev.key === 'Escape') { selectNode(null); selectEdge(null); }
      });

      paintSelectionInfo();
    })();

    let simPhone = '+573000000099';

    async function sendSimMessage() {
      const input = document.getElementById('simInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';

      addSimBubble(text, 'out');

      try {
        const res = await fetch('/api/flows/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: simPhone, messageText: text, name: 'Lead Demo' })
        });
        const data = await res.json();

        if (data.tagsToAdd && data.tagsToAdd.length > 0) {
          data.tagsToAdd.forEach(t => addSimTagLog('🏷️ Tag asignado: #' + t));
        }

        if (data.actionsToExecute && data.actionsToExecute.length > 0) {
          data.actionsToExecute.forEach(act => {
            addSimActionLog('⚡ Acción CRM ALBRA: ' + act.action + ' ($' + (act.params.amount || 0) + ')');
          });
        }

        if (data.isHandoff) {
          addSimActionLog('👤 Handoff Humano activado (Bot pausado)');
        }

        if (data.messagesToSend && data.messagesToSend.length > 0) {
          data.messagesToSend.forEach(msg => {
            const txt = typeof msg === 'string' ? msg : msg.text;
            addSimBubble(txt, 'in');
          });
        }
      } catch (err) {
        addSimBubble('Error simulando: ' + err.message, 'in');
      }
    }

    function addSimBubble(text, dir) {
      const phone = document.getElementById('simPhone');
      const div = document.createElement('div');
      div.className = 'sim-bubble sim-bubble-' + dir;
      // (4.F) El texto de los mensajes se escapa: jamás innerHTML con datos crudos
      div.innerHTML = escMultiline(text);
      phone.appendChild(div);
      phone.scrollTop = phone.scrollHeight;
    }

    function addSimActionLog(text) {
      const phone = document.getElementById('simPhone');
      const div = document.createElement('div');
      div.className = 'sim-action-log';
      div.textContent = text;
      phone.appendChild(div);
      phone.scrollTop = phone.scrollHeight;
    }

    function addSimTagLog(text) {
      const phone = document.getElementById('simPhone');
      const div = document.createElement('div');
      div.className = 'sim-tag-log';
      div.textContent = text;
      phone.appendChild(div);
      phone.scrollTop = phone.scrollHeight;
    }

    function clearSim() {
      simPhone = '+57300' + Math.floor(1000000 + Math.random() * 9000000);
      document.getElementById('simPhone').innerHTML = '<div class=\"sim-bubble sim-bubble-in\" style=\"align-self:center; background:#182229; font-size:10px; color:#8696a0; text-align:center;\">🔄 Sesión reiniciada. Teléfono simulado: ' + esc(simPhone) + '<br>Escribe <strong>\"PRECIO\"</strong> o <strong>\"PLANES\"</strong>.</div>';
    }

    loadFlows();
  </script>
</body>
</html>`;
}
