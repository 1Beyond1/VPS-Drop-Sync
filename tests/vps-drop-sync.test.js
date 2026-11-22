'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
