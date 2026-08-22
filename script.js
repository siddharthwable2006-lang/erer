/* =========================================================
   IACS — Intelligent Adaptive Charging System
   Simulation Engine (vanilla JS, no dependencies)
   ========================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------
     CENTRAL SIMULATION STATE
     --------------------------------------------------------- */
  const defaults = {
    powerEnabled: false,
    charging: false,
    paused: false,

    soc: 20.1,
    soh: 100,
    capacityAh: 9.0,
    voltage: 20.34,
    voltageSetpoint: 22.4,
    current: 0,
    currentSetpoint: 6.0,
    temperature: 29.9,
    ambientTemperature: 28,
    converterTemperature: 32.0,

    inputVoltage: 48.0,
    inputCurrent: 0,
    inputPower: 0,
    outputVoltage: 22.4,
    outputCurrent: 0,
    outputPower: 0,
    efficiency: 0.92,

    fault: 'NONE',
    activeFaults: new Set(),

    equivalentFullCycles: 0,
    chargingSeconds: 0,

    // simulation parameters (tunable)
    initialSOC: 20.1,
    targetSOC: 100,
    baseCurrent: 6.0,
    initialSOH: 100,
    agingSpeed: 1.0,
    thermalMargin: 50,
    socHoldMargin: 1
  };

  let s = cloneState(defaults);

  function cloneState(obj) {
    const copy = Object.assign({}, obj);
    copy.activeFaults = new Set(obj.activeFaults);
    return copy;
  }

  /* ---------------------------------------------------------
     GRAPH HISTORY BUFFERS (rolling window)
     --------------------------------------------------------- */
  const MAX_POINTS = 90;
  const history = {
    t: [],
    soc: [],
    voltage: [],
    current: [],
    power: [],
    temp: []
  };
  let simTimeSec = 0;

  function pushHistory() {
    history.t.push(simTimeSec);
    history.soc.push(s.soc);
    history.voltage.push(s.voltage);
    history.current.push(s.current);
    history.power.push(s.outputPower);
    history.temp.push(s.temperature);
    for (const k in history) {
      if (history[k].length > MAX_POINTS) history[k].shift();
    }
  }

  /* ---------------------------------------------------------
     CSV EXPORT LOG (full history, not windowed)
     --------------------------------------------------------- */
  const csvLog = [];

  /* ---------------------------------------------------------
     DOM HELPERS
     --------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

  /* ---------------------------------------------------------
     EVENT LOG
     --------------------------------------------------------- */
  function addLog(message, level) {
    level = level || 'info';
    const logEl = $('event-log');
    if (!logEl) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const timeStr = `${hh}:${mm}:${ss}`;

    const row = document.createElement('div');
    row.className = 'event-row' + (level !== 'info' ? ` event-row--${level}` : '');
    row.innerHTML = `<span class="event-time">${timeStr}</span><span class="event-msg">${message}</span>`;
    logEl.insertBefore(row, logEl.firstChild);

    // cap DOM log length
    while (logEl.children.length > 200) logEl.removeChild(logEl.lastChild);
  }

  function clearLog() {
    const logEl = $('event-log');
    if (logEl) logEl.innerHTML = '';
  }

  /* ---------------------------------------------------------
     BATTERY MODEL
     --------------------------------------------------------- */
  function updateBattery(dt) {
    const chargingActive = s.powerEnabled && s.charging && s.fault !== 'SENSOR' && s.fault !== 'COMMS';

    if (chargingActive && s.soc < s.targetSOC) {
      // Charge rate scales with current, tapers near target SOC (CV-like behavior)
      const taper = s.soc > (s.targetSOC - 5) ? 0.35 : 1.0;
      const chargeRateFactor = 0.012; // %SOC per amp-second scaling (tuned for demo speed)
      const deltaSOC = (s.current * chargeRateFactor * taper * dt) / (s.capacityAh / 9);
      s.soc = Math.min(s.targetSOC, s.soc + deltaSOC);
      s.chargingSeconds += dt;

      // equivalent full cycles: (Ah delivered) / capacity, accumulated
      const ahDelivered = (s.current * dt) / 3600;
      s.equivalentFullCycles += ahDelivered / s.capacityAh;
    } else if (!s.charging) {
      s.chargingSeconds = s.chargingSeconds; // hold
    }

    if (s.soc >= s.targetSOC) {
      s.soc = Math.min(100, s.targetSOC);
      if (s.charging) {
        stopCharging(true);
      }
    }

    // Voltage responds toward setpoint while charging, relaxes toward resting curve otherwise
    const restingVoltage = 18 + (s.soc / 100) * 6.2; // approx battery OCV curve 18V-24.2V
    let targetVoltage = chargingActive ? s.voltageSetpoint : restingVoltage;
    if (s.fault === 'VOLT') {
      targetVoltage += (Math.sin(simTimeSec * 3) * 1.8);
    }
    s.voltage += (targetVoltage - s.voltage) * Math.min(1, dt * 1.5);

    // SOH: very slow degradation while charging, influenced by aging speed & thermal stress
    if (chargingActive) {
      const thermalStress = Math.max(0, s.temperature - s.thermalMargin) * 0.0008;
      const baseDrain = 0.00003 * s.agingSpeed;
      s.soh = Math.max(60, s.soh - (baseDrain + thermalStress) * dt);
    }
  }

  /* ---------------------------------------------------------
     CURRENT / ELECTRICAL PARAMETERS
     --------------------------------------------------------- */
  function updateElectricalParameters(dt) {
    const chargingActive = s.powerEnabled && s.charging && s.soc < s.targetSOC;

    let targetCurrent = 0;
    if (chargingActive) {
      targetCurrent = s.currentSetpoint;
      if (s.fault === 'CURR') {
        targetCurrent += Math.sin(simTimeSec * 4) * 2.2;
      }
      // taper current near target SOC (CV phase)
      if (s.soc > s.targetSOC - 5) {
        targetCurrent *= 0.4;
      }
      targetCurrent = Math.max(0, Math.min(10, targetCurrent));
    }

    s.current += (targetCurrent - s.current) * Math.min(1, dt * 2.2);
    if (!chargingActive && Math.abs(s.current) < 0.02) s.current = 0;

    // Output side follows battery interface
    s.outputVoltage = s.voltage;
    s.outputCurrent = s.current;
    s.outputPower = s.outputVoltage * s.outputCurrent;

    // Input side derived through converter efficiency
    let eff = s.efficiency;
    if (s.fault === 'SENSOR') eff *= 0.0; // sensor fault -> no meaningful readings
    s.inputPower = eff > 0 ? s.outputPower / eff : 0;
    s.inputVoltage = 48.0 + (s.fault === 'VOLT' ? Math.sin(simTimeSec * 3) * 1.2 : 0);
    s.inputCurrent = s.inputVoltage > 0 ? s.inputPower / s.inputVoltage : 0;
  }

  /* ---------------------------------------------------------
     TEMPERATURE MODEL
     --------------------------------------------------------- */
  function updateTemperature(dt) {
    const chargingActive = s.powerEnabled && s.charging;
    const loadFactor = s.outputPower / 300; // normalized heating contribution

    let targetBattTemp = s.ambientTemperature + (chargingActive ? (4 + loadFactor * 10) : 1.5);
    if (s.fault === 'TEMP') targetBattTemp += 22;
    s.temperature += (targetBattTemp - s.temperature) * Math.min(1, dt * 0.35);
    s.temperature = Math.max(s.ambientTemperature - 2, s.temperature);

    let targetConvTemp = s.ambientTemperature + (chargingActive ? (6 + loadFactor * 14) : 2);
    if (s.fault === 'TEMP') targetConvTemp += 18;
    s.converterTemperature += (targetConvTemp - s.converterTemperature) * Math.min(1, dt * 0.4);
    s.converterTemperature = Math.max(s.ambientTemperature - 2, s.converterTemperature);
  }

  /* ---------------------------------------------------------
     MASTER TICK
     --------------------------------------------------------- */
  let lastTick = performance.now();
  const SIM_SPEED = 6; // simulated seconds per real second (keeps demo lively)

  function updateSimulation() {
    if (s.paused) { lastTick = performance.now(); requestAnimationFrame(updateSimulation); return; }

    const now = performance.now();
    let realDt = (now - lastTick) / 1000;
    lastTick = now;
    realDt = Math.min(realDt, 0.25); // clamp for tab-switch stalls
    const dt = realDt * SIM_SPEED;
    simTimeSec += dt;

    updateBattery(dt);
    updateElectricalParameters(dt);
    updateTemperature(dt);
    updatePowerFlow();
    updateUI();

    // sample history & csv roughly every simulated 1s
    if (Math.floor(simTimeSec) !== Math.floor(simTimeSec - dt)) {
      pushHistory();
      recordCsvRow();
      updateGraphs();
    }

    requestAnimationFrame(updateSimulation);
  }

  /* ---------------------------------------------------------
     POWER FLOW VISUAL STATE
     --------------------------------------------------------- */
  function updatePowerFlow() {
    const active = s.powerEnabled && s.charging && s.outputCurrent > 0.05;
    ['flow-arrow-1', 'flow-arrow-2', 'flow-arrow-3', 'flow-arrow-4'].forEach(id => {
      const el = $(id);
      if (el) el.classList.toggle('energized', active);
    });
    setText('flow-input', `${s.inputVoltage.toFixed(1)}V / ${s.inputCurrent.toFixed(2)}A`);
    setText('flow-output', `${s.outputVoltage.toFixed(1)}V / ${s.outputCurrent.toFixed(2)}A`);
    setText('flow-efficiency', `${Math.round(s.efficiency * 100)}% eff.`);
    const flowBadge = $('flow-state-badge');
    if (flowBadge) {
      flowBadge.textContent = active ? 'ENERGIZED' : 'STOPPED';
      flowBadge.className = 'badge' + (active ? ' badge--charging' : '');
    }
  }

  /* ---------------------------------------------------------
     UI SYNC
     --------------------------------------------------------- */
  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const sec = Math.floor(totalSeconds % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function tempState(temp, warnAt, critAt) {
    if (temp >= critAt) return 'critical';
    if (temp >= warnAt) return 'warn';
    return 'normal';
  }

  function updateUI() {
    // sidebar gauges
    const socRing = $('soc-ring');
    const sohRing = $('soh-ring');
    const CIRC = 314.159;
    if (socRing) socRing.style.strokeDashoffset = CIRC - (CIRC * (s.soc / 100));
    if (sohRing) sohRing.style.strokeDashoffset = CIRC - (CIRC * (s.soh / 100));
    setText('soc-value', s.soc.toFixed(1) + '%');
    setText('soh-value', s.soh.toFixed(1) + '%');

    setText('m-voltage', s.voltage.toFixed(2) + ' V');
    setText('m-vsetpoint', s.voltageSetpoint.toFixed(2) + ' V');
    setText('m-current', s.current.toFixed(2) + ' A');
    setText('m-power', Math.round(s.outputPower) + ' W');
    setText('m-temp', s.temperature.toFixed(1) + ' \u00b0C');
    setText('m-capacity', s.capacityAh.toFixed(2) + ' Ah');
    setText('m-cycles', s.equivalentFullCycles.toFixed(2));
    setText('m-chargetime', formatTime(s.chargingSeconds));

    const stateEl = $('m-chargestate');
    if (stateEl) {
      let label = 'IDLE';
      let cls = 'status-pill';
      if (!s.powerEnabled) { label = 'POWER OFF'; }
      else if (s.charging && s.soc < s.targetSOC) { label = 'CHARGING'; cls += ' status-pill--charging'; }
      else if (s.charging && s.soc >= s.targetSOC) { label = 'COMPLETE'; cls += ' status-pill--ok'; }
      else { label = 'IDLE'; }
      stateEl.textContent = label;
      stateEl.className = cls;
    }

    const faultEl = $('m-fault');
    if (faultEl) {
      faultEl.textContent = s.fault;
      faultEl.className = 'status-pill' + (s.fault !== 'NONE' ? ' status-pill--fault' : ' status-pill--ok');
    }

    // visualization readout
    setText('cr-vin', s.inputVoltage.toFixed(1) + ' V');
    setText('cr-vout', s.outputVoltage.toFixed(1) + ' V');
    setText('cr-iin', s.inputCurrent.toFixed(2) + ' A');
    setText('cr-iout', s.outputCurrent.toFixed(2) + ' A');
    setText('cr-power', Math.round(s.outputPower) + ' W');
    setText('cr-temp', s.converterTemperature.toFixed(1) + ' \u00b0C');

    const vizBadge = $('viz-state-badge');
    if (vizBadge) {
      const active = s.powerEnabled && s.charging && s.soc < s.targetSOC;
      vizBadge.textContent = s.fault !== 'NONE' ? 'FAULT' : (active ? 'CHARGING' : (s.powerEnabled ? 'IDLE' : 'OFF'));
      vizBadge.className = 'badge' + (s.fault !== 'NONE' ? ' badge--fault' : (active ? ' badge--charging' : ''));
    }

    // IO cards
    setText('io-vin', s.inputVoltage.toFixed(1) + ' <small>V</small>');
    setText('io-iin', s.inputCurrent.toFixed(2) + ' <small>A</small>');
    setText('io-pin', Math.round(s.inputPower) + ' <small>W</small>');
    setText('io-vout', s.outputVoltage.toFixed(1) + ' <small>V</small>');
    setText('io-iout', s.outputCurrent.toFixed(2) + ' <small>A</small>');
    setText('io-pout', Math.round(s.outputPower) + ' <small>W</small>');
    // set innerHTML since setText overwrites textContent (loses <small>)
    $('io-vin').innerHTML = s.inputVoltage.toFixed(1) + ' <small>V</small>';
    $('io-iin').innerHTML = s.inputCurrent.toFixed(2) + ' <small>A</small>';
    $('io-pin').innerHTML = Math.round(s.inputPower) + ' <small>W</small>';
    $('io-vout').innerHTML = s.outputVoltage.toFixed(1) + ' <small>V</small>';
    $('io-iout').innerHTML = s.outputCurrent.toFixed(2) + ' <small>A</small>';
    $('io-pout').innerHTML = Math.round(s.outputPower) + ' <small>W</small>';

    // temperature panel
    setText('temp-batt', s.temperature.toFixed(1) + ' \u00b0C');
    setText('temp-conv', s.converterTemperature.toFixed(1) + ' \u00b0C');
    applyTempState('temp-batt-state', s.temperature);
    applyTempState('temp-conv-state', s.converterTemperature);

    // control button states
    $('btn-power-on').classList.toggle('active', s.powerEnabled);
    $('btn-power-off').classList.toggle('active', !s.powerEnabled);
    $('btn-start').classList.toggle('active', s.charging);
    $('btn-start').disabled = !s.powerEnabled || s.charging;
    $('btn-stop').disabled = !s.charging;

    drawSimCanvas();
  }

  function applyTempState(id, temp) {
    const el = $(id);
    if (!el) return;
    const state = tempState(temp, 40, 50);
    el.textContent = state.toUpperCase();
    el.className = 'temp-card-state' + (state !== 'normal' ? ' ' + state : '');
  }

  /* ---------------------------------------------------------
     MAIN SIMULATION VISUALIZATION (Canvas)
     --------------------------------------------------------- */
  const canvas = $('sim-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  let flowParticles = [];

  function initParticles() {
    flowParticles = [];
    for (let i = 0; i < 8; i++) {
      flowParticles.push({ offset: i / 8 });
    }
  }
  initParticles();

  function drawSimCanvas() {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const chargerX = 140, chargerY = h / 2 - 70, chargerW = 150, chargerH = 150;
    const evX = w - 340, evY = h / 2 - 90, evW = 260, evH = 150;
    const cableY = h / 2;
    const cableStartX = chargerX + chargerW;
    const cableEndX = evX;

    // --- charging station body ---
    drawRoundRect(chargerX, chargerY, chargerW, chargerH, 10, 'rgba(94,234,212,0.06)', 'rgba(94,234,212,0.35)');
    ctx.fillStyle = '#5eead4';
    ctx.font = '600 12px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CHARGER', chargerX + chargerW / 2, chargerY - 12);

    // status LED on charger
    ctx.beginPath();
    ctx.arc(chargerX + chargerW - 16, chargerY + 16, 5, 0, Math.PI * 2);
    ctx.fillStyle = s.fault !== 'NONE' ? '#f87171' : (s.powerEnabled ? '#34d399' : '#3f4b57');
    ctx.fill();

    // screen readout on charger
    ctx.fillStyle = '#0a1420';
    ctx.fillRect(chargerX + 16, chargerY + 34, chargerW - 32, 46);
    ctx.strokeStyle = 'rgba(94,234,212,0.3)';
    ctx.strokeRect(chargerX + 16, chargerY + 34, chargerW - 32, 46);
    ctx.fillStyle = '#22d3ee';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText(s.outputVoltage.toFixed(1) + 'V', chargerX + chargerW / 2, chargerY + 54);
    ctx.fillStyle = '#7b91a3';
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText(s.outputCurrent.toFixed(2) + 'A', chargerX + chargerW / 2, chargerY + 70);

    // plug icon
    drawRoundRect(chargerX + chargerW / 2 - 14, chargerY + chargerH - 26, 28, 18, 4, 'rgba(94,234,212,0.15)', 'rgba(94,234,212,0.4)');

    // --- EV body ---
    ctx.save();
    ctx.translate(evX, evY);
    ctx.fillStyle = s.fault !== 'NONE' ? 'rgba(248,113,113,0.08)' : 'rgba(96,165,250,0.06)';
    ctx.strokeStyle = s.fault !== 'NONE' ? 'rgba(248,113,113,0.4)' : 'rgba(96,165,250,0.4)';
    ctx.lineWidth = 1.4;
    // simple car silhouette
    ctx.beginPath();
    ctx.moveTo(20, 90);
    ctx.lineTo(20, 60);
    ctx.quadraticCurveTo(30, 20, 70, 15);
    ctx.lineTo(evW - 70, 15);
    ctx.quadraticCurveTo(evW - 30, 20, evW - 20, 60);
    ctx.lineTo(evW - 20, 90);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // wheels
    ctx.beginPath(); ctx.arc(55, 92, 14, 0, Math.PI * 2);
    ctx.arc(evW - 55, 92, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#0b1622'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#60a5fa';
    ctx.font = '600 12px "IBM Plex Mono", monospace';
    ctx.fillText('EV BATTERY', evX + evW / 2, evY - 12);

    // battery fill indicator inside EV
    const battBarX = evX + 30, battBarY = evY + 42, battBarW = evW - 60, battBarH = 20;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(battBarX, battBarY, battBarW, battBarH);
    const fillW = (battBarW - 4) * (s.soc / 100);
    const socColor = s.soc > 80 ? '#34d399' : (s.soc > 30 ? '#22d3ee' : '#f59e0b');
    ctx.fillStyle = socColor;
    ctx.fillRect(battBarX + 2, battBarY + 2, Math.max(0, fillW), battBarH - 4);
    ctx.fillStyle = '#dce8f0';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText(s.soc.toFixed(1) + '% SOC', evX + evW / 2, battBarY + battBarH + 18);

    // --- cable between charger and EV ---
    ctx.strokeStyle = 'rgba(123,145,163,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cableStartX, cableY);
    ctx.bezierCurveTo(
      cableStartX + 60, cableY + 40,
      cableEndX - 60, cableY + 40,
      cableEndX, cableY
    );
    ctx.stroke();

    // --- animated power flow particles ---
    const flowing = s.powerEnabled && s.charging && s.outputCurrent > 0.05;
    if (flowing) {
      const speed = 0.006 + (s.outputCurrent / 10) * 0.01;
      flowParticles.forEach(p => {
        p.offset += speed;
        if (p.offset > 1) p.offset -= 1;
        const t = p.offset;
        const x = bezierPoint(cableStartX, cableStartX + 60, cableEndX - 60, cableEndX, t);
        const y = bezierPointY(cableY, cableY + 40, cableY + 40, cableY, t);
        ctx.beginPath();
        ctx.arc(x, y, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = '#22d3ee';
        ctx.shadowColor = '#22d3ee';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      });
    }

    // grid symbol top-left
    ctx.strokeStyle = 'rgba(123,145,163,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(30, chargerY + chargerH / 2);
    ctx.lineTo(chargerX, chargerY + chargerH / 2);
    ctx.stroke();
    ctx.fillStyle = '#7b91a3';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('GRID', 20, chargerY + chargerH / 2 - 10);
    ctx.textAlign = 'center';
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
  }
  function bezierPointY(p0, p1, p2, p3, t) { return bezierPoint(p0, p1, p2, p3, t); }

  function drawRoundRect(x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
  }

  /* ---------------------------------------------------------
     GRAPHS
     --------------------------------------------------------- */
  const graphDefs = [
    { id: 'graph-soc', key: 'soc', color: '#22d3ee', min: 0, max: 100 },
    { id: 'graph-voltage', key: 'voltage', color: '#60a5fa', min: 15, max: 32 },
    { id: 'graph-current', key: 'current', color: '#5eead4', min: 0, max: 10 },
    { id: 'graph-power', key: 'power', color: '#f59e0b', min: 0, max: 300 },
    { id: 'graph-temp', key: 'temp', color: '#f87171', min: 15, max: 65 }
  ];

  function updateGraphs() {
    graphDefs.forEach(def => {
      const canvasEl = $(def.id);
      if (!canvasEl) return;
      const gctx = canvasEl.getContext('2d');
      const w = canvasEl.width, h = canvasEl.height;
      gctx.clearRect(0, 0, w, h);

      // grid lines
      gctx.strokeStyle = 'rgba(255,255,255,0.05)';
      gctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const gy = (h / 4) * i;
        gctx.beginPath(); gctx.moveTo(0, gy); gctx.lineTo(w, gy); gctx.stroke();
      }

      const data = history[def.key];
      if (data.length < 2) return;

      const range = def.max - def.min;
      const stepX = w / (MAX_POINTS - 1);
      const startIdx = MAX_POINTS - data.length;

      gctx.beginPath();
      data.forEach((val, i) => {
        const x = (startIdx + i) * stepX;
        const norm = Math.max(0, Math.min(1, (val - def.min) / range));
        const y = h - norm * h;
        if (i === 0) gctx.moveTo(x, y); else gctx.lineTo(x, y);
      });
      gctx.strokeStyle = def.color;
      gctx.lineWidth = 2;
      gctx.lineJoin = 'round';
      gctx.stroke();

      // filled area under curve
      const lastX = (startIdx + data.length - 1) * stepX;
      gctx.lineTo(lastX, h);
      gctx.lineTo(startIdx * stepX, h);
      gctx.closePath();
      gctx.fillStyle = def.color + '18';
      gctx.fill();

      // current value dot
      const lastVal = data[data.length - 1];
      const lastNorm = Math.max(0, Math.min(1, (lastVal - def.min) / range));
      gctx.beginPath();
      gctx.arc(lastX, h - lastNorm * h, 3, 0, Math.PI * 2);
      gctx.fillStyle = def.color;
      gctx.fill();
    });
  }

  /* ---------------------------------------------------------
     CSV EXPORT
     --------------------------------------------------------- */
  function recordCsvRow() {
    csvLog.push({
      timestamp: new Date().toISOString(),
      soc: s.soc.toFixed(2),
      soh: s.soh.toFixed(2),
      voltage: s.voltage.toFixed(2),
      current: s.current.toFixed(2),
      power: s.outputPower.toFixed(1),
      temperature: s.temperature.toFixed(1),
      inputVoltage: s.inputVoltage.toFixed(1),
      inputCurrent: s.inputCurrent.toFixed(2),
      inputPower: s.inputPower.toFixed(1),
      outputVoltage: s.outputVoltage.toFixed(1),
      outputCurrent: s.outputCurrent.toFixed(2),
      outputPower: s.outputPower.toFixed(1),
      chargingState: s.charging ? 'CHARGING' : (s.powerEnabled ? 'IDLE' : 'OFF')
    });
    if (csvLog.length > 5000) csvLog.shift();
  }

  function exportCsv() {
    const headers = ['timestamp', 'soc', 'soh', 'voltage', 'current', 'power', 'temperature',
      'inputVoltage', 'inputCurrent', 'inputPower', 'outputVoltage', 'outputCurrent', 'outputPower', 'chargingState'];
    let csv = headers.join(',') + '\n';
    csvLog.forEach(row => {
      csv += headers.map(h => row[h]).join(',') + '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iacs_log_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog(`Exported ${csvLog.length} log rows to CSV`, 'ok');
  }

  /* ---------------------------------------------------------
     CONTROL ACTIONS
     --------------------------------------------------------- */
  function togglePower(on) {
    s.powerEnabled = on;
    if (!on) {
      stopCharging(false);
    }
    addLog(`Power turned ${on ? 'ON' : 'OFF'}`, on ? 'ok' : 'warn');
    updateUI();
  }

  function startCharging() {
    if (!s.powerEnabled) {
      addLog('Cannot start charging — power is OFF', 'warn');
      return;
    }
    if (s.soc >= s.targetSOC) {
      addLog('Cannot start charging — target SOC already reached', 'warn');
      return;
    }
    s.charging = true;
    addLog('Charging started', 'ok');
    updateUI();
  }

  function stopCharging(auto) {
    if (s.charging) {
      s.charging = false;
      addLog(auto ? 'Charging complete — target SOC reached' : 'Charging stopped', auto ? 'ok' : 'info');
    }
    updateUI();
  }

  function setCurrentSetpoint(val) {
    val = Math.max(0, Math.min(10, Math.round(val * 10) / 10));
    s.currentSetpoint = val;
    $('current-slider').value = val;
    setText('current-setpoint-label', val.toFixed(1) + ' A');
  }

  function setVoltageSetpoint(val) {
    val = Math.max(18, Math.min(30, Math.round(val * 10) / 10));
    s.voltageSetpoint = val;
    $('voltage-slider').value = val;
    setText('voltage-setpoint-label', val.toFixed(1) + ' V');
  }

  function injectFault(code) {
    s.fault = code;
    addLog(`Fault injected: ${code}`, 'fault');
    updateUI();
  }

  function clearFaults() {
    s.fault = 'NONE';
    document.querySelectorAll('.fault-btn').forEach(b => b.classList.remove('active-fault'));
    addLog('All faults cleared', 'ok');
    updateUI();
  }

  function resetSimulation() {
    s = cloneState(defaults);
    s.soc = s.initialSOC;
    s.soh = s.initialSOH;
    simTimeSec = 0;
    history.t = []; history.soc = []; history.voltage = []; history.current = []; history.power = []; history.temp = [];
    csvLog.length = 0;
    clearLog();
    document.querySelectorAll('.fault-btn').forEach(b => b.classList.remove('active-fault'));

    // reset controls to defaults
    setCurrentSetpoint(defaults.currentSetpoint);
    setVoltageSetpoint(defaults.voltageSetpoint);
    $('p-initsoc').value = defaults.initialSOC; setText('p-initsoc-label', Math.round(defaults.initialSOC) + '%');
    $('p-targetsoc').value = defaults.targetSOC; setText('p-targetsoc-label', Math.round(defaults.targetSOC) + '%');
    $('p-basecurrent').value = defaults.baseCurrent; setText('p-basecurrent-label', defaults.baseCurrent.toFixed(1) + ' A');
    $('p-ambient').value = defaults.ambientTemperature; setText('p-ambient-label', defaults.ambientTemperature + '\u00b0C');
    $('p-initsoh').value = defaults.initialSOH; setText('p-initsoh-label', defaults.initialSOH + '%');
    $('p-aging').value = defaults.agingSpeed; setText('p-aging-label', defaults.agingSpeed.toFixed(1) + 'x');
    $('p-thermal').value = defaults.thermalMargin; setText('p-thermal-label', defaults.thermalMargin + '\u00b0C');
    $('p-holdmargin').value = defaults.socHoldMargin; setText('p-holdmargin-label', defaults.socHoldMargin + '%');

    addLog('Simulation reset to initial conditions', 'ok');
    pushHistory();
    updateGraphs();
    updateUI();
  }

  /* ---------------------------------------------------------
     EVENT WIRING
     --------------------------------------------------------- */
  function wireControls() {
    // data source toggle
    $('btn-sim-data').addEventListener('click', () => {
      $('btn-sim-data').classList.add('active');
      $('btn-real-data').classList.remove('active');
      $('real-data-banner').classList.add('hidden');
    });
    $('btn-real-data').addEventListener('click', () => {
      $('btn-real-data').classList.add('active');
      $('btn-sim-data').classList.remove('active');
      $('real-data-banner').classList.remove('hidden');
    });

    $('btn-sidebar-toggle').addEventListener('click', () => {
      $('sidebar').classList.toggle('hidden');
    });

    // power
    $('btn-power-on').addEventListener('click', () => togglePower(true));
    $('btn-power-off').addEventListener('click', () => togglePower(false));

    // charging
    $('btn-start').addEventListener('click', startCharging);
    $('btn-stop').addEventListener('click', () => stopCharging(false));

    // current slider + steppers
    const currentSlider = $('current-slider');
    currentSlider.addEventListener('input', (e) => setCurrentSetpoint(parseFloat(e.target.value)));
    $('btn-current-minus').addEventListener('click', () => setCurrentSetpoint(s.currentSetpoint - 0.1));
    $('btn-current-plus').addEventListener('click', () => setCurrentSetpoint(s.currentSetpoint + 0.1));
    $('btn-apply-current').addEventListener('click', () => {
      addLog(`Current setpoint changed to ${s.currentSetpoint.toFixed(1)} A`);
    });

    // voltage slider + steppers
    const voltageSlider = $('voltage-slider');
    voltageSlider.addEventListener('input', (e) => setVoltageSetpoint(parseFloat(e.target.value)));
    $('btn-voltage-minus').addEventListener('click', () => setVoltageSetpoint(s.voltageSetpoint - 0.1));
    $('btn-voltage-plus').addEventListener('click', () => setVoltageSetpoint(s.voltageSetpoint + 0.1));
    $('btn-apply-voltage').addEventListener('click', () => {
      addLog(`Voltage setpoint changed to ${s.voltageSetpoint.toFixed(1)} V`);
    });

    // pause / reset / export
    $('btn-pause').addEventListener('click', () => {
      s.paused = !s.paused;
      $('btn-pause').textContent = s.paused ? 'Resume Simulation' : 'Pause Simulation';
      const graphBadge = $('graph-state-badge');
      if (graphBadge) {
        graphBadge.textContent = s.paused ? 'PAUSED' : 'LIVE';
        graphBadge.classList.toggle('badge--live', !s.paused);
      }
      addLog(s.paused ? 'Simulation paused' : 'Simulation resumed');
    });
    $('btn-reset').addEventListener('click', resetSimulation);
    $('btn-export').addEventListener('click', exportCsv);
    $('btn-clear-log').addEventListener('click', clearLog);

    // fault injection
    document.querySelectorAll('.fault-btn[data-fault]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.fault-btn').forEach(b => b.classList.remove('active-fault'));
        btn.classList.add('active-fault');
        injectFault(btn.dataset.fault);
      });
    });
    $('btn-clear-fault').addEventListener('click', clearFaults);

    // simulation parameters
    $('p-initsoc').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.initialSOC = v;
      setText('p-initsoc-label', Math.round(v) + '%');
    });
    $('p-targetsoc').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.targetSOC = v;
      setText('p-targetsoc-label', Math.round(v) + '%');
    });
    $('p-basecurrent').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.baseCurrent = v;
      setCurrentSetpoint(v);
      setText('p-basecurrent-label', v.toFixed(1) + ' A');
    });
    $('p-ambient').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.ambientTemperature = v;
      setText('p-ambient-label', v + '\u00b0C');
    });
    $('p-initsoh').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.initialSOH = v;
      setText('p-initsoh-label', v + '%');
    });
    $('p-aging').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.agingSpeed = v;
      setText('p-aging-label', v.toFixed(1) + 'x');
    });
    $('p-thermal').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.thermalMargin = v;
      setText('p-thermal-label', v + '\u00b0C');
    });
    $('p-holdmargin').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      s.socHoldMargin = v;
      setText('p-holdmargin-label', v + '%');
    });

    window.addEventListener('resize', () => { drawSimCanvas(); updateGraphs(); });
  }

  /* ---------------------------------------------------------
     INIT
     --------------------------------------------------------- */
  function init() {
    wireControls();
    addLog('System initialized', 'ok');
    addLog('Simulation Mode active — no hardware connected');
    pushHistory();
    updateGraphs();
    updateUI();
    lastTick = performance.now();
    requestAnimationFrame(updateSimulation);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
