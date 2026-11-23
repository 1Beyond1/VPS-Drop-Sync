// ==UserScript==
// @name         VPS Drop Sync
// @namespace    https://github.com/1Beyond1/VPS-Drop-Sync
// @version      4.3.0
// @description  通用 VPS 放货精准对时与自动抢购助手：按域名隔离配置、二段式服务器校时、快捷时间预设、多通道强提醒与自动结账。
// @author       1Beyond1
// @license      MIT
// @homepageURL  https://github.com/1Beyond1/VPS-Drop-Sync
// @supportURL   https://github.com/1Beyond1/VPS-Drop-Sync/issues
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/1Beyond1/VPS-Drop-Sync/main/vps-drop-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/1Beyond1/VPS-Drop-Sync/main/vps-drop-sync.user.js
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '4.3.0';
    const ENABLED_HOSTS_KEY = 'vpsDropSyncEnabledHosts';
    const HOST_CONFIG_PREFIX = 'vpsDropSyncHostConfig::';
    const LOG_STORAGE_KEY = 'vps_drop_sync_logs';
    const MAX_LOGS = 100;
    const PRE_SYNC_LEAD_MS = 60000;
    const SPRINT_LEAD_MS = 5200;
    const SYNC_TIMEOUT_MS = 4000;
    const REQUEST_TIMEOUT_MS = 8000;
    const MAX_TIMEOUT_MS = 2147483647;
    const PRESET_PAYMENT_METHODS = ['AliPayH5', 'wechatpay', 'paypal'];
    const CUSTOM_PAYMENT_OPTION = '__custom__';
    const VALID_SPEEDS = [500, 100, 10];
    const LEGACY_KEYS = ['targetPid', 'startTime', 'stopTime', 'paymentMethod', 'speedMs'];
    const MISSING_SENTINEL = '__VDS_MISSING_SENTINEL__';

    // --------------------------------------------
    // 核心纯逻辑（同时导出给 Node 单元测试复用）
    // --------------------------------------------
    const pad2 = (n) => String(n).padStart(2, '0');

    const formatLocalDateTime = (ms) => {
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return '';
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };

    const parseLocalDateTime = (timeStr) => {
        if (typeof timeStr !== 'string') return NaN;
        const trimmed = timeStr.trim();
        if (!trimmed) return NaN;
        const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
        if (!match) return NaN;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = match[6] !== undefined ? Number(match[6]) : 0;
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
            return NaN;
        }
        const date = new Date(year, month - 1, day, hour, minute, second, 0);
        if (
            date.getFullYear() !== year ||
            date.getMonth() !== month - 1 ||
            date.getDate() !== day ||
            date.getHours() !== hour ||
            date.getMinutes() !== minute ||
            date.getSeconds() !== second
        ) {
            return NaN;
        }
        return date.getTime();
    };

    const toDateTimeLocal = (timeStr) => {
        if (!timeStr) return '';
        const normalized = String(timeStr).trim().replace(' ', 'T');
        return normalized.length >= 19 ? normalized.slice(0, 19) : normalized.slice(0, 16);
    };

    const fromDateTimeLocal = (dtStr) => {
        if (!dtStr) return '';
        const base = String(dtStr).trim().replace('T', ' ');
        return base.length >= 19 ? base.slice(0, 19) : `${base}:00`;
    };

    const formatCountdown = (remainMs) => {
        const clamped = Math.max(0, Number.isFinite(remainMs) ? remainMs : 0);
        const totalSec = Math.floor(clamped / 1000);
        const hours = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        const tenths = Math.floor((clamped % 1000) / 100);
        return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}.${tenths}`;
    };

    const computeTimePreset = (preset, { nowMs = Date.now(), startTimeStr = '' } = {}) => {
        const baseMs = Math.floor(nowMs / 1000) * 1000;
        if (preset === 'next-hour') {
            const d = new Date(baseMs);
            d.setMinutes(0, 0, 0);
            d.setHours(d.getHours() + 1);
            return { field: 'startTime', value: formatLocalDateTime(d.getTime()) };
        }
        if (preset === '+1m') {
            return { field: 'startTime', value: formatLocalDateTime(baseMs + 60 * 1000) };
        }
        if (preset === '+5m') {
            return { field: 'startTime', value: formatLocalDateTime(baseMs + 5 * 60 * 1000) };
        }
        if (preset === 'stop+3m') {
            const parsedStart = parseLocalDateTime(startTimeStr);
            const anchorMs = Number.isNaN(parsedStart) ? baseMs : parsedStart;
            return { field: 'stopTime', value: formatLocalDateTime(anchorMs + 3 * 60 * 1000) };
        }
        return null;
    };

    const createDefaultHostConfig = () => ({
        targetPid: '',
        startTime: '',
        stopTime: '',
        paymentMethod: 'AliPayH5',
        speedMs: 500,
        promoCode: '',
        soundMuted: false,
        collapsed: false,
        panelPos: null,
    });

    const normalizePanelPos = (pos) => {
        if (!pos || typeof pos !== 'object') return null;
        const left = Number(pos.left);
        const top = Number(pos.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
        return { left: Math.round(left), top: Math.round(top) };
    };

    const normalizeHostConfig = (raw) => {
        const defaults = createDefaultHostConfig();
        if (!raw || typeof raw !== 'object') return defaults;
        const parsedSpeed = parseInt(String(raw.speedMs ?? defaults.speedMs), 10);
        const speedMs = VALID_SPEEDS.includes(parsedSpeed) ? parsedSpeed : defaults.speedMs;
        const paymentMethod = String(raw.paymentMethod ?? '').trim() || defaults.paymentMethod;
        return {
            targetPid: String(raw.targetPid ?? '').trim(),
            startTime: String(raw.startTime ?? '').trim(),
            stopTime: String(raw.stopTime ?? '').trim(),
            paymentMethod,
            speedMs,
            promoCode: String(raw.promoCode ?? '').trim(),
            soundMuted: Boolean(raw.soundMuted),
            collapsed: Boolean(raw.collapsed),
            panelPos: normalizePanelPos(raw.panelPos),
        };
    };

    const getHostConfigKey = (host) => `${HOST_CONFIG_PREFIX}${String(host || '').toLowerCase()}`;

    const loadHostConfig = (host, store) => {
        const key = getHostConfigKey(host);
        const storedRaw = store.get(key, MISSING_SENTINEL);
        if (storedRaw !== MISSING_SENTINEL && storedRaw !== null && storedRaw !== undefined && storedRaw !== '') {
            try {
                const parsed = typeof storedRaw === 'string' ? JSON.parse(storedRaw) : storedRaw;
                if (parsed && typeof parsed === 'object') {
                    return { config: normalizeHostConfig(parsed), migrated: false };
                }
            } catch {
                // JSON 损坏时回退至迁移/默认值
            }
        }

        let hasLegacy = false;
        const legacyData = {};
        for (const legacyKey of LEGACY_KEYS) {
            const value = store.get(legacyKey, MISSING_SENTINEL);
            if (value !== MISSING_SENTINEL && value !== null && value !== undefined) {
                hasLegacy = true;
                legacyData[legacyKey] = value;
            }
        }

        const config = normalizeHostConfig(hasLegacy ? legacyData : {});
        if (hasLegacy) {
            store.set(key, JSON.stringify(config));
        }
        return { config, migrated: hasLegacy };
    };

    const saveHostConfig = (host, patch, store) => {
        const { config: current } = loadHostConfig(host, store);
        const next = normalizeHostConfig({ ...current, ...patch });
        store.set(getHostConfigKey(host), JSON.stringify(next));
        return next;
    };

    const resolvePaymentSelection = (paymentMethod) => {
        const normalized = String(paymentMethod || '').trim() || 'AliPayH5';
        if (PRESET_PAYMENT_METHODS.includes(normalized)) {
            return { selectValue: normalized, customValue: '', isCustom: false };
        }
        return { selectValue: CUSTOM_PAYMENT_OPTION, customValue: normalized, isCustom: true };
    };

    const resolvePaymentInput = (selectValue, customValue) => {
        if (selectValue === CUSTOM_PAYMENT_OPTION) {
            return String(customValue || '').trim();
        }
        return String(selectValue || '').trim();
    };

    const computeClockCalibration = (pairs) => {
        if (!Array.isArray(pairs) || pairs.length === 0) return null;
        const valid = pairs.filter((p) => p && Number.isFinite(p.delta) && Number.isFinite(p.rtt));
        if (valid.length === 0) return null;
        const sorted = [...valid].sort((a, b) => a.rtt - b.rtt);
        const trimmed = sorted.length > 2 ? sorted.slice(1, -1) : sorted;
        const avgDelta = Math.round(trimmed.reduce((sum, p) => sum + p.delta, 0) / trimmed.length);
        const avgRtt = Math.round(trimmed.reduce((sum, p) => sum + p.rtt, 0) / trimmed.length);
        return { avgDelta, avgRtt, usedCount: trimmed.length, totalCount: valid.length };
    };

    const computeSchedulePlan = ({
        targetMs,
        nowMs,
        serverTimeDelta = 0,
        preSyncLeadMs = PRE_SYNC_LEAD_MS,
        sprintLeadMs = SPRINT_LEAD_MS,
    }) => {
        const serverNowMs = nowMs + serverTimeDelta;
        const remainMs = targetMs - serverNowMs;
        const shouldStartPolling = remainMs <= 0;
        const shouldPreSync = !shouldStartPolling && remainMs > preSyncLeadMs + 1000;
        const preSyncDelayMs = shouldPreSync ? remainMs - preSyncLeadMs : null;
        const shouldSprintImmediately = !shouldStartPolling && remainMs <= sprintLeadMs;
        const sprintDelayMs = shouldStartPolling ? 0 : Math.max(0, remainMs - sprintLeadMs);
        return {
            serverNowMs,
            remainMs,
            shouldStartPolling,
            shouldPreSync,
            preSyncDelayMs,
            shouldSprintImmediately,
            sprintDelayMs,
        };
    };

    const parsePidList = (raw) => {
        const seen = new Set();
        const result = [];
        for (const item of String(raw || '').split(/[,，|\s]+/)) {
            const trimmed = item.trim();
            if (trimmed && !seen.has(trimmed)) {
                seen.add(trimmed);
                result.push(trimmed);
            }
        }
        return result;
    };

    const isOutOfStockHtml = (html) => {
        const text = String(html || '');
        return text.includes('未到时间') || text.includes('缺货') || /out of stock/i.test(text);
    };

    const isInvoiceUrl = (url) => {
        const rawUrl = String(url || '').trim();
        if (!rawUrl) return false;
        let pathname = '';
        try {
            const parsed = new URL(rawUrl, 'https://placeholder.local');
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
            pathname = parsed.pathname.toLowerCase();
        } catch {
            return false;
        }
        return /\/(viewinvoice|viewbilling|invoices?)([._/-]|$)/.test(pathname);
    };

    const isLoginRedirect = (url, html = '') => {
        const rawUrl = String(url || '').trim();
        const lowerUrl = rawUrl.toLowerCase();
        let pathname = lowerUrl;
        let search = '';
        try {
            const parsed = new URL(rawUrl, 'https://placeholder.local');
            pathname = parsed.pathname.toLowerCase();
            search = parsed.search.toLowerCase();
        } catch {
            const idx = lowerUrl.indexOf('?');
            if (idx >= 0) {
                pathname = lowerUrl.slice(0, idx);
                search = lowerUrl.slice(idx);
            }
        }
        if (/\/(login|dologin|signin)(\.php)?(\/|$)/.test(pathname) || /[?&]action=login(&|$)/.test(search)) {
            return true;
        }
        if (/[?&]action=(configureproduct|viewcart)(&|$)/.test(search)) {
            return false;
        }
        const text = String(html || '');
        return (
            /name=["']?username["']?/i.test(text) &&
            /type=["']?password["']?/i.test(text) &&
            !/frmConfigureProduct/i.test(text)
        );
    };

    const classifyCheckoutResponse = (url, html = '') => {
        if (isLoginRedirect(url, html)) return 'login';
        if (isInvoiceUrl(url)) return 'invoice';
        return 'rejected';
    };

    const findConfigureProductForm = (doc) => {
        if (!doc) return null;
        if (typeof doc.getElementById === 'function') {
            const byId = doc.getElementById('frmConfigureProduct');
            if (byId) return byId;
        }
        const forms =
            typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('form') || []) : [];
        for (const form of forms) {
            if (!form) continue;
            const id = String(form.id || form.getAttribute?.('id') || '').toLowerCase();
            if (id === 'frmconfigureproduct') return form;

            const className = String(form.className || form.getAttribute?.('class') || '').toLowerCase();
            const role = String(form.getAttribute?.('role') || '').toLowerCase();
            const action = String(form.getAttribute?.('action') ?? form.action ?? '').toLowerCase();
            const method = String(form.getAttribute?.('method') ?? form.method ?? '').toLowerCase();

            if (role === 'search' || /\b(search|login|signin|newsletter)\b/.test(`${id} ${className}`)) {
                continue;
            }
            if (/\/(search|login|dologin|signin)(\.php)?(\/|\?|$)/.test(action)) {
                continue;
            }

            const controls =
                typeof form.querySelectorAll === 'function'
                    ? Array.from(form.querySelectorAll('input, select, textarea') || [])
                    : [];
            const hasConfigField = controls.some((el) => {
                const name = String(el?.name || el?.getAttribute?.('name') || '').toLowerCase();
                return (
                    name === 'billingcycle' ||
                    name === 'pid' ||
                    name === 'productid' ||
                    name === 'cycle' ||
                    name.startsWith('configoption') ||
                    name.startsWith('customfield') ||
                    name.startsWith('addons') ||
                    name.startsWith('addon[')
                );
            });

            const hasConfigAction =
                /[?&]action=(configureproduct|add)(&|$)/i.test(action) ||
                /configureproduct/i.test(action);

            if (hasConfigField || (hasConfigAction && method === 'post')) {
                return form;
            }
        }
        return null;
    };

    const appendFormField = (fields, name, value) => {
        if (!(name in fields)) {
            fields[name] = value;
        } else if (Array.isArray(fields[name])) {
            fields[name].push(value);
        } else {
            fields[name] = [fields[name], value];
        }
    };

    const isOptionDisabled = (opt) =>
        Boolean(
            opt &&
                (opt.disabled ||
                    (typeof opt.hasAttribute === 'function' && opt.hasAttribute('disabled')) ||
                    opt.parentElement?.disabled)
        );

    const isOptionSelected = (opt) =>
        Boolean(opt && (opt.selected || (typeof opt.hasAttribute === 'function' && opt.hasAttribute('selected'))));

    const extractFormFields = (form, currentPid, { nowMs = Date.now(), fallbackPassword = () => 'VdsFallback#2026' } = {}) => {
        if (!form || typeof form.querySelectorAll !== 'function') return null;
        const fields = {};

        for (const input of form.querySelectorAll('input') || []) {
            if (!input.name || input.disabled) continue;
            const type = String(input.type || 'text').toLowerCase();
            if (type === 'radio') {
                if (input.checked) fields[input.name] = input.value ?? '';
            } else if (type === 'checkbox') {
                if (input.checked) appendFormField(fields, input.name, input.value ?? '');
            } else if (
                type !== 'file' &&
                type !== 'reset' &&
                type !== 'button' &&
                type !== 'submit' &&
                type !== 'image'
            ) {
                appendFormField(fields, input.name, input.value ?? '');
            }
        }

        for (const sel of form.querySelectorAll('select') || []) {
            if (!sel.name || sel.disabled) continue;
            const optionList =
                typeof sel.querySelectorAll === 'function'
                    ? Array.from(sel.querySelectorAll('option') || [])
                    : Array.isArray(sel.options)
                      ? Array.from(sel.options)
                      : null;

            if (optionList) {
                const enabledOptions = optionList.filter((o) => o && !isOptionDisabled(o));
                if (sel.multiple) {
                    const selectedEnabled = enabledOptions.filter((o) => isOptionSelected(o));
                    for (const o of selectedEnabled) {
                        appendFormField(fields, sel.name, o.value ?? '');
                    }
                } else {
                    const selectedOpt = enabledOptions.find((o) => isOptionSelected(o)) || enabledOptions[0] || null;
                    if (selectedOpt) {
                        appendFormField(fields, sel.name, selectedOpt.value ?? '');
                    } else if (optionList.length === 0) {
                        appendFormField(fields, sel.name, sel.value ?? '');
                    }
                }
            } else if (typeof sel.querySelector === 'function') {
                const selectedOpt =
                    sel.querySelector('option[selected]:not([disabled])') || sel.querySelector('option[selected]');
                const fallbackOpt = sel.querySelector('option:not([disabled])') || sel.querySelector('option');
                const opt =
                    (selectedOpt && !isOptionDisabled(selectedOpt) ? selectedOpt : null) ||
                    (fallbackOpt && !isOptionDisabled(fallbackOpt) ? fallbackOpt : null);
                if (opt) {
                    appendFormField(fields, sel.name, opt.value ?? '');
                } else if (!selectedOpt && !fallbackOpt) {
                    appendFormField(fields, sel.name, sel.value ?? '');
                }
            } else {
                appendFormField(fields, sel.name, sel.value ?? '');
            }
        }

        for (const ta of form.querySelectorAll('textarea') || []) {
            if (!ta.name || ta.disabled) continue;
            appendFormField(fields, ta.name, ta.value ?? '');
        }

        fields.pid = String(currentPid);
        fields.qty = '1';
        if ('host' in fields && !fields.host) fields.host = `vps-${nowMs}`;
        if ('password' in fields && !fields.password) fields.password = fallbackPassword();
        return fields;
    };

    const buildFormUrlSearchParams = (fields) => {
        const formData = new URLSearchParams();
        if (!fields || typeof fields !== 'object') return formData;
        for (const [k, v] of Object.entries(fields)) {
            if (Array.isArray(v)) {
                for (const item of v) {
                    formData.append(k, String(item ?? ''));
                }
            } else {
                formData.append(k, String(v ?? ''));
            }
        }
        return formData;
    };

    const buildCheckoutPayload = ({ paymentMethod, promoCode = '', notes = '' }) => {
        const params = new URLSearchParams();
        params.append('register_or_login', 'register');
        params.append('notes', String(notes || ''));
        params.append('payment', String(paymentMethod || ''));
        params.append('terms', '1');
        params.append('promo', String(promoCode || '').trim());
        params.append('riskToken', '');
        return params;
    };

    const getEnabledHostsFromStore = (store) => {
        try {
            const raw = store.get(ENABLED_HOSTS_KEY, '[]');
            const hosts = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(hosts) ? hosts : [];
        } catch {
            return [];
        }
    };

    const updateEnabledHosts = (store, host, enable) => {
        const latestHosts = getEnabledHostsFromStore(store);
        const nextHosts = enable
            ? [...new Set([...latestHosts, host])]
            : latestHosts.filter((item) => item !== host);
        store.set(ENABLED_HOSTS_KEY, JSON.stringify(nextHosts));
        return nextHosts;
    };

    const createAbortError = (message = 'The operation was aborted') => {
        const err = new Error(message);
        err.name = 'AbortError';
        return err;
    };

    const createTimeoutError = (timeoutMs) => {
        const err = new Error(`请求超时 (${timeoutMs}ms)`);
        err.name = 'TimeoutError';
        return err;
    };

    const fetchWithTimeout = async (
        url,
        options = {},
        timeoutMs = REQUEST_TIMEOUT_MS,
        signal = null,
        fetchImpl = typeof fetch === 'function' ? fetch : null
    ) => {
        if (typeof fetchImpl !== 'function') {
            throw new Error('fetch is not available');
        }
        const externalSignals = [];
        if (signal) externalSignals.push(signal);
        if (options && options.signal && options.signal !== signal) externalSignals.push(options.signal);

        if (externalSignals.some((s) => s.aborted)) {
            throw createAbortError();
        }

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timedOut = false;
        let externallyAborted = false;
        let timeoutId = null;

        const onExternalAbort = () => {
            externallyAborted = true;
            if (controller) {
                try {
                    controller.abort();
                } catch {}
            }
        };

        for (const s of externalSignals) {
            s.addEventListener('abort', onExternalAbort, { once: true });
        }

        if (controller && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                timedOut = true;
                try {
                    controller.abort();
                } catch {}
            }, timeoutMs);
        }

        try {
            const fetchOptions = { ...(options || {}) };
            if (controller) fetchOptions.signal = controller.signal;
            return await fetchImpl(url, fetchOptions);
        } catch (err) {
            if (timedOut) throw createTimeoutError(timeoutMs);
            if (externallyAborted || externalSignals.some((s) => s.aborted)) {
                throw createAbortError();
            }
            throw err;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
            for (const s of externalSignals) {
                s.removeEventListener('abort', onExternalAbort);
            }
        }
    };

    const readTextWithTimeout = (resp, timeoutMs = REQUEST_TIMEOUT_MS, signal = null) => {
        if (signal?.aborted) {
            return Promise.reject(createAbortError());
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            const cleanup = () => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
            };
            const finishResolve = (val) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(val);
            };
            const finishReject = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            const onAbort = () => finishReject(createAbortError());

            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                timeoutId = setTimeout(() => finishReject(createTimeoutError(timeoutMs)), timeoutMs);
            }

            Promise.resolve()
                .then(() => resp.text())
                .then(finishResolve, finishReject);
        });
    };

    const abortableSleep = (ms, signal = null, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) =>
        new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(false);
                return;
            }
            let done = false;
            let timerId = null;
            const finish = (completed) => {
                if (done) return;
                done = true;
                if (timerId !== null) {
                    clearTimeoutFn(timerId);
                    timerId = null;
                }
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
                resolve(completed);
            };
            const onAbort = () => finish(false);
            timerId = setTimeoutFn(() => finish(true), Math.max(0, Number(ms) || 0));
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });

    const scheduleLongTimeout = (
        callback,
        delayMs,
        { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, nowFn = Date.now, maxDelayMs = MAX_TIMEOUT_MS } = {}
    ) => {
        let cancelled = false;
        let timerId = null;
        const safeDelay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
        const targetEndMs = nowFn() + safeDelay;

        const step = () => {
            if (cancelled) return;
            const remaining = Math.max(0, targetEndMs - nowFn());
            if (remaining <= maxDelayMs) {
                timerId = setTimeoutFn(() => {
                    timerId = null;
                    if (!cancelled) callback();
                }, remaining);
            } else {
                timerId = setTimeoutFn(() => {
                    timerId = null;
                    step();
                }, maxDelayMs);
            }
        };

        step();

        return {
            cancel() {
                cancelled = true;
                if (timerId !== null) {
                    clearTimeoutFn(timerId);
                    timerId = null;
                }
            },
        };
    };

    const createRunController = () => {
        let activeRunId = 0;
        let activeAbortController = null;
        let isRunning = false;
        let stopFlag = false;
        let isPolling = false;
        let pollingRunId = 0;

        const abortActive = () => {
            if (activeAbortController) {
                try {
                    activeAbortController.abort();
                } catch {}
                activeAbortController = null;
            }
        };

        return {
            get activeRunId() {
                return activeRunId;
            },
            get activeAbortController() {
                return activeAbortController;
            },
            get signal() {
                return activeAbortController ? activeAbortController.signal : null;
            },
            get isRunning() {
                return isRunning;
            },
            get stopFlag() {
                return stopFlag;
            },
            get isPolling() {
                return isPolling;
            },
            startRun() {
                abortActive();
                activeRunId += 1;
                activeAbortController = typeof AbortController === 'function' ? new AbortController() : null;
                isRunning = true;
                stopFlag = false;
                isPolling = false;
                pollingRunId = 0;
                return { runId: activeRunId, signal: activeAbortController ? activeAbortController.signal : null };
            },
            stopRun() {
                activeRunId += 1;
                abortActive();
                isRunning = false;
                stopFlag = true;
                isPolling = false;
                pollingRunId = 0;
                return activeRunId;
            },
            isActive(runId) {
                return runId === activeRunId && isRunning && !stopFlag;
            },
            tryEnterPolling(runId) {
                if (runId !== activeRunId || !isRunning || stopFlag) return false;
                if (isPolling && pollingRunId === runId) return false;
                isPolling = true;
                pollingRunId = runId;
                return true;
            },
        };
    };

    const clampPanelPosition = (pos, viewportWidth, viewportHeight, panelWidth, panelHeight, margin = 8) => {
        if (!pos) return null;
        const maxX = Math.max(margin, viewportWidth - panelWidth - margin);
        const maxY = Math.max(margin, viewportHeight - panelHeight - margin);
        return {
            left: Math.min(maxX, Math.max(margin, Math.round(pos.left))),
            top: Math.min(maxY, Math.max(margin, Math.round(pos.top))),
        };
    };

    const core = {
        VERSION,
        ENABLED_HOSTS_KEY,
        HOST_CONFIG_PREFIX,
        PRESET_PAYMENT_METHODS,
        CUSTOM_PAYMENT_OPTION,
        VALID_SPEEDS,
        PRE_SYNC_LEAD_MS,
        SPRINT_LEAD_MS,
        SYNC_TIMEOUT_MS,
        REQUEST_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        MISSING_SENTINEL,
        formatLocalDateTime,
        parseLocalDateTime,
        toDateTimeLocal,
        fromDateTimeLocal,
        formatCountdown,
        computeTimePreset,
        createDefaultHostConfig,
        normalizePanelPos,
        normalizeHostConfig,
        getHostConfigKey,
        loadHostConfig,
        saveHostConfig,
        resolvePaymentSelection,
        resolvePaymentInput,
        computeClockCalibration,
        computeSchedulePlan,
        parsePidList,
        isOutOfStockHtml,
        isInvoiceUrl,
        isLoginRedirect,
        classifyCheckoutResponse,
        findConfigureProductForm,
        extractFormFields,
        buildFormUrlSearchParams,
        buildCheckoutPayload,
        getEnabledHostsFromStore,
        updateEnabledHosts,
        fetchWithTimeout,
        readTextWithTimeout,
        abortableSleep,
        scheduleLongTimeout,
        createRunController,
        clampPanelPosition,
    };

    // Node 环境下仅导出纯逻辑以便自动化单元测试，不触碰浏览器 DOM
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = core;
        return;
    }

    // --------------------------------------------
    // 浏览器存储适配器（GM 存储优先，回退 localStorage）
    // --------------------------------------------
    const gmStore = {
        get(key, defaultVal) {
            try {
                if (typeof GM_getValue === 'function') return GM_getValue(key, defaultVal);
                const v = localStorage.getItem(`tm_${key}`);
                return v !== null ? v : defaultVal;
            } catch {
                return defaultVal;
            }
        },
        set(key, val) {
            try {
                if (typeof GM_setValue === 'function') GM_setValue(key, val);
                else localStorage.setItem(`tm_${key}`, String(val));
            } catch {
                // 隐私模式或存储受限时忽略持久化失败
            }
        },
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
        return getEnabledHostsFromStore(gmStore);
    }

    const currentHost = location.host;
    const isCurrentHostEnabled = getEnabledHosts().includes(currentHost);

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand(
            isCurrentHostEnabled
                ? `在当前网站禁用 VPS Drop Sync（${currentHost}）`
                : `在当前网站启用 VPS Drop Sync（${currentHost}）`,
            () => {
                const latestHosts = getEnabledHosts();
                const nextHosts = isCurrentHostEnabled
                    ? latestHosts.filter((host) => host !== currentHost)
                    : [...new Set([...latestHosts, currentHost])];
                gmStore.set(ENABLED_HOSTS_KEY, JSON.stringify(nextHosts));
                location.reload();
            }
        );
    }

    if (!isCurrentHostEnabled) return;

    // --------------------------------------------
    // 按域名加载配置（首次自动兼容迁移旧版全局键）
    // --------------------------------------------
    const initialLoad = loadHostConfig(currentHost, gmStore);
    let hostConfig = initialLoad.config;

    function persistConfig(patch) {
        hostConfig = saveHostConfig(currentHost, patch, gmStore);
        return hostConfig;
    }

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
                width: 364px;
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
            .vds-card.collapsed { width: auto; min-width: 248px; }
            .vds-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 10px 13px;
                background: linear-gradient(180deg, rgba(30, 41, 59, 0.65), rgba(15, 23, 42, 0.35));
                border-bottom: 1px solid rgba(148, 163, 184, 0.14);
                cursor: grab;
            }
            .vds-header:active { cursor: grabbing; }
            .vds-card.collapsed .vds-header { border-bottom: none; }
            .vds-title-wrap { display: flex; align-items: center; gap: 7px; min-width: 0; }
            .vds-head-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
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
                transition: background 0.15s, color 0.15s, border-color 0.15s;
            }
            .vds-toggle:hover { background: rgba(148, 163, 184, 0.22); color: #fff; }
            .vds-toggle.muted { color: #94a3b8; border-color: rgba(148, 163, 184, 0.14); opacity: 0.8; }
            .vds-body {
                padding: 11px 13px 13px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-height: calc(100vh - 64px);
                overflow-y: auto;
            }
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
            .vds-field.hidden { display: none; }
            .vds-label { font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }
            .vds-hint { color: #64748b; font-size: 10.5px; }
            .vds-input, .vds-select {
                width: 100%;
                height: 30px;
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

            .vds-presets {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                margin-top: 2px;
            }
            .vds-pill {
                flex: 1 1 auto;
                height: 24px;
                padding: 0 8px;
                border-radius: 999px;
                background: rgba(56, 189, 248, 0.1);
                border: 1px solid rgba(56, 189, 248, 0.26);
                color: #bae6fd;
                font-size: 11px;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
                white-space: nowrap;
            }
            .vds-pill:hover:not(:disabled) {
                background: rgba(56, 189, 248, 0.22);
                border-color: rgba(56, 189, 248, 0.55);
                color: #fff;
            }
            .vds-pill:disabled { opacity: 0.45; cursor: not-allowed; }

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
                height: 34px;
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
                padding-top: 8px;
            }
            .vds-log-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 5px;
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
                height: 124px;
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
                <div class="vds-head-actions">
                    <button type="button" class="vds-toggle" id="vds-sound-toggle" title="切换声音提示开关">音效开</button>
                    <button type="button" class="vds-toggle" id="vds-toggle">收起</button>
                </div>
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
                            <span class="vds-hint">多个用逗号分隔 · 按当前域名隔离</span>
                        </label>
                        <input type="text" id="vds-pid" class="vds-input" placeholder="例如：2159, 2160">
                    </div>

                    <div class="vds-field">
                        <label class="vds-label" for="vds-time">
                            <span>开抢时间</span>
                            <span class="vds-hint">精确到秒</span>
                        </label>
                        <input type="datetime-local" id="vds-time" step="1" class="vds-input">
                        <div class="vds-presets" id="vds-presets">
                            <button type="button" class="vds-pill" data-preset="next-hour">下一整点</button>
                            <button type="button" class="vds-pill" data-preset="+1m">+1m</button>
                            <button type="button" class="vds-pill" data-preset="+5m">+5m</button>
                            <button type="button" class="vds-pill" data-preset="stop+3m">停止=+3m</button>
                        </div>
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
                                <option value="__custom__">自定义网关...</option>
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

                    <div class="vds-field hidden" id="vds-pay-custom-wrap">
                        <label class="vds-label" for="vds-pay-custom">
                            <span>自定义付款方式</span>
                            <span class="vds-hint">填写表单 payment 字段值</span>
                        </label>
                        <input type="text" id="vds-pay-custom" class="vds-input" placeholder="例如：stripe / alipay / credit">
                    </div>

                    <div class="vds-field">
                        <label class="vds-label" for="vds-promo">
                            <span>优惠码</span>
                            <span class="vds-hint">可选，结账自动填入 promo</span>
                        </label>
                        <input type="text" id="vds-promo" class="vds-input" placeholder="留空则不使用优惠码">
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
    // DOM 引用与按域名配置回填（无 innerHTML 插值）
    // --------------------------------------------
    const $ = (id) => shadow.getElementById(id);
    const cardEl = $('vds-card');
    const dragEl = $('vds-drag');
    const soundToggleBtn = $('vds-sound-toggle');
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
    const presetButtons = Array.from(shadow.querySelectorAll('.vds-pill'));
    const paySelect = $('vds-pay');
    const payCustomWrap = $('vds-pay-custom-wrap');
    const payCustomInput = $('vds-pay-custom');
    const speedSelect = $('vds-speed');
    const promoInput = $('vds-promo');
    const alertEl = $('vds-alert');
    const startBtn = $('vds-start');
    const stopBtn = $('vds-stop');
    const logEl = $('vds-log');
    const clearBtn = $('vds-clear');
    const hostLabelEl = $('vds-host-label');

    function syncPaymentUi(paymentMethod) {
        const resolved = resolvePaymentSelection(paymentMethod);
        paySelect.value = resolved.selectValue;
        payCustomInput.value = resolved.customValue;
        payCustomWrap.classList.toggle('hidden', !resolved.isCustom);
    }

    function syncSoundUi() {
        soundToggleBtn.textContent = hostConfig.soundMuted ? '已静音' : '音效开';
        soundToggleBtn.classList.toggle('muted', hostConfig.soundMuted);
    }

    function syncCollapsedUi() {
        cardEl.classList.toggle('collapsed', hostConfig.collapsed);
        toggleBtn.textContent = hostConfig.collapsed ? '展开' : '收起';
    }

    function applySavedPanelPos() {
        if (!hostConfig.panelPos) return;
        const clamped = clampPanelPosition(
            hostConfig.panelPos,
            window.innerWidth,
            window.innerHeight,
            hostEl.offsetWidth || 364,
            hostEl.offsetHeight || 120
        );
        if (!clamped) return;
        hostEl.style.left = `${clamped.left}px`;
        hostEl.style.top = `${clamped.top}px`;
        hostEl.style.right = 'auto';
    }

    hostLabelEl.textContent = `运行日志 · ${currentHost}`;
    pidInput.value = hostConfig.targetPid;
    timeInput.value = toDateTimeLocal(hostConfig.startTime);
    stopTimeInput.value = toDateTimeLocal(hostConfig.stopTime);
    syncPaymentUi(hostConfig.paymentMethod);
    speedSelect.value = String(hostConfig.speedMs);
    promoInput.value = hostConfig.promoCode;
    syncSoundUi();
    syncCollapsedUi();
    applySavedPanelPos();

    window.addEventListener('resize', applySavedPanelPos);

    // --------------------------------------------
    // 多通道强提醒（AudioContext + GM/Web 通知 + 标题闪烁）
    // --------------------------------------------
    const soundEngine = (() => {
        let ctx = null;

        function ensureContext() {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            if (!ctx) ctx = new AudioCtx();
            if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
            }
            return ctx;
        }

        function playSequence(notes) {
            if (hostConfig.soundMuted) return false;
            const audio = ensureContext();
            if (!audio) return false;
            try {
                const start = audio.currentTime + 0.02;
                let offset = 0;
                for (const note of notes) {
                    const osc = audio.createOscillator();
                    const gain = audio.createGain();
                    osc.type = note.type || 'triangle';
                    osc.frequency.setValueAtTime(note.freq, start + offset);

                    const dur = note.dur || 0.14;
                    gain.gain.setValueAtTime(0.0001, start + offset);
                    gain.gain.exponentialRampToValueAtTime(note.vol || 0.18, start + offset + 0.015);
                    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + dur);

                    osc.connect(gain);
                    gain.connect(audio.destination);
                    osc.start(start + offset);
                    osc.stop(start + offset + dur + 0.02);
                    offset += note.step || dur + 0.04;
                }
                return true;
            } catch {
                return false;
            }
        }

        return {
            unlock: ensureContext,
            playSuccess: () =>
                playSequence([
                    { freq: 523.25, dur: 0.13, step: 0.13, vol: 0.18 },
                    { freq: 659.25, dur: 0.13, step: 0.13, vol: 0.2 },
                    { freq: 783.99, dur: 0.15, step: 0.16, vol: 0.22 },
                    { freq: 1046.5, dur: 0.32, step: 0.34, vol: 0.24 },
                ]),
            playAlert: () =>
                playSequence([
                    { freq: 440.0, dur: 0.18, step: 0.22, type: 'sawtooth', vol: 0.12 },
                    { freq: 329.63, dur: 0.28, step: 0.3, type: 'sawtooth', vol: 0.12 },
                ]),
            playPreview: () =>
                playSequence([
                    { freq: 659.25, dur: 0.08, step: 0.09, vol: 0.14 },
                    { freq: 880.0, dur: 0.12, step: 0.14, vol: 0.16 },
                ]),
        };
    })();

    const titleFlasher = (() => {
        let baseTitle = document.title;
        let timer = null;
        let autoStopTimer = null;
        let showingAlert = false;

        function stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (autoStopTimer) {
                clearTimeout(autoStopTimer);
                autoStopTimer = null;
            }
            if (showingAlert) {
                document.title = baseTitle;
                showingAlert = false;
            }
        }

        function start(prefix, maxDurationMs = 300000) {
            stop();
            baseTitle = document.title;
            showingAlert = true;
            document.title = `${prefix} ${baseTitle}`;
            timer = setInterval(() => {
                showingAlert = !showingAlert;
                document.title = showingAlert ? `${prefix} ${baseTitle}` : baseTitle;
            }, 650);
            autoStopTimer = setTimeout(stop, maxDurationMs);
        }

        window.addEventListener('focus', stop);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') stop();
        });

        return { start, stop };
    })();

    function sendDesktopNotification(title, text) {
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({
                    title,
                    text,
                    timeout: 15000,
                    silent: Boolean(hostConfig.soundMuted),
                    onclick: () => {
                        try {
                            window.focus();
                        } catch {
                            // 忽略浏览器聚焦限制
                        }
                    },
                });
                return true;
            }
        } catch {
            // 降级至标准 Web Notification
        }

        try {
            if (typeof Notification === 'function') {
                if (Notification.permission === 'granted') {
                    const n = new Notification(title, { body: text, silent: Boolean(hostConfig.soundMuted) });
                    n.onclick = () => {
                        try {
                            window.focus();
                        } catch {}
                    };
                    return true;
                }
                if (Notification.permission === 'default') {
                    Notification.requestPermission()
                        .then((perm) => {
                            if (perm === 'granted') {
                                const n = new Notification(title, {
                                    body: text,
                                    silent: Boolean(hostConfig.soundMuted),
                                });
                                n.onclick = () => {
                                    try {
                                        window.focus();
                                    } catch {}
                                };
                            }
                        })
                        .catch(() => {});
                }
            }
        } catch {
            // 忽略不支持或权限受限场景
        }
        return false;
    }

    function triggerAlert(kind, title, message) {
        sendDesktopNotification(title, message);
        if (kind === 'success') {
            soundEngine.playSuccess();
            titleFlasher.start('【锁单成功】');
        } else {
            soundEngine.playAlert();
            titleFlasher.start('【任务停止】');
        }
    }

    // --------------------------------------------
    // 面板交互（静音、折叠、拖拽、快捷时间、表单持久化）
    // --------------------------------------------
    soundToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        persistConfig({ soundMuted: !hostConfig.soundMuted });
        syncSoundUi();
        if (!hostConfig.soundMuted) {
            soundEngine.unlock();
            soundEngine.playPreview();
        }
    });

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        persistConfig({ collapsed: !hostConfig.collapsed });
        syncCollapsedUi();
        applySavedPanelPos();
    });

    let dragState = null;
    dragEl.addEventListener('pointerdown', (e) => {
        if (e.target === toggleBtn || e.target === soundToggleBtn) return;
        const rect = hostEl.getBoundingClientRect();
        dragState = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
        dragEl.setPointerCapture(e.pointerId);
    });
    dragEl.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const clamped = clampPanelPosition(
            { left: e.clientX - dragState.offsetX, top: e.clientY - dragState.offsetY },
            window.innerWidth,
            window.innerHeight,
            hostEl.offsetWidth,
            hostEl.offsetHeight
        );
        if (!clamped) return;
        hostEl.style.left = `${clamped.left}px`;
        hostEl.style.top = `${clamped.top}px`;
        hostEl.style.right = 'auto';
    });
    const finishDrag = () => {
        if (!dragState) return;
        dragState = null;
        const rect = hostEl.getBoundingClientRect();
        persistConfig({ panelPos: { left: rect.left, top: rect.top } });
    };
    dragEl.addEventListener('pointerup', finishDrag);
    dragEl.addEventListener('pointercancel', finishDrag);

    paySelect.addEventListener('change', () => {
        const isCustom = paySelect.value === CUSTOM_PAYMENT_OPTION;
        payCustomWrap.classList.toggle('hidden', !isCustom);
        if (isCustom) {
            payCustomInput.focus();
        } else {
            persistConfig({ paymentMethod: paySelect.value });
        }
    });

    const saveCurrentFormDraft = () => {
        const resolvedPayment = resolvePaymentInput(paySelect.value, payCustomInput.value);
        persistConfig({
            targetPid: pidInput.value.trim(),
            startTime: fromDateTimeLocal(timeInput.value),
            stopTime: fromDateTimeLocal(stopTimeInput.value),
            paymentMethod: resolvedPayment || hostConfig.paymentMethod,
            speedMs: parseInt(speedSelect.value, 10) || 500,
            promoCode: promoInput.value.trim(),
        });
    };

    [pidInput, timeInput, stopTimeInput, payCustomInput, speedSelect, promoInput].forEach((el) => {
        el.addEventListener('change', saveCurrentFormDraft);
    });

    // --------------------------------------------
    // 状态、日志与 Wake Lock 管理
    // --------------------------------------------
    const runCtrl = createRunController();
    let timeChecker = null;
    let preSyncTimer = null;
    let precisionTimer = null;
    let redirectTimer = null;
    let inSprintMode = false;
    let wakeLock = null;
    let serverTimeDelta = 0;

    function serverNow() {
        return Date.now() + serverTimeDelta;
    }

    presetButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            if (runCtrl.isRunning) return;
            const preset = btn.getAttribute('data-preset');
            const result = computeTimePreset(preset, {
                nowMs: serverNow(),
                startTimeStr: fromDateTimeLocal(timeInput.value),
            });
            if (!result) return;
            if (result.field === 'startTime') {
                timeInput.value = toDateTimeLocal(result.value);
            } else if (result.field === 'stopTime') {
                stopTimeInput.value = toDateTimeLocal(result.value);
            }
            saveCurrentFormDraft();
            setAlert('');
        });
    });

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

    if (initialLoad.migrated) {
        logMsg(`已将旧版全局配置自动迁移至当前域名（${currentHost}）`, 'sync');
    }

    clearBtn.addEventListener('click', () => {
        try {
            sessionStorage.removeItem(LOG_STORAGE_KEY);
        } catch {}
        logEl.textContent = '';
    });

    function clearAllTimers() {
        if (timeChecker) {
            clearInterval(timeChecker);
            timeChecker = null;
        }
        if (preSyncTimer) {
            preSyncTimer.cancel();
            preSyncTimer = null;
        }
        if (precisionTimer) {
            precisionTimer.cancel();
            precisionTimer = null;
        }
        if (redirectTimer) {
            clearTimeout(redirectTimer);
            redirectTimer = null;
        }
        inSprintMode = false;
    }

    function setControlsDisabled(disabled) {
        pidInput.disabled = disabled;
        timeInput.disabled = disabled;
        stopTimeInput.disabled = disabled;
        paySelect.disabled = disabled;
        payCustomInput.disabled = disabled;
        speedSelect.disabled = disabled;
        promoInput.disabled = disabled;
        presetButtons.forEach((btn) => {
            btn.disabled = disabled;
        });
        startBtn.style.display = disabled ? 'none' : 'block';
        stopBtn.style.display = disabled ? 'block' : 'none';
    }

    async function requestScreenWakeLock(runId) {
        if (!('wakeLock' in navigator) || !runCtrl.isActive(runId)) return null;
        const sentinel = await navigator.wakeLock.request('screen');
        if (!runCtrl.isActive(runId)) {
            if (sentinel && typeof sentinel.release === 'function') {
                sentinel.release().catch(() => {});
            }
            return null;
        }
        if (wakeLock && wakeLock !== sentinel && typeof wakeLock.release === 'function') {
            wakeLock.release().catch(() => {});
        }
        wakeLock = sentinel;
        return sentinel;
    }

    async function acquireWakeLock(runId) {
        if (!('wakeLock' in navigator)) {
            logMsg('浏览器不支持 Wake Lock，请手动保持屏幕常亮', 'warn');
            return;
        }
        try {
            const sentinel = await requestScreenWakeLock(runId);
            if (!sentinel) return;
            logMsg('防休眠锁已激活', 'ok');
            if (!window._vdsWakeLockBound) {
                window._vdsWakeLockBound = true;
                document.addEventListener('visibilitychange', async () => {
                    if (document.visibilityState === 'visible' && runCtrl.isRunning && !runCtrl.stopFlag) {
                        const currentRunId = runCtrl.activeRunId;
                        await requestScreenWakeLock(currentRunId).catch(() => null);
                    }
                });
            }
        } catch (err) {
            if (runCtrl.isActive(runId)) {
                logMsg(`防休眠申请失败：${err.message}`, 'warn');
            }
        }
    }

    function releaseWakeLock() {
        if (!wakeLock) return;
        const current = wakeLock;
        wakeLock = null;
        if (typeof current.release === 'function') {
            current.release().catch(() => {});
        }
    }

    // --------------------------------------------
    // 二段式服务器时钟校准（RTT 去极值均值）
    // --------------------------------------------
    async function syncServerTime(label = '校时', samples = 5, { runId, signal = null, abortIfPolling = false } = {}) {
        if (!runCtrl.isActive(runId) || (abortIfPolling && runCtrl.isPolling)) return null;
        setStatus('校时中', 'syncing');
        stageEl.textContent = `${label}（${samples} 次采样）`;
        logMsg(`${label}开始，采样 ${samples} 次`, 'sync');

        const pairs = [];
        for (let i = 0; i < samples; i++) {
            if (!runCtrl.isActive(runId) || (abortIfPolling && runCtrl.isPolling)) return null;
            try {
                const t0 = Date.now();
                const resp = await fetchWithTimeout(
                    '/',
                    { method: 'HEAD', credentials: 'include', cache: 'no-store' },
                    SYNC_TIMEOUT_MS,
                    signal
                );
                if (!runCtrl.isActive(runId) || (abortIfPolling && runCtrl.isPolling)) return null;
                const t1 = Date.now();
                const dateHeader = resp.headers.get('Date');
                if (dateHeader) {
                    const serverMs = new Date(dateHeader).getTime();
                    if (!Number.isNaN(serverMs)) {
                        const rtt = t1 - t0;
                        pairs.push({ delta: serverMs - (t0 + t1) / 2, rtt });
                    }
                }
                if (i < samples - 1) {
                    await abortableSleep(200, signal);
                    if (!runCtrl.isActive(runId) || (abortIfPolling && runCtrl.isPolling)) return null;
                }
            } catch (err) {
                if (!runCtrl.isActive(runId) || (abortIfPolling && runCtrl.isPolling) || err?.name === 'AbortError') {
                    return null;
                }
                // 单次采样失败（含超时）继续后续样本
            }
        }

        if (!runCtrl.isActive(runId) || (abortIfPolling && runCtrl.isPolling)) return null;

        const result = computeClockCalibration(pairs);
        if (!result) {
            serverTimeDelta = 0;
            deltaEl.textContent = '本地时钟';
            rttEl.textContent = '--';
            logMsg(`${label}采样失败，回退本地时钟`, 'warn');
            return null;
        }

        serverTimeDelta = result.avgDelta;
        const sign = result.avgDelta > 0 ? '+' : '';
        deltaEl.textContent = `${sign}${result.avgDelta}ms`;
        rttEl.textContent = `${result.avgRtt}ms`;
        logMsg(
            `${label}完成 · 偏差 ${sign}${result.avgDelta}ms · RTT ${result.avgRtt}ms (${result.totalCount}/${samples})`,
            'ok'
        );
        return result;
    }

    // --------------------------------------------
    // 任务启停与倒计时调度
    // --------------------------------------------
    function finishTask(statusText, tone = 'idle') {
        clearAllTimers();
        runCtrl.stopRun();
        releaseWakeLock();
        setControlsDisabled(false);
        countdownBox.classList.remove('sprint');
        setStatus(statusText, tone);
    }

    stopBtn.addEventListener('click', () => {
        titleFlasher.stop();
        finishTask('已中止', 'error');
        stageEl.textContent = '任务已手动停止';
        countdownEl.textContent = '--:--:--.-';
        logMsg('用户手动中止任务', 'err');
    });

    startBtn.addEventListener('click', async () => {
        setAlert('');
        titleFlasher.stop();

        // 在用户点击手势内解锁 AudioContext 与 Web Notification 权限，避免后续被浏览器拦截
        soundEngine.unlock();
        if (typeof GM_notification !== 'function' && typeof Notification === 'function' && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }

        const targetPid = pidInput.value.trim();
        const pidList = parsePidList(targetPid);
        const startTime = fromDateTimeLocal(timeInput.value);
        const stopTime = fromDateTimeLocal(stopTimeInput.value);
        const paymentMethod = resolvePaymentInput(paySelect.value, payCustomInput.value);
        const speedMs = parseInt(speedSelect.value, 10) || 500;
        const promoCode = promoInput.value.trim();

        const targetMs = parseLocalDateTime(startTime);
        const stopMs = stopTime ? parseLocalDateTime(stopTime) : 0;

        if (pidList.length === 0) {
            setAlert('请先填写至少一个目标商品 PID');
            pidInput.focus();
            return;
        }
        if (!startTime || Number.isNaN(targetMs)) {
            setAlert('请选择有效的开抢时间');
            timeInput.focus();
            return;
        }
        if (stopTime && (Number.isNaN(stopMs) || stopMs <= targetMs)) {
            setAlert('自动停止时间必须晚于开抢时间');
            stopTimeInput.focus();
            return;
        }
        if (!paymentMethod) {
            setAlert('请输入自定义付款方式代码');
            payCustomInput.focus();
            return;
        }

        persistConfig({
            targetPid,
            startTime,
            stopTime,
            paymentMethod,
            speedMs,
            promoCode,
        });

        clearAllTimers();
        const { runId, signal } = runCtrl.startRun();
        setControlsDisabled(true);

        acquireWakeLock(runId);
        if (stopMs > 0) logMsg(`已设自动停止：${stopTime}`, 'info');
        if (promoCode) logMsg(`结账将自动附带优惠码：${promoCode}`, 'info');

        await syncServerTime('启动初校', 3, { runId, signal });
        if (!runCtrl.isActive(runId)) return;

        let lastLogAt = 0;

        const enterSprintInterval = (tickFn) => {
            if (!runCtrl.isActive(runId) || runCtrl.isPolling || inSprintMode) return;
            inSprintMode = true;
            if (timeChecker) clearInterval(timeChecker);
            timeChecker = setInterval(() => tickFn(true), 50);
            tickFn(true);
        };

        const tick = (sprint) => {
            if (!runCtrl.isActive(runId) || runCtrl.isPolling) return;
            const now = serverNow();
            if (now >= targetMs) {
                countdownEl.textContent = '00:00:00.0';
                startPolling(runId);
                return;
            }
            const remainMs = targetMs - now;
            countdownEl.textContent = formatCountdown(remainMs);
            if (sprint) {
                countdownBox.classList.add('sprint');
                stageEl.textContent = '最后 5 秒 · 50ms 高精度触发';
            } else if (remainMs <= SPRINT_LEAD_MS) {
                enterSprintInterval(tick);
                return;
            }
            const remainSec = Math.floor(remainMs / 1000);
            const interval = remainSec > 300 ? 60000 : remainSec > 60 ? 30000 : 15000;
            if (!sprint && now - lastLogAt >= interval) {
                lastLogAt = now;
                logMsg(
                    `倒计时 ${formatCountdown(remainMs)}（偏差 ${serverTimeDelta >= 0 ? '+' : ''}${serverTimeDelta}ms）`,
                    'sync'
                );
            }
        };

        const schedulePrecisionSprint = (reason) => {
            if (!runCtrl.isActive(runId) || runCtrl.isPolling) return null;
            if (precisionTimer) {
                precisionTimer.cancel();
                precisionTimer = null;
            }
            const plan = computeSchedulePlan({
                targetMs,
                nowMs: Date.now(),
                serverTimeDelta,
            });

            if (plan.shouldStartPolling) {
                countdownEl.textContent = '00:00:00.0';
                startPolling(runId);
                return plan;
            }

            if (plan.shouldSprintImmediately) {
                enterSprintInterval(tick);
                return plan;
            }

            precisionTimer = scheduleLongTimeout(() => {
                enterSprintInterval(tick);
            }, plan.sprintDelayMs);

            if (reason === 'recalibrated') {
                const sign = serverTimeDelta > 0 ? '+' : '';
                logMsg(
                    `已按最新时钟偏差（${sign}${serverTimeDelta}ms）重算冲刺定时（${Math.round(plan.sprintDelayMs)}ms 后切换 50ms）`,
                    'sync'
                );
            }
            return plan;
        };

        const initialPlan = schedulePrecisionSprint('initial');
        if (!runCtrl.isActive(runId) || runCtrl.isPolling || !initialPlan || initialPlan.shouldStartPolling) return;

        setStatus('定时待命', 'armed');
        if (initialPlan.shouldPreSync && initialPlan.preSyncDelayMs !== null) {
            stageEl.textContent = '开抢前 60 秒自动精校';
            logMsg('已预约开抢前 60 秒二次精校', 'info');
            preSyncTimer = scheduleLongTimeout(async () => {
                if (!runCtrl.isActive(runId) || runCtrl.isPolling) return;
                await syncServerTime('开抢前精校', 5, { runId, signal, abortIfPolling: true });
                if (!runCtrl.isActive(runId) || runCtrl.isPolling) return;
                const recalibratedPlan = schedulePrecisionSprint('recalibrated');
                if (
                    runCtrl.isActive(runId) &&
                    !runCtrl.isPolling &&
                    recalibratedPlan &&
                    !recalibratedPlan.shouldStartPolling
                ) {
                    setStatus('即将开抢', 'armed');
                    if (!recalibratedPlan.shouldSprintImmediately) {
                        stageEl.textContent = '二次精校已完成 · 定时已重算';
                    }
                }
            }, initialPlan.preSyncDelayMs);
        } else if (!initialPlan.shouldSprintImmediately) {
            stageEl.textContent = '倒计时同步运行中';
        }

        if (!inSprintMode && runCtrl.isActive(runId) && !runCtrl.isPolling) {
            tick(false);
            if (runCtrl.isActive(runId) && !runCtrl.isPolling && !inSprintMode) {
                timeChecker = setInterval(() => tick(false), 200);
            }
        }
    });

    function startPolling(runId) {
        if (!runCtrl.tryEnterPolling(runId)) return;
        clearAllTimers();
        setStatus('抢购运行中', 'running');
        stageEl.textContent = '多 PID 轮询与结账中';
        countdownBox.classList.remove('sprint');
        logMsg('到达目标时间，开始轮询商品库存', 'ok');
        loopConfigAndBuy(runId, runCtrl.signal);
    }

    // --------------------------------------------
    // 抢单核心流程
    // --------------------------------------------
    async function loopConfigAndBuy(runId, signal) {
        let attempt = 1;
        const pidList = parsePidList(hostConfig.targetPid);
        const stopMs = hostConfig.stopTime ? parseLocalDateTime(hostConfig.stopTime) : 0;

        try {
            while (runCtrl.isActive(runId)) {
                if (stopMs > 0 && serverNow() >= stopMs) {
                    if (!runCtrl.isActive(runId)) return;
                    const msg = `已达停止时间 ${hostConfig.stopTime}，自动结束`;
                    logMsg(msg, 'warn');
                    stageEl.textContent = '已超时自动停止';
                    finishTask('已超时停止', 'idle');
                    triggerAlert('warn', `VPS Drop Sync · ${currentHost}`, msg);
                    return;
                }

                try {
                    let grabbed = false;

                    for (const currentPid of pidList) {
                        if (!runCtrl.isActive(runId)) return;

                        const t0 = Date.now();
                        await fetchWithTimeout(
                            '/cart?action=emptycart',
                            { method: 'GET', credentials: 'include' },
                            REQUEST_TIMEOUT_MS,
                            signal
                        ).catch(() => {});
                        if (!runCtrl.isActive(runId)) return;

                        const configUrl = `/cart?action=configureproduct&pid=${encodeURIComponent(currentPid)}`;
                        logMsg(`[#${attempt}] 探测 PID ${currentPid}`, 'sync');

                        const resp = await fetchWithTimeout(
                            `${configUrl}&nocache=${Date.now()}`,
                            {
                                redirect: 'follow',
                                credentials: 'include',
                            },
                            REQUEST_TIMEOUT_MS,
                            signal
                        );
                        if (!runCtrl.isActive(runId)) return;

                        const html = await readTextWithTimeout(resp, REQUEST_TIMEOUT_MS, signal);
                        if (!runCtrl.isActive(runId)) return;
                        const t1 = Date.now();

                        if (isLoginRedirect(resp.url, html)) {
                            const msg = '检测到站点跳转登录页，登录状态已失效，任务自动停止';
                            logMsg(msg, 'err');
                            stageEl.textContent = '登录状态失效';
                            finishTask('异常停止', 'error');
                            triggerAlert('error', `VPS Drop Sync · 登录失效 (${currentHost})`, msg);
                            return;
                        }

                        if (!resp.ok) {
                            logMsg(`PID ${currentPid} 探测返回异常状态 (${resp.status} · ${t1 - t0}ms)，跳过`, 'warn');
                            continue;
                        }

                        if (isOutOfStockHtml(html)) {
                            logMsg(`PID ${currentPid} 暂无库存 (${resp.status} · ${t1 - t0}ms)`, 'warn');
                            continue;
                        }

                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const form = findConfigureProductForm(doc);
                        if (!form) {
                            logMsg(`PID ${currentPid} 页面未检测到配置表单，跳过`, 'warn');
                            continue;
                        }

                        const fields = extractFormFields(form, currentPid, {
                            nowMs: Date.now(),
                            fallbackPassword: generateFallbackPassword,
                        });
                        if (!fields) {
                            logMsg(`PID ${currentPid} 配置表单解析失败，跳过`, 'warn');
                            continue;
                        }

                        const fieldCount = Object.values(fields).reduce(
                            (count, val) => count + (Array.isArray(val) ? val.length : 1),
                            0
                        );
                        logMsg(`PID ${currentPid} 有货，提交加购 (${fieldCount} 字段)`, 'ok');
                        const formData = buildFormUrlSearchParams(fields);

                        const req1 = await fetchWithTimeout(
                            configUrl,
                            {
                                method: 'POST',
                                body: formData,
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                                redirect: 'follow',
                                credentials: 'include',
                            },
                            REQUEST_TIMEOUT_MS,
                            signal
                        );
                        if (!runCtrl.isActive(runId)) return;
                        const t2 = Date.now();
                        if (isLoginRedirect(req1.url)) {
                            const msg = '加购阶段跳转登录页，登录状态已失效，任务自动停止';
                            logMsg(msg, 'err');
                            stageEl.textContent = '登录状态失效';
                            finishTask('异常停止', 'error');
                            triggerAlert('error', `VPS Drop Sync · 登录失效 (${currentHost})`, msg);
                            return;
                        }
                        if (!req1.ok) throw new Error(`加购请求异常 ${req1.status}`);
                        logMsg(`加购成功 (${req1.status} · ${t2 - t1}ms)，发起结账`, 'ok');

                        const checkoutData = buildCheckoutPayload({
                            paymentMethod: hostConfig.paymentMethod,
                            promoCode: hostConfig.promoCode,
                        });

                        const req2 = await fetchWithTimeout(
                            '/cart?action=viewcart&statuscart=checkout',
                            {
                                method: 'POST',
                                body: checkoutData,
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                                redirect: 'follow',
                                credentials: 'include',
                            },
                            REQUEST_TIMEOUT_MS,
                            signal
                        );
                        if (!runCtrl.isActive(runId)) return;
                        const t3 = Date.now();
                        if (isLoginRedirect(req2.url)) {
                            const msg = '结账阶段跳转登录页，登录状态已失效，任务自动停止';
                            logMsg(msg, 'err');
                            stageEl.textContent = '登录状态失效';
                            finishTask('异常停止', 'error');
                            triggerAlert('error', `VPS Drop Sync · 登录失效 (${currentHost})`, msg);
                            return;
                        }
                        if (!req2.ok) throw new Error(`结账请求异常 ${req2.status}`);

                        const body2 = await readTextWithTimeout(req2, REQUEST_TIMEOUT_MS, signal).catch(() => '');
                        if (!runCtrl.isActive(runId)) return;

                        const checkoutOutcome = classifyCheckoutResponse(req2.url, body2);
                        if (checkoutOutcome === 'login') {
                            const msg = '结账阶段跳转登录页，登录状态已失效，任务自动停止';
                            logMsg(msg, 'err');
                            stageEl.textContent = '登录状态失效';
                            finishTask('异常停止', 'error');
                            triggerAlert('error', `VPS Drop Sync · 登录失效 (${currentHost})`, msg);
                            return;
                        }

                        if (checkoutOutcome !== 'invoice') {
                            const doc2 = new DOMParser().parseFromString(body2, 'text/html');
                            const errEl = doc2.querySelector('.errorbox, .alert-danger, #statusmessage, .alert');
                            const reason = errEl ? errEl.textContent.trim().slice(0, 100) : '未返回账单页';
                            logMsg(`PID ${currentPid} 结账被拒：${reason}`, 'warn');
                            continue;
                        }

                        const totalCost = t3 - t0;
                        const redirectDelayMs = hostConfig.soundMuted ? 300 : 1200;
                        logMsg(`PID ${currentPid} 锁单成功（总耗时 ${totalCost}ms），即将跳转账单页`, 'ok');
                        stageEl.textContent = `PID ${currentPid} 已生成账单`;
                        finishTask('已锁单', 'running');
                        triggerAlert(
                            'success',
                            `VPS Drop Sync · 锁单成功 (${currentHost})`,
                            `PID ${currentPid} 已生成账单（总耗时 ${totalCost}ms），请尽快完成支付！`
                        );
                        redirectTimer = setTimeout(() => {
                            window.location.href = req2.url;
                        }, redirectDelayMs);
                        grabbed = true;
                        return;
                    }

                    if (!grabbed && runCtrl.isActive(runId)) {
                        logMsg(`第 ${attempt} 轮未命中，${hostConfig.speedMs}ms 后重试`, 'info');
                    }
                } catch (err) {
                    if (!runCtrl.isActive(runId) || err?.name === 'AbortError') return;
                    logMsg(`请求异常：${err.message}，${hostConfig.speedMs}ms 后重试`, 'err');
                }

                if (!runCtrl.isActive(runId)) return;
                await abortableSleep(hostConfig.speedMs, signal);
                if (!runCtrl.isActive(runId)) return;
                attempt++;
            }
        } catch (fatalErr) {
            if (!runCtrl.isActive(runId) || fatalErr?.name === 'AbortError') return;
            const msg = `抢购任务因未预期异常中断：${fatalErr?.message || fatalErr}`;
            logMsg(msg, 'err');
            stageEl.textContent = '异常停止';
            finishTask('异常停止', 'error');
            triggerAlert('error', `VPS Drop Sync · 异常停止 (${currentHost})`, msg);
        }
    }
})();
