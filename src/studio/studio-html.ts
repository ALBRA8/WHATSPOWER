export function renderStudioHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsPower Flow Studio — Clon ManyChat 100%</title>
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
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">⚡</div>
      <div>
        <div class="brand-title">WhatsPower Flow Studio</div>
      </div>
      <span class="brand-sub">Nivel 2 · Paridad ManyChat 100%</span>
    </div>

    <div class="actions-bar">
      <select id="flowSelect"></select>
      <button class="btn-primary" onclick="saveCurrentFlow()">💾 Guardar y Activar</button>
    </div>
  </header>

  <div class="workspace">
    <!-- Palette -->
    <div class="palette">
      <div class="palette-title">Catálogo Nodos ManyChat</div>
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
          <span>📱 Simulador ManyChat</span>
          <span class="sim-badge">En Vivo</span>
        </div>
        <button class="btn-secondary" style="padding:2px 6px; font-size:10px;" onclick="clearSim()">Reiniciar</button>
      </div>

      <div class="sim-phone" id="simPhone">
        <div class="sim-bubble sim-bubble-in" style="align-self:center; background:#182229; font-size:10px; color:#8696a0; text-align:center;">
          🔒 Simulación ManyChat en vivo. Escribe <strong>"PRECIO"</strong> o <strong>"INFO"</strong> para iniciar.
        </div>
      </div>

      <div class="sim-input-box">
        <input class="sim-input" id="simInput" placeholder="Escribe un mensaje de WhatsApp..." onkeydown="if(event.key==='Enter') sendSimMessage()">
        <button class="sim-send" onclick="sendSimMessage()">➤</button>
      </div>
    </div>
  </div>

  <script>
    let currentFlow = null;
    let flowsList = [];

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
        div.style.left = (node.position?.x || 100) + 'px';
        div.style.top = (node.position?.y || 100) + 'px';

        let icon = '💬';
        let bodyHtml = '';

        if (node.type === 'trigger') {
          icon = '🚀';
          bodyHtml = '<strong>Keywords:</strong> ' + (node.data.keywords || []).map(k => '<span style=\"background:#064e3b; padding:1px 5px; border-radius:3px; font-size:10px;\">' + k + '</span>').join(' ');
        } else if (node.type === 'send_message') {
          icon = '💬';
          bodyHtml = '<div>' + (node.data.messageText || '').replace(/\\n/g, '<br>') + '</div>';
          if (node.data.buttons && node.data.buttons.length > 0) {
            bodyHtml += '<div class=\"node-buttons\">' + node.data.buttons.map((b, i) => '<div class=\"node-btn-opt\"><span>' + (i+1) + '. ' + b + '</span><span style=\"color:#60a5fa;\">Opción ' + (i+1) + '</span></div>').join('') + '</div>';
          }
        } else if (node.type === 'user_input') {
          icon = '📥';
          bodyHtml = '<div>Prompt: <em>\"' + (node.data.inputPrompt || '') + '\"</em></div><div style=\"color:#38bdf8; margin-top:4px;\">Guardar en: <code>' + (node.data.saveToCustomField || '') + '</code></div>';
        } else if (node.type === 'condition') {
          icon = '🔀';
          bodyHtml = '<div>Reglas: ' + (node.data.rules || []).map(r => '<code>' + r.type + ': ' + r.value + '</code>').join('<br>') + '</div><div style=\"display:flex; justify-content:space-between; margin-top:6px;\"><span style=\"color:#10b981;\">✔ Sí</span><span style=\"color:#ef4444;\">✖ No</span></div>';
        } else if (node.type === 'action') {
          icon = '🏷️';
          bodyHtml = '<div>Acción: <code>' + (node.data.actionType || '') + '</code></div><div style=\"color:#c084fc;\">Etiqueta: ' + (node.data.tag || '') + '</div>';
        } else if (node.type === 'crm_action') {
          icon = '⚡';
          bodyHtml = '⚡ <strong>Acción ALBRA:</strong> <code>' + (node.data.crmAction || '') + '</code><br><span style=\"color:#c084fc;\">Monto: $' + (node.data.crmParams?.amount || 0) + '</span>';
        } else if (node.type === 'ab_split') {
          icon = '🎲';
          bodyHtml = '<div>Split Ratio: <strong>' + (node.data.splitRatio || 50) + '% / ' + (100 - (node.data.splitRatio || 50)) + '%</strong></div><div style=\"display:flex; justify-content:space-between; margin-top:6px;\"><span style=\"color:#f472b6;\">Rama A</span><span style=\"color:#38bdf8;\">Rama B</span></div>';
        } else if (node.type === 'handoff') {
          icon = '👤';
          bodyHtml = '🚨 <strong>Silenciar Bot</strong> y transferir a asesor comercial humano.';
        }

        div.innerHTML = \`
          <div class="node-header">
            <span>\${icon}</span>
            <span>\${node.title}</span>
          </div>
          <div class="node-body">\${bodyHtml}</div>
        \`;
        container.appendChild(div);
      });

      renderEdges();
    }

    function renderEdges() {
      const svg = document.getElementById('edgesSvg');
      svg.innerHTML = '';
      if (!currentFlow || !currentFlow.edges) return;

      currentFlow.edges.forEach(edge => {
        const sourceNode = currentFlow.nodes.find(n => n.id === edge.source);
        const targetNode = currentFlow.nodes.find(n => n.id === edge.target);
        if (!sourceNode || !targetNode) return;

        const x1 = (sourceNode.position?.x || 100) + 260;
        const y1 = (sourceNode.position?.y || 100) + 35;
        const x2 = (targetNode.position?.x || 100);
        const y2 = (targetNode.position?.y || 100) + 35;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const dx = Math.abs(x2 - x1) * 0.5;
        const d = \`M \${x1} \${y1} C \${x1 + dx} \${y1}, \${x2 - dx} \${y2}, \${x2} \${y2}\`;
        path.setAttribute('d', d);
        path.setAttribute('stroke', '#3b82f6');
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
      div.innerHTML = text.replace(/\\n/g, '<br>');
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
      document.getElementById('simPhone').innerHTML = '<div class=\"sim-bubble sim-bubble-in\" style=\"align-self:center; background:#182229; font-size:10px; color:#8696a0; text-align:center;\">🔄 Sesión reiniciada. Teléfono simulado: ' + simPhone + '<br>Escribe <strong>\"PRECIO\"</strong> o <strong>\"PLANES\"</strong>.</div>';
    }

    loadFlows();
  </script>
</body>
</html>`;
}
