'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('../vps-drop-sync.user.js');

function createMemoryStore(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get(key, defaultVal) {
            return map.has(key) ? map.get(key) : defaultVal;
        },
        set(key, val) {
            map.set(key, val);
        },
        raw: map,
    };
}

function createMockForm({ inputs = [], selects = [], textareas = [] } = {}) {
    const selectNodes = selects.map((sel) => ({
        name: sel.name,
        disabled: Boolean(sel.disabled),
        value: sel.value ?? '',
        querySelector(selector) {
            const options = sel.options || [];
            if (selector === 'option[selected]') {
                return options.find((opt) => opt.selected) || null;
            }
            if (selector === 'option') {
                return options[0] || null;
            }
            return null;
        },
    }));

    return {
        querySelectorAll(selector) {
            if (selector === 'input') return inputs;
            if (selector === 'select') return selectNodes;
            if (selector === 'textarea') return textareas;
            return [];
        },
    };
}

test('metadata matches V4.3.0 and declares GM_notification grant', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'vps-drop-sync.user.js'), 'utf8');
    assert.equal(core.VERSION, '4.3.0');
    assert.match(src, /@version\s+4\.3\.0/);
    assert.match(src, /@grant\s+GM_notification/);
});

test('time parsing, formatting, and datetime-local conversion', () => {
    const ts = core.parseLocalDateTime('2026-11-22 14:30:45');
    assert.equal(Number.isNaN(ts), false);
    assert.equal(core.formatLocalDateTime(ts), '2026-11-22 14:30:45');

    assert.equal(core.parseLocalDateTime('2026-11-22T14:30'), core.parseLocalDateTime('2026-11-22 14:30:00'));
    assert.equal(Number.isNaN(core.parseLocalDateTime('2026-02-31 12:00:00')), true);
    assert.equal(Number.isNaN(core.parseLocalDateTime('not-a-date')), true);
    assert.equal(Number.isNaN(core.parseLocalDateTime('')), true);

    assert.equal(core.toDateTimeLocal('2026-11-22 14:30:45'), '2026-11-22T14:30:45');
    assert.equal(core.fromDateTimeLocal('2026-11-22T14:30'), '2026-11-22 14:30:00');
    assert.equal(core.fromDateTimeLocal('2026-11-22T14:30:59'), '2026-11-22 14:30:59');

    assert.equal(core.formatCountdown(3661950), '01:01:01.9');
    assert.equal(core.formatCountdown(-500), '00:00:00.0');
});

test('quick time presets calculate next-hour, +1m, +5m, and stop+3m accurately', () => {
    const midHour = core.parseLocalDateTime('2026-11-22 13:25:42');
    assert.deepEqual(core.computeTimePreset('next-hour', { nowMs: midHour }), {
        field: 'startTime',
        value: '2026-11-22 14:00:00',
    });

    const exactHour = core.parseLocalDateTime('2026-11-22 14:00:00');
    assert.deepEqual(core.computeTimePreset('next-hour', { nowMs: exactHour }), {
        field: 'startTime',
        value: '2026-11-22 15:00:00',
    });

    assert.deepEqual(core.computeTimePreset('+1m', { nowMs: midHour }), {
        field: 'startTime',
        value: '2026-11-22 13:26:42',
    });

    assert.deepEqual(core.computeTimePreset('+5m', { nowMs: midHour }), {
        field: 'startTime',
        value: '2026-11-22 13:30:42',
    });

    assert.deepEqual(
        core.computeTimePreset('stop+3m', { nowMs: midHour, startTimeStr: '2026-11-22 14:00:00' }),
        {
            field: 'stopTime',
            value: '2026-11-22 14:03:00',
        }
    );

    assert.deepEqual(core.computeTimePreset('stop+3m', { nowMs: midHour, startTimeStr: '' }), {
        field: 'stopTime',
        value: '2026-11-22 13:28:42',
    });
});

test('per-host storage isolates hosts and auto-migrates legacy global GM keys on first read', () => {
    const store = createMemoryStore({
        targetPid: '2159,2160',
        startTime: '2026-11-22 20:00:00',
        stopTime: '2026-11-22 20:05:00',
        paymentMethod: 'paypal',
        speedMs: '100',
    });

    const firstReadA = core.loadHostConfig('panel-a.example.com', store);
    assert.equal(firstReadA.migrated, true);
    assert.equal(firstReadA.config.targetPid, '2159,2160');
    assert.equal(firstReadA.config.paymentMethod, 'paypal');
    assert.equal(firstReadA.config.speedMs, 100);
    assert.equal(firstReadA.config.promoCode, '');
    assert.equal(firstReadA.config.collapsed, false);
    assert.equal(firstReadA.config.panelPos, null);

    // Subsequent read uses per-host record directly without re-migrating
    const secondReadA = core.loadHostConfig('PANEL-A.example.com', store);
    assert.equal(secondReadA.migrated, false);
    assert.equal(secondReadA.config.targetPid, '2159,2160');

    // Modify Host A with promoCode, custom payment, panel position, collapse, mute
    core.saveHostConfig(
        'panel-a.example.com',
        {
            targetPid: '3001',
            promoCode: 'DROP20',
            paymentMethod: 'stripe_checkout',
            collapsed: true,
            soundMuted: true,
            panelPos: { left: 120.4, top: 88.6 },
        },
        store
    );

    // Host B starts independently (migrating legacy once, unaffected by Host A edits)
    const firstReadB = core.loadHostConfig('panel-b.example.com', store);
    assert.equal(firstReadB.migrated, true);
    assert.equal(firstReadB.config.targetPid, '2159,2160');
    assert.equal(firstReadB.config.promoCode, '');
    assert.equal(firstReadB.config.collapsed, false);

    // Verify Host A edits remained isolated
    const verifyA = core.loadHostConfig('panel-a.example.com', store);
    assert.equal(verifyA.config.targetPid, '3001');
    assert.equal(verifyA.config.promoCode, 'DROP20');
    assert.equal(verifyA.config.paymentMethod, 'stripe_checkout');
    assert.equal(verifyA.config.collapsed, true);
    assert.equal(verifyA.config.soundMuted, true);
    assert.deepEqual(verifyA.config.panelPos, { left: 120, top: 89 });
});

test('fresh store without legacy keys initializes defaults cleanly and resolves custom payment', () => {
    const store = createMemoryStore();
    const res = core.loadHostConfig('fresh.example.com', store);
    assert.equal(res.migrated, false);
    assert.equal(res.config.speedMs, 500);
    assert.equal(res.config.paymentMethod, 'AliPayH5');

    assert.deepEqual(core.resolvePaymentSelection('wechatpay'), {
        selectValue: 'wechatpay',
        customValue: '',
        isCustom: false,
    });
    assert.deepEqual(core.resolvePaymentSelection('credit_balance'), {
        selectValue: '__custom__',
        customValue: 'credit_balance',
        isCustom: true,
    });
    assert.equal(core.resolvePaymentInput('__custom__', '  usdt_trc20  '), 'usdt_trc20');
    assert.equal(core.resolvePaymentInput('__custom__', '   '), '');

    assert.deepEqual(core.clampPanelPosition({ left: -40, top: 2000 }, 1280, 720, 364, 500), {
        left: 8,
        top: 212,
    });
});

test('RTT trimmed mean calibration and T-60s sprint timer recalculation', () => {
    const cal = core.computeClockCalibration([
        { delta: 50, rtt: 10 }, // fastest RTT outlier dropped
        { delta: 120, rtt: 40 },
        { delta: 140, rtt: 50 },
        { delta: 130, rtt: 45 },
        { delta: 900, rtt: 500 }, // slowest RTT outlier dropped
    ]);
    assert.deepEqual(cal, { avgDelta: 130, avgRtt: 45, usedCount: 3, totalCount: 5 });

    const targetMs = 1_700_000_120_000;
    // Initial calibration at T-120s with delta = 0
    const initialPlan = core.computeSchedulePlan({
        targetMs,
        nowMs: targetMs - 120_000,
        serverTimeDelta: 0,
    });
    assert.equal(initialPlan.shouldStartPolling, false);
    assert.equal(initialPlan.shouldPreSync, true);
    assert.equal(initialPlan.preSyncDelayMs, 60_000);
    assert.equal(initialPlan.sprintDelayMs, 114_800);

    // At T-60s secondary calibration discovers server is +2500ms ahead of local clock
    const nowAtT60 = targetMs - 60_000;
    const beforeRecal = core.computeSchedulePlan({
        targetMs,
        nowMs: nowAtT60,
        serverTimeDelta: 0,
    });
    const afterRecalAhead = core.computeSchedulePlan({
        targetMs,
        nowMs: nowAtT60,
        serverTimeDelta: 2500,
    });
    assert.equal(beforeRecal.sprintDelayMs - afterRecalAhead.sprintDelayMs, 2500);
    assert.equal(afterRecalAhead.sprintDelayMs, 52_300);

    // If server is -1800ms behind local clock, sprintDelayMs stretches by 1800ms
    const afterRecalBehind = core.computeSchedulePlan({
        targetMs,
        nowMs: nowAtT60,
        serverTimeDelta: -1800,
    });
    assert.equal(afterRecalBehind.sprintDelayMs - beforeRecal.sprintDelayMs, 1800);

    // If updated delta puts remaining time within 5.2s sprint window, enter sprint immediately
    const immediateSprint = core.computeSchedulePlan({
        targetMs,
        nowMs: targetMs - 6000,
        serverTimeDelta: 1200,
    });
    assert.equal(immediateSprint.shouldSprintImmediately, true);
    assert.equal(immediateSprint.sprintDelayMs, 0);

    // If updated delta puts serverNow >= targetMs, trigger polling immediately
    const immediatePoll = core.computeSchedulePlan({
        targetMs,
        nowMs: targetMs - 500,
        serverTimeDelta: 800,
    });
    assert.equal(immediatePoll.shouldStartPolling, true);
});

test('form extraction, PID parsing, stock/login/invoice detection, and checkout payload', () => {
    assert.deepEqual(core.parsePidList(' 2159, 2160，2159 | 2168  2170 '), ['2159', '2160', '2168', '2170']);

    const mockForm = createMockForm({
        inputs: [
            { name: 'token', type: 'hidden', value: 'csrf_abc' },
            { name: 'billingcycle', type: 'radio', value: 'monthly', checked: false },
            { name: 'billingcycle', type: 'radio', value: 'annually', checked: true },
            { name: 'addon[1]', type: 'checkbox', value: 'yes', checked: true },
            { name: 'addon[2]', type: 'checkbox', value: 'yes', checked: false },
            { name: 'ignored_disabled', type: 'text', value: 'x', disabled: true },
            { name: 'host', type: 'text', value: '' },
            { name: 'password', type: 'password', value: '' },
            { name: '', type: 'text', value: 'unnamed' },
        ],
        selects: [
            {
                name: 'configoption[10]',
                options: [
                    { value: '101', selected: false },
                    { value: '102', selected: true },
                ],
            },
            {
                name: 'configoption[11]',
                options: [
                    { value: '201', selected: false },
                    { value: '202', selected: false },
                ],
            },
        ],
        textareas: [{ name: 'sshkey', value: 'ssh-ed25519 AAAA' }],
    });

    const fields = core.extractFormFields(mockForm, '2159', {
        nowMs: 1700000000000,
        fallbackPassword: () => 'StrongPass!99',
    });

    assert.deepEqual(fields, {
        token: 'csrf_abc',
        billingcycle: 'annually',
        'addon[1]': 'yes',
        host: 'vps-1700000000000',
        password: 'StrongPass!99',
        'configoption[10]': '102',
        'configoption[11]': '201',
        sshkey: 'ssh-ed25519 AAAA',
        pid: '2159',
        qty: '1',
    });

    const checkout = core.buildCheckoutPayload({ paymentMethod: 'stripe_card', promoCode: ' SAVE20 ' });
    assert.equal(checkout.get('payment'), 'stripe_card');
    assert.equal(checkout.get('promo'), 'SAVE20');
    assert.equal(checkout.get('terms'), '1');

    assert.equal(core.isOutOfStockHtml('<div>当前套餐已缺货</div>'), true);
    assert.equal(core.isOutOfStockHtml('<div>Sorry, Out of Stock</div>'), true);
    assert.equal(core.isOutOfStockHtml('<form id="frmConfigureProduct"></form>'), false);

    assert.equal(core.isInvoiceUrl('https://panel.example.com/viewinvoice.php?id=8891'), true);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/cart?action=viewcart'), false);

    assert.equal(core.isLoginRedirect('https://panel.example.com/login.php?goto=/cart?action=configureproduct'), true);
    assert.equal(
        core.isLoginRedirect(
            'https://panel.example.com/cart?action=configureproduct&pid=2159',
            '<form id="frmConfigureProduct"><input name="username"><input type="password"></form>'
        ),
        false
    );
    assert.equal(
        core.isLoginRedirect(
            'https://panel.example.com/clientarea.php',
            '<form><input name="username"><input type="password"></form>'
        ),
        true
    );
});

test('edge cases: corrupted JSON fallback, prefilled host/password, invalid speedMs, small calibration samples', () => {
    const store = createMemoryStore({
        [core.getHostConfigKey('broken.example.com')]: '{not-valid-json',
        targetPid: '9001',
        speedMs: '999',
    });
    const recovered = core.loadHostConfig('broken.example.com', store);
    assert.equal(recovered.migrated, true);
    assert.equal(recovered.config.targetPid, '9001');
    assert.equal(recovered.config.speedMs, 500);

    const prefilledForm = createMockForm({
        inputs: [
            { name: 'host', type: 'text', value: 'my-custom-node' },
            { name: 'password', type: 'password', value: 'ExistingSecret123' },
        ],
    });
    const fields = core.extractFormFields(prefilledForm, '9001', {
        nowMs: 1700000000000,
        fallbackPassword: () => 'ShouldNotBeUsed',
    });
    assert.equal(fields.host, 'my-custom-node');
    assert.equal(fields.password, 'ExistingSecret123');

    assert.equal(core.computeClockCalibration([]), null);
    assert.deepEqual(
        core.computeClockCalibration([
            { delta: 100, rtt: 30 },
            { delta: 200, rtt: 50 },
        ]),
        { avgDelta: 150, avgRtt: 40, usedCount: 2, totalCount: 2 }
    );
    assert.equal(core.computeTimePreset('unknown-preset', { nowMs: Date.now() }), null);
});

test('P1-1 & P1-2: createRunController isolates runId generations, aborts previous runs, and guards startPolling re-entry', () => {
    const ctrl = core.createRunController();
    assert.equal(ctrl.activeRunId, 0);
    assert.equal(ctrl.isRunning, false);
    assert.equal(ctrl.isPolling, false);

    const run1 = ctrl.startRun();
    assert.equal(run1.runId, 1);
    assert.equal(run1.signal.aborted, false);
    assert.equal(ctrl.isActive(1), true);
    assert.equal(ctrl.isActive(0), false);

    // Polling re-entry guard allows entry once per runId
    assert.equal(ctrl.tryEnterPolling(1), true);
    assert.equal(ctrl.isPolling, true);
    assert.equal(ctrl.tryEnterPolling(1), false);
    assert.equal(ctrl.tryEnterPolling(999), false);

    // Stopping increments activeRunId, aborts signal, clears polling state
    const stopGen = ctrl.stopRun();
    assert.equal(stopGen, 2);
    assert.equal(run1.signal.aborted, true);
    assert.equal(ctrl.isActive(1), false);
    assert.equal(ctrl.isActive(2), false);
    assert.equal(ctrl.isPolling, false);
    assert.equal(ctrl.tryEnterPolling(1), false);

    // Quick restart allocates a new runId and a fresh AbortController
    const run2 = ctrl.startRun();
    assert.equal(run2.runId, 3);
    assert.equal(run2.signal.aborted, false);
    assert.equal(ctrl.isActive(1), false);
    assert.equal(ctrl.isActive(3), true);
    assert.equal(ctrl.tryEnterPolling(3), true);
    assert.equal(ctrl.tryEnterPolling(3), false);

    // Starting a new run directly without stop also aborts previous run
    const run3 = ctrl.startRun();
    assert.equal(run3.runId, 4);
    assert.equal(run2.signal.aborted, true);
    assert.equal(ctrl.isActive(3), false);
    assert.equal(ctrl.isActive(4), true);
});

test('P1-2: fetchWithTimeout, readTextWithTimeout, and abortableSleep enforce timeouts and external AbortSignal', async () => {
    // 1. Timeout aborts hanging fetch
    await assert.rejects(
        core.fetchWithTimeout(
            '/hang',
            {},
            25,
            null,
            (_url, opts) =>
                new Promise((_resolve, reject) => {
                    opts.signal.addEventListener('abort', () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                })
        ),
        (err) => err.name === 'TimeoutError' && /25ms/.test(err.message)
    );

    // 2. External signal aborts in-flight fetch
    const external = new AbortController();
    const pending = core.fetchWithTimeout(
        '/cancel-me',
        {},
        5000,
        external.signal,
        (_url, opts) =>
            new Promise((_resolve, reject) => {
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            })
    );
    external.abort();
    await assert.rejects(pending, (err) => err.name === 'AbortError');

    // 3. Pre-aborted external signal rejects without calling fetchImpl
    let called = false;
    await assert.rejects(
        core.fetchWithTimeout('/skip', {}, 1000, external.signal, () => {
            called = true;
            return Promise.resolve({});
        }),
        (err) => err.name === 'AbortError'
    );
    assert.equal(called, false);

    // 4. Normal fetch succeeds and cleans up listeners
    const okResp = await core.fetchWithTimeout('/ok', { method: 'HEAD' }, 1000, null, async () => ({
        ok: true,
        status: 200,
        text: async () => 'hello',
    }));
    assert.equal(await core.readTextWithTimeout(okResp, 1000), 'hello');

    // 5. readTextWithTimeout rejects and cancels body stream when body hangs or aborts
    let bodyCancelledOnTimeout = 0;
    await assert.rejects(
        core.readTextWithTimeout(
            {
                body: { cancel: () => { bodyCancelledOnTimeout++; } },
                text: () => new Promise(() => {}),
            },
            25
        ),
        (err) => err.name === 'TimeoutError'
    );
    assert.equal(bodyCancelledOnTimeout, 1);

    let bodyCancelledOnAbort = 0;
    const bodyAc = new AbortController();
    const pendingBody = core.readTextWithTimeout(
        {
            body: { cancel: () => { bodyCancelledOnAbort++; } },
            text: () => new Promise(() => {}),
        },
        5000,
        bodyAc.signal
    );
    bodyAc.abort();
    await assert.rejects(pendingBody, (err) => err.name === 'AbortError');
    assert.equal(bodyCancelledOnAbort, 1);

    // 6. abortableSleep resolves false immediately on abort, true on completion
    const sleepAc = new AbortController();
    const abortedSleep = core.abortableSleep(5000, sleepAc.signal);
    sleepAc.abort();
    assert.equal(await abortedSleep, false);
    assert.equal(await core.abortableSleep(5, null), true);
});

test('P1-3: isInvoiceUrl checks pathname only and classifyCheckoutResponse prioritizes isLoginRedirect', () => {
    // True positives on pathname
    assert.equal(core.isInvoiceUrl('https://panel.example.com/viewinvoice.php?id=8891'), true);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/viewbilling?id=123'), true);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/invoice/8891'), true);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/client/invoices/456'), true);
    assert.equal(core.isInvoiceUrl('/viewinvoice.php?id=1'), true);

    // False positives that MUST be rejected (hostname / query / hash / non-http)
    assert.equal(core.isInvoiceUrl('https://invoice.provider.com/cart.php?a=checkout'), false);
    assert.equal(core.isInvoiceUrl('https://invoice.provider.com/'), false);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/login.php?goto=/viewinvoice.php?id=88'), false);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/cart?action=viewcart&next=invoice'), false);
    assert.equal(core.isInvoiceUrl('https://panel.example.com/cart#viewinvoice'), false);
    assert.equal(core.isInvoiceUrl('javascript:alert("/viewinvoice")'), false);
    assert.equal(core.isInvoiceUrl(''), false);

    // Ordering: login redirect ALWAYS beats invoice URL
    assert.equal(
        core.classifyCheckoutResponse(
            'https://panel.example.com/login.php?goto=/viewinvoice.php?id=10',
            '<html></html>'
        ),
        'login'
    );
    assert.equal(
        core.classifyCheckoutResponse(
            'https://panel.example.com/viewinvoice.php?id=10',
            '<form action="/dologin.php"><input name="username"><input type="password"></form>'
        ),
        'login'
    );
    assert.equal(
        core.classifyCheckoutResponse(
            'https://panel.example.com/viewinvoice.php?id=10',
            '<div class="invoice-container"><h1>Invoice #10</h1></div>'
        ),
        'invoice'
    );
    assert.equal(
        core.classifyCheckoutResponse(
            'https://invoice.provider.com/cart.php?a=viewcart',
            '<div class="alert-danger">Out of stock</div>'
        ),
        'rejected'
    );
});

test('P2: findConfigureProductForm ignores search/login forms and extractFormFields supports multi-value, button filtering, and disabled options', () => {
    const searchForm = {
        id: 'header-search',
        className: 'navbar-search',
        action: '/search.php',
        method: 'get',
        getAttribute: () => null,
        querySelectorAll: () => [{ name: 'q', type: 'search' }],
    };
    const loginForm = {
        id: 'frmLogin',
        className: 'login-form',
        action: '/login.php',
        method: 'post',
        getAttribute: () => null,
        querySelectorAll: () => [{ name: 'username' }, { name: 'password' }],
    };
    const configForm = {
        id: 'custom-product-form',
        className: 'product-form',
        action: '/cart.php?action=configureproduct&pid=2159',
        method: 'post',
        getAttribute: () => null,
        querySelectorAll: () => [{ name: 'billingcycle' }],
    };

    assert.equal(
        core.findConfigureProductForm({
            getElementById: () => null,
            querySelectorAll: (sel) => (sel === 'form' ? [searchForm, loginForm] : []),
        }),
        null
    );
    assert.equal(
        core.findConfigureProductForm({
            getElementById: () => null,
            querySelectorAll: (sel) => (sel === 'form' ? [searchForm, loginForm, configForm] : []),
        }),
        configForm
    );

    // Rich form with multi-value checkboxes, submit/image inputs, disabled default option, and select multiple
    const richForm = {
        querySelectorAll(selector) {
            if (selector === 'input') {
                return [
                    { name: 'token', type: 'hidden', value: 't1' },
                    { name: 'addons[]', type: 'checkbox', value: '10', checked: true },
                    { name: 'addons[]', type: 'checkbox', value: '20', checked: true },
                    { name: 'addons[]', type: 'checkbox', value: '30', checked: false },
                    { name: 'submit_btn', type: 'submit', value: 'Continue' },
                    { name: 'img_btn', type: 'image', value: 'Pay' },
                    { name: 'reset_btn', type: 'reset', value: 'Reset' },
                ];
            }
            if (selector === 'select') {
                return [
                    {
                        name: 'region',
                        disabled: false,
                        multiple: false,
                        querySelectorAll: () => [
                            { value: '', disabled: true, selected: true },
                            { value: 'hk', disabled: false, selected: false },
                            { value: 'jp', disabled: false, selected: false },
                        ],
                    },
                    {
                        name: 'tags[]',
                        disabled: false,
                        multiple: true,
                        querySelectorAll: () => [
                            { value: 'ipv6', disabled: false, selected: true },
                            { value: 'ddos', disabled: true, selected: true },
                            { value: 'backup', disabled: false, selected: true },
                        ],
                    },
                ];
            }
            return [];
        },
    };

    const fields = core.extractFormFields(richForm, '3005');
    assert.deepEqual(fields, {
        token: 't1',
        'addons[]': ['10', '20'],
        region: 'hk',
        'tags[]': ['ipv6', 'backup'],
        pid: '3005',
        qty: '1',
    });

    const params = core.buildFormUrlSearchParams(fields);
    assert.deepEqual(params.getAll('addons[]'), ['10', '20']);
    assert.deepEqual(params.getAll('tags[]'), ['ipv6', 'backup']);
    assert.equal(params.get('region'), 'hk');
    assert.equal(params.has('submit_btn'), false);
    assert.equal(params.has('img_btn'), false);

    // Prototype-colliding field names (toString / constructor) must not collide with Object.prototype
    const protoForm = {
        querySelectorAll(selector) {
            if (selector === 'input') {
                return [
                    { name: 'toString', type: 'text', value: 'v1' },
                    { name: 'constructor', type: 'hidden', value: 'v2' },
                ];
            }
            return [];
        },
    };
    const protoFields = core.extractFormFields(protoForm, '4001');
    assert.equal(protoFields.toString, 'v1');
    assert.equal(protoFields.constructor, 'v2');
    assert.equal(core.buildFormUrlSearchParams(protoFields).get('toString'), 'v1');
    assert.equal(core.buildFormUrlSearchParams(protoFields).get('constructor'), 'v2');
});

test('P2: string MISSING_SENTINEL is structuredClone-safe, scheduleLongTimeout chunks > 32-bit delays, and updateEnabledHosts preserves concurrent tabs', () => {
    // 1. String sentinel avoids DataCloneError in GM_getValue
    assert.equal(typeof core.MISSING_SENTINEL, 'string');
    assert.equal(structuredClone(core.MISSING_SENTINEL), core.MISSING_SENTINEL);

    // 2. scheduleLongTimeout chunks delays exceeding 2147483647ms
    let fakeNow = 1000;
    const scheduled = [];
    const cleared = [];
    let nextId = 1;
    let fired = 0;

    const handle = core.scheduleLongTimeout(
        () => {
            fired++;
        },
        core.MAX_TIMEOUT_MS * 2 + 500,
        {
            nowFn: () => fakeNow,
            setTimeoutFn: (fn, delay) => {
                assert.ok(delay <= core.MAX_TIMEOUT_MS, `delay ${delay} exceeded 32-bit max`);
                const id = nextId++;
                scheduled.push({ id, fn, delay });
                return id;
            },
            clearTimeoutFn: (id) => cleared.push(id),
        }
    );

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, core.MAX_TIMEOUT_MS);
    fakeNow += core.MAX_TIMEOUT_MS;
    scheduled[0].fn();

    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].delay, core.MAX_TIMEOUT_MS);
    fakeNow += core.MAX_TIMEOUT_MS;
    scheduled[1].fn();

    assert.equal(scheduled.length, 3);
    assert.equal(scheduled[2].delay, 500);
    assert.equal(fired, 0);
    fakeNow += 500;
    scheduled[2].fn();
    assert.equal(fired, 1);

    // Cancellation prevents firing
    let cancelFired = false;
    const cancelHandle = core.scheduleLongTimeout(
        () => {
            cancelFired = true;
        },
        core.MAX_TIMEOUT_MS + 100,
        {
            nowFn: () => fakeNow,
            setTimeoutFn: (fn, delay) => {
                const id = nextId++;
                scheduled.push({ id, fn, delay });
                return id;
            },
            clearTimeoutFn: (id) => cleared.push(id),
        }
    );
    cancelHandle.cancel();
    assert.equal(cleared.length, 1);
    scheduled[scheduled.length - 1].fn();
    assert.equal(cancelFired, false);
    handle.cancel();

    // 3. Multi-tab enabledHosts safety
    const store = createMemoryStore({ [core.ENABLED_HOSTS_KEY]: JSON.stringify(['tab-a.example.com']) });
    // Tab B writes concurrently
    core.updateEnabledHosts(store, 'tab-b.example.com', true);
    // Tab A disables itself without wiping Tab B
    const afterDisable = core.updateEnabledHosts(store, 'tab-a.example.com', false);
    assert.deepEqual(afterDisable, ['tab-b.example.com']);
});

test('integration (vm): userscript runtime guards stop-mid-fetch, wakeLock stop race, serverTimeDelta reset, resp.ok, and menu live read', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'vps-drop-sync.user.js'), 'utf8');

    function createElementStub(id = '') {
        const listeners = new Map();
        const classes = new Set();
        const attrs = new Map();
        return {
            id,
            value: '',
            textContent: '',
            disabled: false,
            style: {},
            children: [],
            offsetWidth: 364,
            offsetHeight: 400,
            scrollTop: 0,
            scrollHeight: 0,
            classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                toggle: (c, force) => {
                    if (force === undefined) {
                        if (classes.has(c)) classes.delete(c);
                        else classes.add(c);
                    } else if (force) classes.add(c);
                    else classes.delete(c);
                },
                contains: (c) => classes.has(c),
            },
            addEventListener: (ev, fn) => {
                if (!listeners.has(ev)) listeners.set(ev, []);
                listeners.get(ev).push(fn);
            },
            dispatch: (ev, arg = {}) => {
                for (const fn of listeners.get(ev) || []) {
                    fn({ stopPropagation() {}, ...arg });
                }
            },
            getAttribute: (k) => attrs.get(k) ?? null,
            setAttribute: (k, v) => attrs.set(k, v),
            appendChild(child) {
                this.children.push(child);
                return child;
            },
            focus() {},
            getBoundingClientRect: () => ({ left: 20, top: 20 }),
            setPointerCapture() {},
            attachShadow() {
                const byId = new Map();
                const ids = [
                    'vds-card', 'vds-drag', 'vds-sound-toggle', 'vds-toggle', 'vds-dot',
                    'vds-status', 'vds-delta', 'vds-rtt', 'vds-countdown-box', 'vds-countdown',
                    'vds-stage', 'vds-pid', 'vds-time', 'vds-stoptime', 'vds-pay',
                    'vds-pay-custom-wrap', 'vds-pay-custom', 'vds-speed', 'vds-promo',
                    'vds-alert', 'vds-start', 'vds-stop', 'vds-log', 'vds-clear', 'vds-host-label',
                ];
                for (const elId of ids) byId.set(elId, createElementStub(elId));
                this._shadowById = byId;
                return {
                    innerHTML: '',
                    getElementById: (k) => byId.get(k) || null,
                    querySelectorAll: () => [],
                };
            },
        };
    }

    const gmData = new Map([
        [core.ENABLED_HOSTS_KEY, JSON.stringify(['shop.example.com'])],
    ]);
    let menuCallback = null;
    let reloaded = false;
    let wakeLockResolve = null;
    let wakeLockReleased = 0;

    let fetchHandler = async () => ({
        ok: true,
        status: 200,
        url: 'https://shop.example.com/',
        headers: { get: () => null },
        text: async () => '',
    });

    const hostNodes = [];
    const docListeners = new Map();
    const documentStub = {
        title: 'Shop',
        visibilityState: 'visible',
        body: {
            appendChild: (el) => {
                hostNodes.push(el);
                return el;
            },
        },
        createElement: () => createElementStub(),
        addEventListener: (ev, fn) => {
            if (!docListeners.has(ev)) docListeners.set(ev, []);
            docListeners.get(ev).push(fn);
        },
    };

    const windowStub = {
        innerWidth: 1280,
        innerHeight: 720,
        location: { host: 'shop.example.com', href: 'https://shop.example.com/', reload: () => { reloaded = true; } },
        addEventListener: () => {},
        focus: () => {},
        crypto: { getRandomValues: (arr) => arr.fill(1) },
    };

    class MockDOMParser {
        parseFromString(html) {
            return {
                getElementById: (id) => {
                    if (id === 'frmConfigureProduct' && html.includes('id="frmConfigureProduct"')) {
                        return {
                            id: 'frmConfigureProduct',
                            querySelectorAll: (sel) =>
                                sel === 'input' ? [{ name: 'token', type: 'hidden', value: 'csrf1' }] : [],
                        };
                    }
                    return null;
                },
                querySelectorAll: (sel) => {
                    if (sel === 'form' && html.includes('<form action="/search"')) {
                        return [
                            {
                                id: 'site-search',
                                className: 'search-form',
                                action: '/search',
                                method: 'get',
                                getAttribute: () => null,
                                querySelectorAll: () => [{ name: 'q', type: 'search' }],
                            },
                        ];
                    }
                    return [];
                },
                querySelector: () => null,
            };
        }
    }

    const trackedTimeouts = new Set();
    const trackedIntervals = new Set();
    const trackedSetTimeout = (fn, ms, ...args) => {
        const id = setTimeout(() => {
            trackedTimeouts.delete(id);
            fn(...args);
        }, ms);
        trackedTimeouts.add(id);
        return id;
    };
    const trackedClearTimeout = (id) => {
        trackedTimeouts.delete(id);
        clearTimeout(id);
    };
    const trackedSetInterval = (fn, ms, ...args) => {
        const id = setInterval(fn, ms, ...args);
        trackedIntervals.add(id);
        return id;
    };
    const trackedClearInterval = (id) => {
        trackedIntervals.delete(id);
        clearInterval(id);
    };
    const cleanupTimers = () => {
        for (const id of trackedTimeouts) clearTimeout(id);
        for (const id of trackedIntervals) clearInterval(id);
        trackedTimeouts.clear();
        trackedIntervals.clear();
    };

    const sandbox = {
        window: windowStub,
        document: documentStub,
        location: windowStub.location,
        navigator: {
            wakeLock: {
                request: () =>
                    new Promise((resolve) => {
                        wakeLockResolve = resolve;
                    }),
            },
        },
        localStorage: { getItem: () => null, setItem: () => {} },
        sessionStorage: { getItem: () => '[]', setItem: () => {}, removeItem: () => {} },
        DOMParser: MockDOMParser,
        AbortController,
        URL,
        URLSearchParams,
        Date,
        Uint8Array,
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClearTimeout,
        setInterval: trackedSetInterval,
        clearInterval: trackedClearInterval,
        fetch: (...args) => fetchHandler(...args),
        GM_getValue: (k, def) => {
            // Simulate browser structuredClone check (would throw on Symbol!)
            structuredClone(def);
            return gmData.has(k) ? gmData.get(k) : def;
        },
        GM_setValue: (k, v) => gmData.set(k, v),
        GM_registerMenuCommand: (_label, cb) => {
            menuCallback = cb;
        },
        GM_notification: () => {},
    };

    try {
        vm.runInNewContext(src, sandbox);
        const ui = hostNodes[0]._shadowById;

        // Test 1: Menu callback reads fresh enabledHosts (multi-tab safety)
        gmData.set(core.ENABLED_HOSTS_KEY, JSON.stringify(['shop.example.com', 'other.example.com']));
        menuCallback();
        assert.equal(reloaded, true);
        assert.deepEqual(JSON.parse(gmData.get(core.ENABLED_HOSTS_KEY)), ['other.example.com']);

        // Test 2: Start -> stop mid-fetch aborts request, releases delayed wakeLock, and never submits checkout POST
        const calls = [];
        fetchHandler = (url, opts = {}) => {
            calls.push({ url: String(url), method: opts.method || 'GET', signal: opts.signal });
            if (opts.method === 'HEAD') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    url: 'https://shop.example.com/',
                    headers: { get: (h) => (h === 'Date' ? new Date(Date.now() + 60000).toUTCString() : null) },
                });
            }
            if (String(url).includes('configureproduct') && (opts.method || 'GET') === 'GET') {
                return new Promise((_resolve, reject) => {
                    opts.signal?.addEventListener('abort', () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                url: 'https://shop.example.com/cart',
                headers: { get: () => null },
                text: async () => '',
            });
        };

        ui.get('vds-pid').value = '2159';
        ui.get('vds-time').value = core.toDateTimeLocal(core.formatLocalDateTime(Date.now() - 5000));
        ui.get('vds-speed').value = '10';
        ui.get('vds-start').dispatch('click');

        // Wait until configureproduct GET is in flight
        await new Promise((r) => setTimeout(r, 550));
        const configCall = calls.find((c) => c.url.includes('configureproduct'));
        assert.ok(configCall, 'expected configureproduct GET to start');
        assert.equal(configCall.signal.aborted, false);

        // Stop while configureproduct GET & wakeLock request are still pending
        ui.get('vds-stop').dispatch('click');
        assert.equal(configCall.signal.aborted, true);

        // Resolve delayed wakeLock AFTER stop -> must release immediately!
        wakeLockResolve({
            release: async () => {
                wakeLockReleased++;
            },
        });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(wakeLockReleased, 1);

        // Ensure no POST add-to-cart or checkout was issued after stop
        assert.equal(
            calls.some((c) => c.method === 'POST'),
            false
        );

        // Test 3: Failed sync MUST reset serverTimeDelta = 0 (not retain +60000ms from Test 2!)
        let polledDuringFutureCountdown = false;
        fetchHandler = async (url, opts = {}) => {
            if (opts.method === 'HEAD') throw new Error('sync offline');
            if (String(url).includes('configureproduct')) polledDuringFutureCountdown = true;
            return { ok: true, status: 200, url: 'https://shop.example.com/', text: async () => '' };
        };
        // Set startTime 20s in the future: with stale +60000ms delta it would fire immediately; with reset delta=0 it waits!
        ui.get('vds-time').value = core.toDateTimeLocal(core.formatLocalDateTime(Date.now() + 20000));
        ui.get('vds-start').dispatch('click');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(ui.get('vds-delta').textContent, '本地时钟');
        assert.equal(polledDuringFutureCountdown, false);
        assert.equal(ui.get('vds-status').textContent, '定时待命');
        ui.get('vds-stop').dispatch('click');

        // Test 4: Skips 502 (resp.ok=false) and header search form, then catches login HTML on /viewinvoice.php
        let probeStep = 0;
        const postUrls = [];
        fetchHandler = async (url, opts = {}) => {
            const u = String(url);
            const method = opts.method || 'GET';
            if (method === 'POST') postUrls.push(u);
            if (method === 'HEAD') {
                throw new Error('network down');
            }
            if (u.includes('emptycart')) {
                return { ok: true, status: 200, url: 'https://shop.example.com/cart', text: async () => '' };
            }
            if (u.includes('configureproduct') && method === 'GET') {
                probeStep++;
                if (probeStep === 1) {
                    return {
                        ok: false,
                        status: 502,
                        url: 'https://shop.example.com/cart?action=configureproduct&pid=2159',
                        text: async () => '<form id="frmConfigureProduct"></form>',
                    };
                }
                if (probeStep === 2) {
                    return {
                        ok: true,
                        status: 200,
                        url: 'https://shop.example.com/cart?action=configureproduct&pid=2159',
                        text: async () => '<form action="/search"><input name="q"></form>',
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    url: 'https://shop.example.com/cart?action=configureproduct&pid=2159',
                    text: async () => '<form id="frmConfigureProduct"><input name="token" value="csrf1"></form>',
                };
            }
            if (u.includes('configureproduct') && method === 'POST') {
                return { ok: true, status: 200, url: 'https://shop.example.com/cart?action=viewcart', text: async () => '' };
            }
            if (u.includes('statuscart=checkout')) {
                // Server stays on /viewinvoice.php URL but renders a login form!
                return {
                    ok: true,
                    status: 200,
                    url: 'https://shop.example.com/viewinvoice.php?id=999',
                    text: async () => '<form action="/dologin.php"><input name="username"><input type="password"></form>',
                };
            }
            return { ok: true, status: 200, url: 'https://shop.example.com/', text: async () => '' };
        };

        ui.get('vds-time').value = core.toDateTimeLocal(core.formatLocalDateTime(Date.now() - 5000));
        ui.get('vds-start').dispatch('click');
        await new Promise((r) => setTimeout(r, 350));

        // Must have skipped step 1 (502) and step 2 (search form), submitted on step 3, and stopped on login HTML!
        assert.equal(probeStep, 3);
        assert.equal(postUrls.length, 2);
        assert.equal(ui.get('vds-status').textContent, '异常停止');
        assert.equal(ui.get('vds-stage').textContent, '登录状态失效');
        assert.equal(windowStub.location.href, 'https://shop.example.com/');

        // Test 5: Quick stop + quick restart does not allow stale coroutine to submit orders for old PID
        let staleResolve = null;
        let run2CheckoutCount = 0;
        const seenPidsOnPost = [];
        fetchHandler = (url, opts = {}) => {
            const u = String(url);
            const method = opts.method || 'GET';
            if (method === 'HEAD') return Promise.reject(new Error('offline'));
            if (u.includes('emptycart')) {
                return Promise.resolve({ ok: true, status: 200, url: 'https://shop.example.com/cart', text: async () => '' });
            }
            if (u.includes('pid=1111') && method === 'GET') {
                // Ignore abort intentionally to verify runId check after await!
                return new Promise((resolve) => {
                    staleResolve = () =>
                        resolve({
                            ok: true,
                            status: 200,
                            url: 'https://shop.example.com/cart?action=configureproduct&pid=1111',
                            text: async () => '<form id="frmConfigureProduct"><input name="token" value="old"></form>',
                        });
                });
            }
            if (u.includes('pid=2222') && method === 'GET') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    url: 'https://shop.example.com/cart?action=configureproduct&pid=2222',
                    text: async () => '<form id="frmConfigureProduct"><input name="token" value="new"></form>',
                });
            }
            if (u.includes('configureproduct') && method === 'POST') {
                seenPidsOnPost.push(u);
                return Promise.resolve({ ok: true, status: 200, url: 'https://shop.example.com/cart?action=viewcart', text: async () => '' });
            }
            if (u.includes('statuscart=checkout') && method === 'POST') {
                run2CheckoutCount++;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    url: 'https://shop.example.com/viewinvoice.php?id=2222',
                    text: async () => '<h1>Invoice #2222</h1>',
                });
            }
            return Promise.resolve({ ok: true, status: 200, url: 'https://shop.example.com/', text: async () => '' });
        };

        ui.get('vds-pid').value = '1111';
        ui.get('vds-start').dispatch('click');
        await new Promise((r) => setTimeout(r, 80));
        assert.ok(staleResolve, 'expected run 1 PID 1111 GET in flight');

        // Stop and immediately restart with PID 2222, then resolve stale PID 1111 response!
        ui.get('vds-stop').dispatch('click');
        ui.get('vds-pid').value = '2222';
        ui.get('vds-start').dispatch('click');
        staleResolve();

        await new Promise((r) => setTimeout(r, 120));
        assert.equal(run2CheckoutCount, 1);
        assert.deepEqual(seenPidsOnPost, ['/cart?action=configureproduct&pid=2222']);
        assert.equal(ui.get('vds-status').textContent, '已锁单');
    } finally {
        cleanupTimers();
    }
});
