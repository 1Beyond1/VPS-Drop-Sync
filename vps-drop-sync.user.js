// ==UserScript==
// @name         VPS Drop Sync V4.1（二段式精准对时版）
// @namespace    https://github.com/1Beyond1/VPS-Drop-Sync
// @version      4.1.0
// @description  通用 VPS 放货精准对时与自动抢购助手：二段式服务器校时、多 PID 轮询、动态表单解析和自动结账。
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

    // ============================================
    // 基础设置与时间格式处理
    // ============================================
    const toDateTimeLocalFormat = (timeStr) => {
        if (!timeStr) return "";
        // 支持秒级精度：slice 到8位包含秒 (yyyy-MM-ddTHH:mm:ss)
        const s = timeStr.replace(' ', 'T');
        return s.length >= 19 ? s.slice(0, 19) : s.slice(0, 16);
    };

    const fromDateTimeLocalFormat = (dtStr) => {
        if (!dtStr) return "";
        // datetime-local 含秒时返回完整格式，不含秒时补上 :00
        const base = dtStr.replace('T', ' ');
        return base.length >= 19 ? base : base + ':00';
    };

    const storageRead = (key, defaultVal) => {
        if (typeof GM_getValue === "function") return GM_getValue(key, defaultVal);
        const v = localStorage.getItem("tm_" + key);
        return v !== null ? v : defaultVal;
    };

    const storageWrite = (key, val) => {
        if (typeof GM_setValue === "function") GM_setValue(key, val);
        else localStorage.setItem("tm_" + key, val);
    };

    // ============================================
    // 服务商域名白名单
    // 脚本虽匹配所有网页，但未启用的站点只注册菜单，不注入面板、不发送请求。
    // 在目标服务商页面打开 Tampermonkey 菜单即可启用或禁用当前网站。
    // ============================================
    const enabledHostsStorageKey = 'vpsDropSyncEnabledHosts';

    function getEnabledHosts() {
        try {
            const hosts = JSON.parse(storageRead(enabledHostsStorageKey, '[]'));
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
                ? `❌ 在当前网站禁用 VPS Drop Sync（${currentHost}）`
                : `✅ 在当前网站启用 VPS Drop Sync（${currentHost}）`,
            () => {
                const nextHosts = isCurrentHostEnabled
                    ? enabledHosts.filter(host => host !== currentHost)
                    : [...new Set([...enabledHosts, currentHost])];
                storageWrite(enabledHostsStorageKey, JSON.stringify(nextHosts));
                location.reload();
            }
        );
    }

    if (!isCurrentHostEnabled) {
        console.info(`[VPS Drop Sync] 当前网站尚未启用：${currentHost}`);
        return;
    }

    let targetPid = storageRead('targetPid', '');
    let startTime = storageRead('startTime', '');
    let stopTime  = storageRead('stopTime',  ''); // 可选：自动停止时间
    let paymentMethod = storageRead('paymentMethod', 'AliPayH5');
    let speedMs = parseInt(storageRead('speedMs', '500'));

    // ============================================
    // 构建图形化控制面板
    // ============================================
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed; top:20px; right:20px; z-index:999999; background:rgba(0, 0, 0, 0.9); color:#eee; padding:15px; border-radius:10px; font-family:"微软雅黑", "Consolas", sans-serif; font-size:13px; min-width:320px; box-shadow:0 10px 30px rgba(0,0,0,0.8); border:1px solid #444; backdrop-filter:blur(5px); transition:all 0.3s ease;';

    panel.innerHTML = `
        <style>
            .tm-input { width:100%; box-sizing:border-box; padding:6px; background:#111; border:1px solid #444; color:#0f0; border-radius:4px; font-family:monospace; outline:none; }
            .tm-input:focus { border-color: #2196F3; }
            input[type="datetime-local"] { color-scheme: dark; font-size: 12px; }
            .tm-label { display:block; margin-bottom:4px; color:#aaa; font-size:12px; }
            .tm-btn { flex:1; padding:10px; color:#fff; border:none; cursor:pointer; font-weight:bold; border-radius:6px; box-shadow:0 4px 6px rgba(0,0,0,0.3); transition:all 0.2s; }
            .tm-log { margin-top:10px; background:#000; padding:8px; border:1px solid #333; border-radius:4px; height:150px; overflow-y:auto; font-family:monospace; font-size:11px; color:#0f0; line-height:1.4; white-space:pre-wrap; }
        </style>
        <h3 style="color:#2196F3; margin:0 0 10px 0; padding-bottom:10px; border-bottom:1px solid #333; font-size:16px; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
            <span>🕐 VPS Drop Sync V4.1｜二段式精准对时</span>
            <span id="tm-toggle" style="cursor:pointer; font-size:12px; color:#888;">[隐藏面板]</span>
        </h3>

        <div id="tm-body" style="display:block;">
            <div style="background:#222; padding:10px; border-radius:6px; margin-bottom:12px;">
                <div style="margin-bottom:8px; font-size:14px;">🎯 状态: <strong id="tm-status" style="color:#FFA500;">未启动 (待命)</strong></div>

                <div style="margin-bottom:12px;">
                    <label class="tm-label">多目标真实 PID (用逗号隔开):</label>
                    <input type="text" id="tm-pid" value="${targetPid}" class="tm-input">
                </div>

                <div style="margin-bottom:12px;">
                    <label class="tm-label">✅ 自动开抢时间 (精确到秒):</label>
                    <input type="datetime-local" id="tm-time" step="1" value="${toDateTimeLocalFormat(startTime)}" class="tm-input">
                </div>

                <div style="margin-bottom:12px;">
                    <label class="tm-label">🛑 自动停止时间 (超时后停止):</label>
                    <input type="datetime-local" id="tm-stoptime" step="1" value="${toDateTimeLocalFormat(stopTime)}" class="tm-input">
                </div>

                <div style="margin-bottom:8px;">
                    <label class="tm-label">结算付款方式:</label>
                    <select id="tm-pay" class="tm-input" style="color:#fff;">
                        <option value="AliPayH5" ${paymentMethod === 'AliPayH5' ? 'selected' : ''}>支付宝 (AliPayH5)</option>
                        <option value="wechatpay" ${paymentMethod === 'wechatpay' ? 'selected' : ''}>微信支付</option>
                        <option value="paypal" ${paymentMethod === 'paypal' ? 'selected' : ''}>PayPal</option>
                    </select>
                </div>

                <div style="margin-bottom:8px;">
                    <label class="tm-label">请求重试频率 (请遵守服务商限流规则):</label>
                    <select id="tm-speed" class="tm-input" style="color:#fff;">
                        <option value="500" ${speedMs === 500 ? 'selected' : ''}>安全模式 (500ms 重试)</option>
                        <option value="100" ${speedMs === 100 ? 'selected' : ''}>快速模式 (100ms 重试)</option>
                        <option value="10" ${speedMs === 10 ? 'selected' : ''}>极限模式 (10ms 重试，封禁风险高)</option>
                    </select>
                </div>
            </div>

            <div style="display:flex; justify-content:space-between; gap:10px;">
                <button id="tm-start" class="tm-btn" style="background:linear-gradient(135deg, #4CAF50, #2E7D32);">
                    ▶️ 启动定时 / 立即抢购
                </button>
                <button id="tm-stop" class="tm-btn" style="background:linear-gradient(135deg, #F44336, #C62828); display:none;">
                    🛑 紧急停止
                </button>
            </div>

            <div style="margin-top:12px; border-top:1px solid #333; padding-top:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                    <span style="color:#888; font-size:11px;">📋 运行日志 (跨页保存):</span>
                    <span id="tm-clear-log" style="cursor:pointer; color:#F44336; font-size:11px;">[清空日志]</span>
                </div>
                <div id="tm-log" class="tm-log"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // ============================================
    // 逻辑控制与 DOM 绑定
    // ============================================
    const statusEl = document.getElementById('tm-status');
    const startBtn = document.getElementById('tm-start');
    const stopBtn = document.getElementById('tm-stop');
    const bodyEl = document.getElementById('tm-body');
    const toggleEl = document.getElementById('tm-toggle');
    const logEl = document.getElementById('tm-log');
    const clearLogBtn = document.getElementById('tm-clear-log');

    let isRunning = false;
    let stopFlag = false;
    let timeChecker = null;
    let wakeLock = null;

    async function acquireWakeLock() {
        if (!('wakeLock' in navigator)) {
            logMsg("⚠️ 浏览器不支持 Wake Lock（升级Chrome/Edge 93+）", "#FF9800");
            return;
        }
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            logMsg("☀️ 防休眠已激活，系统不会进入睡眠", "#4CAF50");
            // 标签页重新可见时重新锁定（系统切回来后自动续期）
            if (!window._tmWakeLockListenerAdded) {
                window._tmWakeLockListenerAdded = true;
                document.addEventListener('visibilitychange', async () => {
                    if (wakeLock !== null && document.visibilityState === 'visible' && isRunning) {
                        wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
                    }
                });
            }
        } catch (e) {
            logMsg(`⚠️ Wake Lock 申请失败: ${e.message}`, "#FF9800");
        }
    }

    function releaseWakeLock() {
        if (wakeLock) {
            wakeLock.release();
            wakeLock = null;
            logMsg("🌙 防休眠已释放", "#888");
        }
    }

    toggleEl.onclick = () => {
        if (bodyEl.style.display === 'none') {
            bodyEl.style.display = 'block';
            toggleEl.innerText = "[隐藏面板]";
        } else {
            bodyEl.style.display = 'none';
            toggleEl.innerText = "[展开配置面板]";
        }
    };

    function logMsg(msg, color = "#FFA500") {
        const timeStr = new Date().toLocaleTimeString();
        const fullMsg = `[${timeStr}] ${msg}`;
        console.log("[VPS Drop Sync V4.1]", msg);
        statusEl.innerText = msg;
        statusEl.style.color = color;

        // 写入 UI 日志区
        const logLine = document.createElement('div');
        logLine.style.color = color;
        logLine.innerText = fullMsg;
        logEl.appendChild(logLine);
        logEl.scrollTop = logEl.scrollHeight;

        // 存入 sessionStorage (防止跳转丢日志)
        let logs = JSON.parse(sessionStorage.getItem('vps_drop_sync_logs') || '[]');
        logs.push({ text: fullMsg, color: color });
        if (logs.length > 100) logs.shift(); // 最多存100条
        sessionStorage.setItem('vps_drop_sync_logs', JSON.stringify(logs));
    }

    // 初始化加载日志
    const savedLogs = JSON.parse(sessionStorage.getItem('vps_drop_sync_logs') || '[]');
    savedLogs.forEach(l => {
        const line = document.createElement('div');
        line.style.color = l.color;
        line.innerText = l.text;
        logEl.appendChild(line);
    });
    logEl.scrollTop = logEl.scrollHeight;

    clearLogBtn.onclick = () => {
        sessionStorage.removeItem('vps_drop_sync_logs');
        logEl.innerHTML = '';
    };

    // ============================================
    // 服务器时钟校准 (V4.1: 多次采样取均值)
    // ============================================
    // 取5次 HEAD 请求的 NTP 中点，丢弃最大/最小 RTT，剩余3次取均值，大幅降低抖动
    let serverTimeDelta = 0;

    function serverNow() {
        return Date.now() + serverTimeDelta;
    }

    async function syncServerTime(label = '初始校时', samples = 5) {
        logMsg(`🕐 [${label}] 开始 ${samples} 次采样校准时钟...`, "#888");
        const deltas = [];
        const rtts   = [];

        for (let i = 0; i < samples; i++) {
            try {
                const t0 = Date.now();
                const r  = await fetch('/', { method: 'HEAD', credentials: 'include', cache: 'no-store' });
                const t1 = Date.now();
                const serverDateStr = r.headers.get('Date');
                if (!serverDateStr) continue;
                const rtt = t1 - t0;
                const serverMs = new Date(serverDateStr).getTime();
                const midpoint = (t0 + t1) / 2;
                deltas.push(serverMs - midpoint);
                rtts.push(rtt);
                // 采样间隔 200ms，避免连发请求
                if (i < samples - 1) await new Promise(r => setTimeout(r, 200));
            } catch (e) {
                console.warn('[VPS Drop Sync V4.1] 采样失败:', e);
            }
        }

        if (deltas.length === 0) {
            logMsg(`⚠️ [${label}] 全部采样失败，使用本地时钟`, "#FF9800");
            return;
        }

        // 按 RTT 排序，丢掉最快和最慢的采样（异常值），剩余取均值
        const paired = deltas.map((d, i) => ({ d, rtt: rtts[i] })).sort((a, b) => a.rtt - b.rtt);
        const trimmed = paired.length > 2 ? paired.slice(1, -1) : paired; // 去掉两端
        const avgDelta = Math.round(trimmed.reduce((sum, p) => sum + p.d, 0) / trimmed.length);
        const avgRtt   = Math.round(trimmed.reduce((sum, p) => sum + p.rtt, 0) / trimmed.length);

        serverTimeDelta = avgDelta;
        logMsg(`✅ [${label}] 校准完成！偏差: ${avgDelta > 0 ? '+' : ''}${avgDelta}ms | 均值RTT: ${avgRtt}ms (有效样本: ${trimmed.length}/${samples})`, "#4CAF50");
        console.log(`[VPS Drop Sync V4.1] ${label} serverTimeDelta =`, avgDelta, 'ms, avgRtt =', avgRtt, 'ms');
    }

    stopBtn.onclick = () => {
        stopFlag = true;
        isRunning = false;
        if (timeChecker) clearInterval(timeChecker);
        releaseWakeLock();
        logMsg("🛑 用户主动中止！", "#F44336");

        startBtn.style.display = 'block';
        stopBtn.style.display = 'none';

        document.getElementById('tm-pid').disabled = false;
        document.getElementById('tm-time').disabled = false;
        document.getElementById('tm-stoptime').disabled = false;
        document.getElementById('tm-pay').disabled = false;
        document.getElementById('tm-speed').disabled = false;
    };

    startBtn.onclick = async () => {
        targetPid = document.getElementById('tm-pid').value.trim();
        startTime = fromDateTimeLocalFormat(document.getElementById('tm-time').value);
        stopTime  = fromDateTimeLocalFormat(document.getElementById('tm-stoptime').value);
        paymentMethod = document.getElementById('tm-pay').value;
        speedMs = parseInt(document.getElementById('tm-speed').value);

        storageWrite('targetPid', targetPid);
        storageWrite('startTime', startTime);
        storageWrite('stopTime',  stopTime);
        storageWrite('paymentMethod', paymentMethod);
        storageWrite('speedMs', speedMs);

        const targetMs = new Date(startTime.replace(/-/g, '/')).getTime();

        if (!targetPid) {
            alert("❌ 请至少填写一个商品 PID！");
            return;
        }

        if (!startTime || isNaN(targetMs)) {
            alert("❌ 请先选择有效的抢购时间！");
            return;
        }

        document.getElementById('tm-pid').disabled = true;
        document.getElementById('tm-time').disabled = true;
        document.getElementById('tm-stoptime').disabled = true;
        document.getElementById('tm-pay').disabled = true;
        document.getElementById('tm-speed').disabled = true;

        startBtn.style.display = 'none';
        stopBtn.style.display = 'block';

        isRunning = true;
        stopFlag = false;

        acquireWakeLock(); // 防止系统休眠
        const stopMs = stopTime ? new Date(stopTime.replace(/-/g, '/')).getTime() : 0;
        if (stopMs > 0) logMsg(`⏰ 将在 ${stopTime} 自动停止`, "#888");
        logMsg(`🕐 正在与服务器校对时钟...`, "#0ff");

        // 第一段：启动时立刻做一次快速单次校时（用于倒计时准确显示）
        await syncServerTime('启动初校', 3);

        const now = serverNow();
        if (now >= targetMs) {
            startRobbing();
        } else {
            // 第二段：在开抢前 60 秒，服务器还没承压时做精准多次采样
            const preSyncMs = targetMs - 60000;
            const preSyncDelay = preSyncMs - serverNow();
            if (preSyncDelay > 1000) {
                logMsg(`📡 将在开抢前 60 秒自动精准校时`, "#888");
                setTimeout(async () => {
                    if (!isRunning || stopFlag) return;
                    await syncServerTime('开抢前精校', 5);
                }, preSyncDelay);
            }

            let lastLogTime = 0; // 日志节流用

            timeChecker = setInterval(() => {
                const innerNow = serverNow();
                if (innerNow >= targetMs) {
                    clearInterval(timeChecker);
                    startRobbing();
                } else {
                    const remainMs = targetMs - innerNow;
                    const diff = Math.floor(remainMs / 1000);

                    // 根据剩余时间决定日志频率
                    let logIntervalMs;
                    if (diff > 300) {
                        logIntervalMs = 60000;  // >5分钟：每分钟一条
                    } else if (diff > 60) {
                        logIntervalMs = 30000;  // 1~5分钟：每30秒一条
                    } else {
                        logIntervalMs = 500;    // <1分钟：原频率
                    }

                    if (innerNow - lastLogTime >= logIntervalMs) {
                        lastLogTime = innerNow;
                        if (diff > 60) {
                            logMsg(`🕐 挂机等待中... 约 ${Math.floor(diff / 60)} 分 ${diff % 60} 秒后开抢 (偏差:${serverTimeDelta > 0 ? '+' : ''}${serverTimeDelta}ms)`, "#0ff");
                        } else {
                            logMsg(`🚨 准备！倒数 ${(remainMs / 1000).toFixed(1)}s ⏱ ${remainMs}ms`, "#0ff");
                        }
                    }
                }
            }, 500);
            logMsg(`已校正本机时钟，守护程序启动，等待开抢时间...`, "#0ff");

            // 最后5秒拉高精度到 50ms
            setTimeout(() => {
                if (!isRunning || stopFlag) return;
                const remaining = targetMs - serverNow();
                if (remaining > 0 && remaining <= 5000) {
                    clearInterval(timeChecker);
                    timeChecker = setInterval(() => {
                        const innerNow2 = serverNow();
                        if (innerNow2 >= targetMs) {
                            clearInterval(timeChecker);
                            startRobbing();
                        } else {
                            const ms = targetMs - innerNow2;
                            logMsg(`🔥 倒数 ${(ms/1000).toFixed(2)}s ⏱ ${ms}ms`, "#ff0");
                        }
                    }, 50);
                }
            }, Math.max(0, targetMs - serverNow() - 5200));
        }
    };

    function startRobbing() {
        if (stopFlag) return;
        logMsg("🔥 时间到！自动抢购已启动！", "#ffeb3b");
        loopConfigAndBuy();
    }

    // ============================================
    // 抢单核心主流程
    // ============================================
    async function loopConfigAndBuy() {
        let attemptCount = 1;

        // 支持通过逗号、空格或竖线分割多个 PID
        const pidList = targetPid.split(/[,，| ]+/).map(p => p.trim()).filter(p => p);
        const stopMs = stopTime ? new Date(stopTime.replace(/-/g, '/')).getTime() : 0;

        while (isRunning && !stopFlag) {
            // ⏰ 超过结束时间则自动停止
            if (stopMs > 0 && serverNow() >= stopMs) {
                logMsg(`⏰ 已到设定的停止时间 ${stopTime}，自动结束！`, "#F44336");
                isRunning = false;
                stopFlag = true;
                releaseWakeLock();
                startBtn.style.display = 'block';
                stopBtn.style.display = 'none';
                ['tm-pid','tm-time','tm-stoptime','tm-pay','tm-speed'].forEach(id => {
                    document.getElementById(id).disabled = false;
                });
                return;
            }

            try {
                let successGrab = false;

                // 遍历用户输入的每一个可选 PID
                for (let currentPid of pidList) {
                    if (!isRunning || stopFlag) break;

                    const t0 = Date.now(); // 计时开始

                    // ★★★ V3.8 修复：每个 PID 尝试前清空购物车，防止残留商品污染 ★★★
                    await fetch('/cart?action=emptycart', { method: 'GET', credentials: 'include' }).catch(() => { });

                    const configUrl = `/cart?action=configureproduct&pid=${currentPid}`;
                    logMsg(`[#${attemptCount}] 探测商品 [PID: ${currentPid}]...`, "#0ff");

                    // GET 请求探测是否有货
                    const resp = await fetch(configUrl + "&nocache=" + Date.now(), { redirect: 'follow', credentials: 'include' });
                    const text = await resp.text();
                    const t1 = Date.now();
                    logMsg(`   └─ GET 响应: ${resp.status} | ${text.length} 字节 | 耗时 ${t1 - t0}ms`, "#888");

                    if (text.includes('未到时间') || text.includes('缺货') || text.includes('Out of Stock')) {
                        logMsg(`🚫 [PID: ${currentPid}] 缺货或未开放，秒切下个...`, "#FF9800");
                        continue; // 此 PID 没货，立刻去探测下一个 PID
                    }

                    logMsg(`✅ [PID: ${currentPid}] 捕获有货！解析表单中...`, "#0ff");

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');

                    const form = doc.getElementById('frmConfigureProduct') || doc.querySelector('form');
                    if (!form) {
                        logMsg(`⚠️ [PID: ${currentPid}] HTML未找到表单结构，跳过... (HTML前200字: ${text.slice(0, 200)})`, "#FF9800");
                        continue;
                    }
                    logMsg(`   └─ 表单ID: ${form.id || '无ID'} | action: ${form.action || '无'}`, "#888");

                    // 收集所有表单字段
                    let fields = {};

                    form.querySelectorAll('input').forEach(input => {
                        if (input.name) {
                            if (input.type === 'radio' || input.type === 'checkbox') {
                                if (input.checked) fields[input.name] = input.value;
                            } else {
                                fields[input.name] = input.value;
                            }
                        }
                    });

                    form.querySelectorAll('select').forEach(sel => {
                        if (sel.name) {
                            // DOMParser 不执行 JS，所以优先取 selected option，否则取第一个 option
                            const selectedOpt = sel.querySelector('option[selected]') || sel.querySelector('option');
                            fields[sel.name] = selectedOpt ? selectedOpt.value : sel.value;
                        }
                    });

                    // ★★★ 核心修复：强制锁定正确的当前循环 PID 和数量 ★★★
                    fields['pid'] = currentPid;
                    fields['qty'] = '1';

                    if ('host' in fields && !fields['host']) fields['host'] = 'vps-drop-sync-' + Date.now();
                    if ('password' in fields && !fields['password']) fields['password'] = 'GenPass123!@';

                    const fieldKeys = Object.keys(fields);
                    logMsg(`   └─ 解析到 ${fieldKeys.length} 个字段: ${fieldKeys.join(', ')}`, "#888");
                    console.log("[VPS Drop Sync Debug] Final Fields for PID " + currentPid + ":", fields);
                    logMsg(`🚀 发包中: POST 加购 [PID: ${currentPid}]...`, "#0f0");

                    // 第一步：POST 加购
                    const formData = new URLSearchParams();
                    for (const [k, v] of Object.entries(fields)) {
                        formData.append(k, v);
                    }

                    const req1 = await fetch(configUrl, {
                        method: 'POST',
                        body: formData,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        redirect: 'follow',
                        credentials: 'include'
                    });
                    const t2 = Date.now();
                    if (!req1.ok) throw new Error(`加购 POST 报错 ${req1.status} (耗时${t2-t1}ms)`);
                    logMsg(`🛒 加购完成 ${req1.status} | 跳转: ${req1.url.replace(location.origin,'').slice(0,60)} | 耗时 ${t2-t1}ms`, "#0f0");
                    logMsg(`   └─ 0ms 延迟发起结账请求...`, "#888");

                    // 第二步：POST 结账（复用页面正常流程所需字段）
                    const checkoutData = new URLSearchParams();
                    checkoutData.append("register_or_login", "register");
                    checkoutData.append("notes", "");
                    checkoutData.append("payment", paymentMethod);
                    checkoutData.append("terms", "1"); // 强制同意协议
                    checkoutData.append("promo", "");
                    checkoutData.append("riskToken", "");

                    const req2 = await fetch('/cart?action=viewcart&statuscart=checkout', {
                        method: 'POST',
                        body: checkoutData,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        redirect: 'follow',
                        credentials: 'include'
                    });
                    const t3 = Date.now();
                    if (!req2.ok) throw new Error(`结账 POST 报错 ${req2.status} (耗时${t3-t2}ms)`);
                    logMsg(`💳 结账响应 ${req2.status} | 跳转: ${req2.url.replace(location.origin,'').slice(0,60)} | 耗时 ${t3-t2}ms`, "#0f0");
                    logMsg(`   └─ 本轮总耗时: ${t3-t0}ms`, "#888");

                    // ★★★ V3.5 终极修复：验证结账是否被服务器真正认可 ★★★
                    const finalUrl = req2.url.toLowerCase();
                    // V3.8: 收紧白名单，只认 viewinvoice/viewbilling 账单页
                    const isRealInvoice = finalUrl.includes('viewinvoice') || finalUrl.includes('viewbilling') || finalUrl.includes('invoice');
                    if (!isRealInvoice) {
                        // V3.9: 解析服务器返回的 HTML，提取真实的驳回原因
                        const body2 = await req2.text().catch(() => '');
                        const doc2 = new DOMParser().parseFromString(body2, 'text/html');
                        // WHMCS 错误信息通常在 .errorbox / .alert-danger / #statusmessage 里
                        const errEl = doc2.querySelector('.errorbox, .alert-danger, #statusmessage, .alert');
                        const errText = errEl ? errEl.innerText.trim().slice(0, 120) : '（无法提取原因）';
                        const shortUrl = req2.url.replace(location.origin, '').slice(0, 80);
                        logMsg(`🚫 [PID: ${currentPid}] 驳回 → 跳转: ${shortUrl}`, "#FF9800");
                        logMsg(`   原因: ${errText}`, "#FF5722");
                        console.warn("[VPS Drop Sync V4.1] Checkout rejected. Final URL:", req2.url);
                        console.warn("[VPS Drop Sync V4.1] Error extract:", errText);
                        console.warn("[VPS Drop Sync V4.1] Full response body:", body2.slice(0, 2000));
                        continue;
                    }

                    logMsg(`🎉 真的抢到了 [PID: ${currentPid}]！跳转账单页...`, "#ffeb3b");
                    releaseWakeLock(); // 抢到了，不用再防休眠

                    // V3.8: 用非阻塞的通知替代 alert，避免浪费时间
                    const successBanner = document.createElement('div');
                    successBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999999;background:#4CAF50;color:#fff;text-align:center;padding:20px;font-size:20px;font-weight:bold;animation:flash 0.5s infinite alternate;';
                    const flashStyle = document.createElement('style');
                    flashStyle.textContent = '@keyframes flash{from{opacity:1}to{opacity:0.5}}';
                    document.head.appendChild(flashStyle);
                    successBanner.innerHTML = `🎉 VPS Drop Sync 已抢到 [PID: ${currentPid}]！正在跳转支付页…`;
                    document.body.appendChild(successBanner);

                    // 结束脚本并直达刚生成的账单页
                    window.location.href = req2.url;
                    successGrab = true;
                    return; // 彻底结束
                }

                // 如果这一回合把所有的 PID 都查了一遍都没成功，才进入外层的等待
                if (!successGrab && isRunning && !stopFlag) {
                    logMsg(`⏸ 所有的备选商品均被驳回或无货，${speedMs}ms后重试全体循环...`, "#FF9800");
                }

            } catch (e) {
                console.error(e);
                logMsg(`⚠️ 报错: ${e.message}`, "#f00");
                logMsg(`   └─ ${speedMs}ms 后重试下一轮...`, "#888");
            }

            if (isRunning && !stopFlag) {
                await new Promise(r => setTimeout(r, speedMs));
                attemptCount++;
            }
        }
    }

})();
