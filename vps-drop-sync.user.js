// ==UserScript==
// @name         VPS Drop Sync
// @namespace    https://github.com/1Beyond1/VPS-Drop-Sync
// @version      4.2.0
// @description  通用 VPS 放货精准对时与自动抢购助手：二段式服务器校时、多 PID 轮询、动态表单解析与自动结账。
// @author       1Beyond1
// @license      MIT
// @homepageURL  https://github.com/1Beyond1/VPS-Drop-Sync
// @supportURL   https://github.com/1Beyond1/VPS-Drop-Sync/issues
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/1Beyond1/VPS-Drop-Sync/main/vps-drop-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/1Beyond1/VPS-Drop-Sync/main/vps-drop-sync.user.js
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '4.2.0';
    const ENABLED_HOSTS_KEY = 'vpsDropSyncEnabledHosts';
    const LOG_STORAGE_KEY = 'vps_drop_sync_logs';
    const MAX_LOGS = 100;

    // --------------------------------------------
    // 时间格式与存储工具
    // --------------------------------------------
    const toDateTimeLocal = (timeStr) => {
        if (!timeStr) return '';
        const normalized = timeStr.replace(' ', 'T');
        return normalized.length >= 19 ? normalized.slice(0, 19) : normalized.slice(0, 16);
    };

    const fromDateTimeLocal = (dtStr) => {
        if (!dtStr) return '';
        const base = dtStr.replace('T', ' ');
        return base.length >= 19 ? base : `${base}:00`;
    };

    const formatCountdown = (remainMs) => {
        const clamped = Math.max(0, remainMs);
        const totalSec = Math.floor(clamped / 1000);
        const hours = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        const tenths = Math.floor((clamped % 1000) / 100);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(hours)}:${pad(mins)}:${pad(secs)}.${tenths}`;
    };

    const storageRead = (key, defaultVal) => {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, defaultVal);
            const v = localStorage.getItem(`tm_${key}`);
            return v !== null ? v : defaultVal;
        } catch {
            return defaultVal;
        }
    };

    const storageWrite = (key, val) => {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, val);
            else localStorage.setItem(`tm_${key}`, String(val));
        } catch {
            // 隐私模式或存储受限时忽略持久化失败
        }
    };

    const readSessionLogs = () => {
        try {
            const parsed = JSON.parse(sessionStorage.getItem(LOG_STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    };

    const writeSessionLogs = (logs) => {
        try {
            sessionStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs));
        } catch {
            // 忽略 sessionStorage 写入限制
        }
    };

    const generateFallbackPassword = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
        const bytes = new Uint8Array(14);
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            window.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        return Array.from(bytes, (b) => chars[b % chars.length]).join('');
    };

    // --------------------------------------------
    // 站点域名白名单（按 location.host 隔离）
    // --------------------------------------------
    function getEnabledHosts() {
        try {
            const hosts = JSON.parse(storageRead(ENABLED_HOSTS_KEY, '[]'));
            return Array.isArray(hosts) ? hosts : [];
        } catch {
            return [];
        }
    }

    const currentHost = location.host;
    const enabledHosts = getEnabledHosts();
    const isCurrentHostEnabled = enabledHosts.includes(currentHost);

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand(
            isCurrentHostEnabled
                ? `在当前网站禁用 VPS Drop Sync（${currentHost}）`
                : `在当前网站启用 VPS Drop Sync（${currentHost}）`,
            () => {
                const nextHosts = isCurrentHostEnabled
                    ? enabledHosts.filter((host) => host !== currentHost)
                    : [...new Set([...enabledHosts, currentHost])];
                storageWrite(ENABLED_HOSTS_KEY, JSON.stringify(nextHosts));
                location.reload();
            }
        );
    }

    if (!isCurrentHostEnabled) return;

    let targetPid = String(storageRead('targetPid', '') || '');
    let startTime = String(storageRead('startTime', '') || '');
    let stopTime = String(storageRead('stopTime', '') || '');
    let paymentMethod = String(storageRead('paymentMethod', 'AliPayH5') || 'AliPayH5');
    let speedMs = parseInt(storageRead('speedMs', '500'), 10);
    if (![500, 100, 10].includes(speedMs)) speedMs = 500;

    // --------------------------------------------
    // 构建 Shadow DOM 悬浮控制面板
    // --------------------------------------------
    const hostEl = document.createElement('div');
    hostEl.id = 'vps-drop-sync-host';
    hostEl.style.cssText = 'position:fixed; top:20px; right:20px; z-index:2147483646;';
    const shadow = hostEl.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
        <style>
            :host {
                all: initial;
                font-family: "Inter", "PingFang SC", "Microsoft YaHei UI", -apple-system, BlinkMacSystemFont, sans-serif;
                color-scheme: dark;
            }
            * { box-sizing: border-box; }
            .vds-card {
                width: 356px;
                background: rgba(13, 17, 24, 0.94);
                color: #e6edf3;
                border: 1px solid rgba(148, 163, 184, 0.22);
                border-radius: 14px;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                overflow: hidden;
                font-size: 12.5px;
                line-height: 1.45;
                user-select: none;
            }
            .vds-card.collapsed { width: auto; min-width: 224px; }
            .vds-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 11px 14px;
                background: linear-gradient(180deg, rgba(30, 41, 59, 0.65), rgba(15, 23, 42, 0.35));
                border-bottom: 1px solid rgba(148, 163, 184, 0.14);
                cursor: grab;
            }
            .vds-header:active { cursor: grabbing; }
            .vds-card.collapsed .vds-header { border-bottom: none; }
            .vds-title-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
            .vds-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #64748b;
                flex-shrink: 0;
                transition: background 0.2s, box-shadow 0.2s;
            }
            .vds-dot.idle { background: #64748b; }
            .vds-dot.syncing { background: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.22); }
            .vds-dot.armed { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.22); }
            .vds-dot.running { background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25); }
            .vds-dot.error { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.22); }
            .vds-title { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; color: #f8fafc; white-space: nowrap; }
            .vds-badge {
                font-size: 10.5px;
                font-weight: 500;
                padding: 1px 6px;
                border-radius: 999px;
                background: rgba(56, 189, 248, 0.14);
                color: #7dd3fc;
                border: 1px solid rgba(56, 189, 248, 0.28);
                font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
            }
            .vds-toggle {
                background: rgba(148, 163, 184, 0.12);
                border: 1px solid rgba(148, 163, 184, 0.2);
                color: #cbd5e1;
                border-radius: 6px;
                padding: 3px 8px;
                font-size: 11px;
                cursor: pointer;
                transition: background 0.15s, color 0.15s;
            }
            .vds-toggle:hover { background: rgba(148, 163, 184, 0.22); color: #fff; }
            .vds-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 11px; }
            .vds-card.collapsed .vds-body { display: none; }

            .vds-telemetry {
                display: grid;
                grid-template-columns: 1.3fr 1fr 0.85fr;
                gap: 6px;
            }
            .vds-metric {
                background: rgba(30, 41, 59, 0.48);
                border: 1px solid rgba(148, 163, 184, 0.14);
                border-radius: 8px;
                padding: 6px 8px;
                min-width: 0;
            }
            .vds-metric-k { font-size: 10px; color: #94a3b8; margin-bottom: 2px; }
            .vds-metric-v {
                font-size: 12px;
                font-weight: 600;
                color: #f1f5f9;
                font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .vds-countdown {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 11px;
                border-radius: 9px;
                background: linear-gradient(90deg, rgba(14, 165, 233, 0.12), rgba(30, 41, 59, 0.45));
                border: 1px solid rgba(56, 189, 248, 0.24);
            }
            .vds-countdown-label { font-size: 11px; color: #94a3b8; }
            .vds-countdown-stage { font-size: 10.5px; color: #7dd3fc; margin-top: 1px; }
            .vds-countdown-val {
                font-size: 20px;
                font-weight: 700;
                letter-spacing: 0.03em;
                color: #f8fafc;
                font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
                font-variant-numeric: tabular-nums;
            }
            .vds-countdown.sprint {
                background: linear-gradient(90deg, rgba(245, 158, 11, 0.18), rgba(30, 41, 59, 0.5));
                border-color: rgba(245, 158, 11, 0.42);
            }
            .vds-countdown.sprint .vds-countdown-val { color: #fde047; }

            .vds-form { display: flex; flex-direction: column; gap: 8px; }
            .vds-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
            .vds-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
            .vds-label { font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }
            .vds-hint { color: #64748b; font-size: 10.5px; }
            .vds-input, .vds-select {
                width: 100%;
                height: 31px;
                padding: 0 9px;
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.22);
                border-radius: 7px;
                color: #f8fafc;
                font-size: 12px;
                font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
                outline: none;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .vds-select { font-family: inherit; }
            .vds-input:focus, .vds-select:focus {
                border-color: #38bdf8;
                box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
            }
            .vds-input:disabled, .vds-select:disabled { opacity: 0.55; cursor: not-allowed; }
            .vds-alert {
                display: none;
                padding: 7px 9px;
                border-radius: 7px;
                font-size: 11.5px;
                background: rgba(239, 68, 68, 0.14);
                border: 1px solid rgba(239, 68, 68, 0.35);
                color: #fca5a5;
            }
            .vds-alert.show { display: block; }

            .vds-actions { display: flex; gap: 8px; }
            .vds-btn {
                flex: 1;
                height: 35px;
                border: none;
                border-radius: 8px;
                font-size: 12.5px;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.1s, filter 0.15s, opacity 0.15s;
            }
            .vds-btn:active { transform: translateY(1px); }
            .vds-btn-primary {
                background: linear-gradient(135deg, #0284c7, #2563eb);
                color: #fff;
                box-shadow: 0 6px 18px rgba(37, 99, 235, 0.32);
            }
            .vds-btn-primary:hover { filter: brightness(1.08); }
            .vds-btn-danger {
                background: linear-gradient(135deg, #dc2626, #b91c1c);
                color: #fff;
                box-shadow: 0 6px 18px rgba(220, 38, 38, 0.28);
                display: none;
            }
            .vds-btn-danger:hover { filter: brightness(1.08); }

            .vds-log-section {
                border-top: 1px solid rgba(148, 163, 184, 0.14);
                padding-top: 9px;
            }
            .vds-log-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 6px;
                font-size: 11px;
                color: #94a3b8;
            }
            .vds-clear {
                background: none;
                border: none;
                color: #94a3b8;
                font-size: 11px;
                cursor: pointer;
                padding: 1px 4px;
                border-radius: 4px;
            }
            .vds-clear:hover { color: #f87171; background: rgba(239, 68, 68, 0.12); }
            .vds-log {
                background: rgba(2, 6, 23, 0.72);
                border: 1px solid rgba(148, 163, 184, 0.14);
                border-radius: 8px;
                height: 132px;
                overflow-y: auto;
                padding: 7px 9px;
                font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
                font-size: 11px;
                line-height: 1.5;
                user-select: text;
            }
            .vds-log-line { display: flex; gap: 6px; margin-bottom: 2px; word-break: break-all; }
            .vds-log-ts { color: #64748b; flex-shrink: 0; }
            .vds-log-line.info .vds-log-msg { color: #cbd5e1; }
            .vds-log-line.sync .vds-log-msg { color: #7dd3fc; }
            .vds-log-line.ok .vds-log-msg { color: #4ade80; }
            .vds-log-line.warn .vds-log-msg { color: #fbbf24; }
            .vds-log-line.err .vds-log-msg { color: #f87171; }
        </style>

        <section class="vds-card" id="vds-card">
            <header class="vds-header" id="vds-drag">
                <div class="vds-title-wrap">
                    <span class="vds-dot idle" id="vds-dot"></span>
                    <span class="vds-title">VPS Drop Sync</span>
                    <span class="vds-badge">v${VERSION}</span>
                </div>
                <button type="button" class="vds-toggle" id="vds-toggle">收起</button>
            </header>

            <div class="vds-body">
                <div class="vds-telemetry">
                    <div class="vds-metric">
                        <div class="vds-metric-k">当前状态</div>
                        <div class="vds-metric-v" id="vds-status">待命</div>
                    </div>
                    <div class="vds-metric">
                        <div class="vds-metric-k">时钟偏差</div>
                        <div class="vds-metric-v" id="vds-delta">--</div>
                    </div>
                    <div class="vds-metric">
                        <div class="vds-metric-k">均值 RTT</div>
                        <div class="vds-metric-v" id="vds-rtt">--</div>
                    </div>
                </div>

                <div class="vds-countdown" id="vds-countdown-box">
                    <div>
                        <div class="vds-countdown-label">距目标开抢</div>
                        <div class="vds-countdown-stage" id="vds-stage">等待启动校时</div>
                    </div>
                    <div class="vds-countdown-val" id="vds-countdown">--:--:--.-</div>
                </div>

                <div class="vds-form">
                    <div class="vds-field">
                        <label class="vds-label" for="vds-pid">
                            <span>目标商品 PID</span>
                            <span class="vds-hint">多个用逗号分隔</span>
                        </label>
                        <input type="text" id="vds-pid" class="vds-input" placeholder="例如：2159, 2160">
                    </div>

                    <div class="vds-field">
                        <label class="vds-label" for="vds-time">
                            <span>开抢时间</span>
                            <span class="vds-hint">精确到秒</span>
                        </label>
                        <input type="datetime-local" id="vds-time" step="1" class="vds-input">
                    </div>

                    <div class="vds-field">
                        <label class="vds-label" for="vds-stoptime">
                            <span>自动停止时间</span>
                            <span class="vds-hint">可选，避免持续请求</span>
                        </label>
                        <input type="datetime-local" id="vds-stoptime" step="1" class="vds-input">
                    </div>

                    <div class="vds-row">
                        <div class="vds-field">
                            <label class="vds-label" for="vds-pay">付款方式</label>
                            <select id="vds-pay" class="vds-select">
                                <option value="AliPayH5">支付宝 (AliPayH5)</option>
                                <option value="wechatpay">微信支付</option>
                                <option value="paypal">PayPal</option>
                            </select>
                        </div>
                        <div class="vds-field">
                            <label class="vds-label" for="vds-speed">重试频率</label>
                            <select id="vds-speed" class="vds-select">
                                <option value="500">安全 (500ms)</option>
                                <option value="100">快速 (100ms)</option>
                                <option value="10">极限 (10ms)</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="vds-alert" id="vds-alert" role="alert"></div>

                <div class="vds-actions">
                    <button type="button" id="vds-start" class="vds-btn vds-btn-primary">启动定时抢购</button>
                    <button type="button" id="vds-stop" class="vds-btn vds-btn-danger">停止任务</button>
                </div>

                <div class="vds-log-section">
                    <div class="vds-log-head">
                        <span id="vds-host-label">运行日志</span>
                        <button type="button" class="vds-clear" id="vds-clear">清空</button>
                    </div>
                    <div class="vds-log" id="vds-log"></div>
                </div>
            </div>
        </section>
    `;
    document.body.appendChild(hostEl);

    // --------------------------------------------
    // DOM 引用与初始值安全回填（不走 innerHTML 插值）
    // --------------------------------------------
    const $ = (id) => shadow.getElementById(id);
    const cardEl = $('vds-card');
    const dragEl = $('vds-drag');
    const toggleBtn = $('vds-toggle');
    const dotEl = $('vds-dot');
    const statusEl = $('vds-status');
    const deltaEl = $('vds-delta');
    const rttEl = $('vds-rtt');
    const countdownBox = $('vds-countdown-box');
    const countdownEl = $('vds-countdown');
    const stageEl = $('vds-stage');
    const pidInput = $('vds-pid');
    const timeInput = $('vds-time');
    const stopTimeInput = $('vds-stoptime');
    const paySelect = $('vds-pay');
    const speedSelect = $('vds-speed');
    const alertEl = $('vds-alert');
    const startBtn = $('vds-start');
    const stopBtn = $('vds-stop');
    const logEl = $('vds-log');
    const clearBtn = $('vds-clear');
    const hostLabelEl = $('vds-host-label');

    hostLabelEl.textContent = `运行日志 · ${currentHost}`;
    pidInput.value = targetPid;
    timeInput.value = toDateTimeLocal(startTime);
    stopTimeInput.value = toDateTimeLocal(stopTime);
    paySelect.value = paymentMethod;
    speedSelect.value = String(speedMs);

    // --------------------------------------------
    // 面板折叠与拖拽定位
    // --------------------------------------------
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = cardEl.classList.toggle('collapsed');
        toggleBtn.textContent = collapsed ? '展开' : '收起';
    });

    let dragState = null;
    dragEl.addEventListener('pointerdown', (e) => {
        if (e.target === toggleBtn) return;
        const rect = hostEl.getBoundingClientRect();
        dragState = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
        dragEl.setPointerCapture(e.pointerId);
    });
    dragEl.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const maxX = Math.max(8, window.innerWidth - hostEl.offsetWidth - 8);
        const maxY = Math.max(8, window.innerHeight - hostEl.offsetHeight - 8);
        const nextX = Math.min(maxX, Math.max(8, e.clientX - dragState.offsetX));
        const nextY = Math.min(maxY, Math.max(8, e.clientY - dragState.offsetY));
        hostEl.style.left = `${nextX}px`;
        hostEl.style.top = `${nextY}px`;
        hostEl.style.right = 'auto';
    });
    dragEl.addEventListener('pointerup', () => { dragState = null; });
    dragEl.addEventListener('pointercancel', () => { dragState = null; });

    // --------------------------------------------
    // 状态、日志与 Wake Lock 管理
    // --------------------------------------------
    let isRunning = false;
    let stopFlag = false;
    let timeChecker = null;
    let preSyncTimer = null;
    let precisionTimer = null;
    let wakeLock = null;
    let serverTimeDelta = 0;

    function serverNow() {
        return Date.now() + serverTimeDelta;
    }

    function setAlert(msg) {
        if (!msg) {
            alertEl.textContent = '';
            alertEl.classList.remove('show');
            return;
        }
        alertEl.textContent = msg;
        alertEl.classList.add('show');
    }

    function setStatus(text, tone = 'idle') {
        statusEl.textContent = text;
        dotEl.className = `vds-dot ${tone}`;
    }

    function appendLogDom(ts, text, level = 'info') {
        const row = document.createElement('div');
        row.className = `vds-log-line ${level}`;
        const tsSpan = document.createElement('span');
        tsSpan.className = 'vds-log-ts';
        tsSpan.textContent = ts;
        const msgSpan = document.createElement('span');
        msgSpan.className = 'vds-log-msg';
        msgSpan.textContent = text;
        row.appendChild(tsSpan);
        row.appendChild(msgSpan);
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function logMsg(msg, level = 'info') {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        appendLogDom(ts, msg, level);
        const logs = readSessionLogs();
        logs.push({ ts, text: msg, level });
        while (logs.length > MAX_LOGS) logs.shift();
        writeSessionLogs(logs);
    }

    readSessionLogs().forEach((entry) => {
        if (entry && typeof entry.text === 'string') {
            appendLogDom(entry.ts || '--:--:--', entry.text, entry.level || 'info');
        }
    });

    clearBtn.addEventListener('click', () => {
        try { sessionStorage.removeItem(LOG_STORAGE_KEY); } catch {}
        logEl.textContent = '';
    });

    function clearAllTimers() {
        if (timeChecker) { clearInterval(timeChecker); timeChecker = null; }
        if (preSyncTimer) { clearTimeout(preSyncTimer); preSyncTimer = null; }
        if (precisionTimer) { clearTimeout(precisionTimer); precisionTimer = null; }
    }

    function setControlsDisabled(disabled) {
        pidInput.disabled = disabled;
        timeInput.disabled = disabled;
        stopTimeInput.disabled = disabled;
        paySelect.disabled = disabled;
        speedSelect.disabled = disabled;
        startBtn.style.display = disabled ? 'none' : 'block';
        stopBtn.style.display = disabled ? 'block' : 'none';
    }

    async function acquireWakeLock() {
        if (!('wakeLock' in navigator)) {
            logMsg('浏览器不支持 Wake Lock，请手动保持屏幕常亮', 'warn');
            return;
        }
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            logMsg('防休眠锁已激活', 'ok');
            if (!window._vdsWakeLockBound) {
                window._vdsWakeLockBound = true;
                document.addEventListener('visibilitychange', async () => {
                    if (document.visibilityState === 'visible' && isRunning && !stopFlag) {
                        wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
                    }
                });
            }
        } catch (err) {
            logMsg(`防休眠申请失败：${err.message}`, 'warn');
        }
    }

    function releaseWakeLock() {
        if (!wakeLock) return;
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }

    // --------------------------------------------
    // 二段式服务器时钟校准（RTT 去极值均值）
    // --------------------------------------------
    async function syncServerTime(label = '校时', samples = 5) {
        setStatus('校时中', 'syncing');
        stageEl.textContent = `${label}（${samples} 次采样）`;
        logMsg(`${label}开始，采样 ${samples} 次`, 'sync');

        const pairs = [];
        for (let i = 0; i < samples; i++) {
            if (stopFlag) return;
            try {
                const t0 = Date.now();
                const resp = await fetch('/', { method: 'HEAD', credentials: 'include', cache: 'no-store' });
                const t1 = Date.now();
                const dateHeader = resp.headers.get('Date');
                if (dateHeader) {
                    const serverMs = new Date(dateHeader).getTime();
                    if (!Number.isNaN(serverMs)) {
                        const rtt = t1 - t0;
                        pairs.push({ delta: serverMs - (t0 + t1) / 2, rtt });
                    }
                }
                if (i < samples - 1) await new Promise((r) => setTimeout(r, 200));
            } catch {
                // 单次采样失败继续后续样本
            }
        }

        if (pairs.length === 0) {
            deltaEl.textContent = '本地时钟';
            rttEl.textContent = '--';
            logMsg(`${label}采样失败，回退本地时钟`, 'warn');
            return;
        }

        pairs.sort((a, b) => a.rtt - b.rtt);
        const trimmed = pairs.length > 2 ? pairs.slice(1, -1) : pairs;
        const avgDelta = Math.round(trimmed.reduce((s, p) => s + p.delta, 0) / trimmed.length);
        const avgRtt = Math.round(trimmed.reduce((s, p) => s + p.rtt, 0) / trimmed.length);

        serverTimeDelta = avgDelta;
        const sign = avgDelta > 0 ? '+' : '';
        deltaEl.textContent = `${sign}${avgDelta}ms`;
        rttEl.textContent = `${avgRtt}ms`;
        logMsg(`${label}完成 · 偏差 ${sign}${avgDelta}ms · RTT ${avgRtt}ms (${pairs.length}/${samples})`, 'ok');
    }

    // --------------------------------------------
    // 任务启停与倒计时调度
    // --------------------------------------------
    function finishTask(statusText, tone = 'idle') {
        clearAllTimers();
        isRunning = false;
        stopFlag = true;
        releaseWakeLock();
        setControlsDisabled(false);
        countdownBox.classList.remove('sprint');
        setStatus(statusText, tone);
    }

    stopBtn.addEventListener('click', () => {
        finishTask('已中止', 'error');
        stageEl.textContent = '任务已手动停止';
        countdownEl.textContent = '--:--:--.-';
        logMsg('用户手动中止任务', 'err');
    });

    startBtn.addEventListener('click', async () => {
        setAlert('');
        targetPid = pidInput.value.trim();
        startTime = fromDateTimeLocal(timeInput.value);
        stopTime = fromDateTimeLocal(stopTimeInput.value);
        paymentMethod = paySelect.value;
        speedMs = parseInt(speedSelect.value, 10) || 500;

        storageWrite('targetPid', targetPid);
        storageWrite('startTime', startTime);
        storageWrite('stopTime', stopTime);
        storageWrite('paymentMethod', paymentMethod);
        storageWrite('speedMs', speedMs);

        const targetMs = new Date(startTime.replace(/-/g, '/')).getTime();
        if (!targetPid) {
            setAlert('请先填写至少一个目标商品 PID');
            pidInput.focus();
            return;
        }
        if (!startTime || Number.isNaN(targetMs)) {
            setAlert('请选择有效的开抢时间');
            timeInput.focus();
            return;
        }

        clearAllTimers();
        setControlsDisabled(true);
        isRunning = true;
        stopFlag = false;

        acquireWakeLock();
        const stopMs = stopTime ? new Date(stopTime.replace(/-/g, '/')).getTime() : 0;
        if (stopMs > 0) logMsg(`已设自动停止：${stopTime}`, 'info');

        await syncServerTime('启动初校', 3);
        if (!isRunning || stopFlag) return;

        if (serverNow() >= targetMs) {
            startPolling();
            return;
        }

        setStatus('定时待命', 'armed');
        const preSyncDelay = targetMs - 60000 - serverNow();
        if (preSyncDelay > 1000) {
            stageEl.textContent = '开抢前 60 秒自动精校';
            logMsg('已预约开抢前 60 秒二次精校', 'info');
            preSyncTimer = setTimeout(async () => {
                if (!isRunning || stopFlag) return;
                await syncServerTime('开抢前精校', 5);
                if (isRunning && !stopFlag) {
                    setStatus('即将开抢', 'armed');
                    stageEl.textContent = '二次精校已完成';
                }
            }, preSyncDelay);
        } else {
            stageEl.textContent = '倒计时同步运行中';
        }

        let lastLogAt = 0;
        const tick = (sprint) => {
            const now = serverNow();
            if (now >= targetMs) {
                clearAllTimers();
                countdownEl.textContent = '00:00:00.0';
                startPolling();
                return;
            }
            const remainMs = targetMs - now;
            countdownEl.textContent = formatCountdown(remainMs);
            if (sprint) {
                countdownBox.classList.add('sprint');
                stageEl.textContent = '最后 5 秒 · 50ms 高精度触发';
            }
            const remainSec = Math.floor(remainMs / 1000);
            const interval = remainSec > 300 ? 60000 : remainSec > 60 ? 30000 : 15000;
            if (!sprint && now - lastLogAt >= interval) {
                lastLogAt = now;
                logMsg(`倒计时 ${formatCountdown(remainMs)}（偏差 ${serverTimeDelta >= 0 ? '+' : ''}${serverTimeDelta}ms）`, 'sync');
            }
        };

        tick(false);
        timeChecker = setInterval(() => tick(false), 200);

        const sprintDelay = Math.max(0, targetMs - serverNow() - 5200);
        precisionTimer = setTimeout(() => {
            if (!isRunning || stopFlag) return;
            if (timeChecker) clearInterval(timeChecker);
            timeChecker = setInterval(() => tick(true), 50);
        }, sprintDelay);
    });

    function startPolling() {
        if (!isRunning || stopFlag) return;
        setStatus('抢购运行中', 'running');
        stageEl.textContent = '多 PID 轮询与结账中';
        countdownBox.classList.remove('sprint');
        logMsg('到达目标时间，开始轮询商品库存', 'ok');
        loopConfigAndBuy();
    }

    // --------------------------------------------
    // 抢单核心流程
    // --------------------------------------------
    async function loopConfigAndBuy() {
        let attempt = 1;
        const pidList = targetPid.split(/[,，|\s]+/).map((p) => p.trim()).filter(Boolean);
        const stopMs = stopTime ? new Date(stopTime.replace(/-/g, '/')).getTime() : 0;

        while (isRunning && !stopFlag) {
            if (stopMs > 0 && serverNow() >= stopMs) {
                logMsg(`已达停止时间 ${stopTime}，自动结束`, 'warn');
                stageEl.textContent = '已超时自动停止';
                finishTask('已超时停止', 'idle');
                return;
            }

            try {
                let grabbed = false;

                for (const currentPid of pidList) {
                    if (!isRunning || stopFlag) break;

                    const t0 = Date.now();
                    await fetch('/cart?action=emptycart', { method: 'GET', credentials: 'include' }).catch(() => {});

                    const configUrl = `/cart?action=configureproduct&pid=${encodeURIComponent(currentPid)}`;
                    logMsg(`[#${attempt}] 探测 PID ${currentPid}`, 'sync');

                    const resp = await fetch(`${configUrl}&nocache=${Date.now()}`, {
                        redirect: 'follow',
                        credentials: 'include',
                    });
                    const html = await resp.text();
                    const t1 = Date.now();

                    if (html.includes('未到时间') || html.includes('缺货') || html.includes('Out of Stock')) {
                        logMsg(`PID ${currentPid} 暂无库存 (${resp.status} · ${t1 - t0}ms)`, 'warn');
                        continue;
                    }

                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const form = doc.getElementById('frmConfigureProduct') || doc.querySelector('form');
                    if (!form) {
                        logMsg(`PID ${currentPid} 页面未检测到配置表单，跳过`, 'warn');
                        continue;
                    }

                    const fields = {};
                    form.querySelectorAll('input').forEach((input) => {
                        if (!input.name) return;
                        if (input.type === 'radio' || input.type === 'checkbox') {
                            if (input.checked) fields[input.name] = input.value;
                        } else {
                            fields[input.name] = input.value;
                        }
                    });
                    form.querySelectorAll('select').forEach((sel) => {
                        if (!sel.name) return;
                        const opt = sel.querySelector('option[selected]') || sel.querySelector('option');
                        fields[sel.name] = opt ? opt.value : sel.value;
                    });

                    fields.pid = currentPid;
                    fields.qty = '1';
                    if ('host' in fields && !fields.host) fields.host = `vps-${Date.now()}`;
                    if ('password' in fields && !fields.password) fields.password = generateFallbackPassword();

                    logMsg(`PID ${currentPid} 有货，提交加购 (${Object.keys(fields).length} 字段)`, 'ok');
                    const formData = new URLSearchParams();
                    for (const [k, v] of Object.entries(fields)) formData.append(k, v);

                    const req1 = await fetch(configUrl, {
                        method: 'POST',
                        body: formData,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        redirect: 'follow',
                        credentials: 'include',
                    });
                    const t2 = Date.now();
                    if (!req1.ok) throw new Error(`加购请求异常 ${req1.status}`);
                    logMsg(`加购成功 (${req1.status} · ${t2 - t1}ms)，发起结账`, 'ok');

                    const checkoutData = new URLSearchParams();
                    checkoutData.append('register_or_login', 'register');
                    checkoutData.append('notes', '');
                    checkoutData.append('payment', paymentMethod);
                    checkoutData.append('terms', '1');
                    checkoutData.append('promo', '');
                    checkoutData.append('riskToken', '');

                    const req2 = await fetch('/cart?action=viewcart&statuscart=checkout', {
                        method: 'POST',
                        body: checkoutData,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        redirect: 'follow',
                        credentials: 'include',
                    });
                    const t3 = Date.now();
                    if (!req2.ok) throw new Error(`结账请求异常 ${req2.status}`);

                    const finalUrl = req2.url.toLowerCase();
                    const isRealInvoice =
                        finalUrl.includes('viewinvoice') ||
                        finalUrl.includes('viewbilling') ||
                        finalUrl.includes('invoice');

                    if (!isRealInvoice) {
                        const body2 = await req2.text().catch(() => '');
                        const doc2 = new DOMParser().parseFromString(body2, 'text/html');
                        const errEl = doc2.querySelector('.errorbox, .alert-danger, #statusmessage, .alert');
                        const reason = errEl ? errEl.textContent.trim().slice(0, 100) : '未返回账单页';
                        logMsg(`PID ${currentPid} 结账被拒：${reason}`, 'warn');
                        continue;
                    }

                    logMsg(`PID ${currentPid} 锁单成功（总耗时 ${t3 - t0}ms），跳转账单页`, 'ok');
                    stageEl.textContent = `PID ${currentPid} 已生成账单`;
                    finishTask('已锁单', 'running');
                    window.location.href = req2.url;
                    grabbed = true;
                    return;
                }

                if (!grabbed && isRunning && !stopFlag) {
                    logMsg(`第 ${attempt} 轮未命中，${speedMs}ms 后重试`, 'info');
                }
            } catch (err) {
                logMsg(`请求异常：${err.message}，${speedMs}ms 后重试`, 'err');
            }

            if (isRunning && !stopFlag) {
                await new Promise((r) => setTimeout(r, speedMs));
                attempt++;
            }
        }
    }
})();
