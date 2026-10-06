// Process Inbox check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-process-inbox-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays), captures one
// task, and checks RN's Process Inbox against core's own session on a copy of the app's
// database: (a) the Inbox's "Process Inbox (N)" speaks core's Inbox count; (b) it opens on
// core's first item, question, and choices (guided); (c) Yes moves to core's next question and
// Back returns; (d) rotation keeps the step; (e) Quick shows core's quick choices, and Guided
// comes back; on core's file step the + beside Contexts is dimmed whole while the field is empty. (f) Only when core's first item is one of the device checks' own captures: a
// Trash whose commit fails keeps its exact retry through rotation, and the retry deletes it
// once; (g) process death before the write, after the write, and again during the replay: the app
// lands on the Inbox, the answer is sent again, it is stored at most once, and its record on disk goes only
// once core has answered. It touches only the development package (it refuses any other APK), never launches
// over another app, leaves the app on its Inbox, restores rotation and the mode, and clears
// its debug properties on exit. Leave the device on its home screen. It needs host `bun`.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { blended, box, button, check, connect, draftText, evidenced, fail, hasText, inboxCount, Stopped, tab, tagged, withDescription } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-process-inbox-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];
const DB = 'mindwtr-native-dev.db';
const work = resolve(app, 'android/build/process-inbox-check');
const coreSrc = resolve(app, '../../packages/core/src');
const { en } = await import(resolve(coreSrc, 'i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const title = `52${run}`;
// The device checks' own capture titles (lifecycle, focus, editor, search, this check): only such an item is trashed.
const CHECK_CAPTURE = /^(8[1-6]|7[12]|91|5[12])[0-9]{12}/;

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, requireAppFront, pid, screen, waitFor, tapExpecting, type } = device;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Home (so Android saves the screen's state), then kill the process, as the system does in the background. */
const killInBackground = async () => {
    const processId = pid();
    requireAppFront();
    sh('input keyevent KEYCODE_HOME');
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    await sleep(1500);
    sh(`run-as ${PKG} kill -9 ${processId}`);
    await waitFor('process death', () => pid() !== processId, 10_000);
};
/** Process Inbox's record in the no-backup folder (the screen and an owed answer's exact request). */
const record = () => { try { return sh(`run-as ${PKG} ls no_backup/process-inbox`).split(/\s+/).includes('processing'); } catch { return false; } };
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
const answers = (outcome) => device.logs(pid(), TAG).replace(/\\/g, '').split('\n').filter((line) => line.includes('native-android-dev-task-command')
    && line.includes('"operation":"inboxCommit"') && line.includes(`"outcome":"${outcome}"`)).length;

// ---- core on a copy of the app's database ----
const pullDatabase = () => {
    const dir = resolve(work, 'db');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const present = sh(`run-as ${PKG} ls files`).split(/\s+/);
    for (const suffix of ['', '-wal', '-shm']) if (present.includes(`${DB}${suffix}`)) device.pull(`files/${DB}${suffix}`, resolve(dir, `${DB}${suffix}`));
    return resolve(dir, DB);
};
/**
 * Core's Inbox count, and its Process Inbox session in [mode] after [choices]: the item, the question, the choices, the label
 * of each choice made, and the file step's Contexts field and its + (when the step has them).
 */
const core = (mode, choices = [], taskId = '') => JSON.parse(execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.CHECK_DB);
    setStorageAdapter(new SqliteAdapter({
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    }));
    const host = createNativeHostContract();
    const ready = await host.activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const value = (result) => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.value; };
    const started = value(host.startInboxProcessing({ mode: process.env.CHECK_MODE }));
    let view = started.view;
    const picked = [];
    for (const choice of JSON.parse(process.env.CHECK_CHOICES)) {
        picked.push(view.choices.find((item) => item.id === choice)?.label ?? choice);
        // A flow answer writes nothing, so the copy stays as the phone has it.
        view = value(await host.commitInboxProcessingStep({ sessionId: started.sessionId, taskId: view.taskId, step: view.step,
            decision: { choice }, requestId: crypto.randomUUID() })).view;
    }
    const task = useTaskStore.getState()._allTasks.find((item) => item.id === process.env.CHECK_TASK);
    console.log(JSON.stringify({
        total: value(host.getInboxWindow({ offset: 0, limit: 1 })).total,
        taskId: view?.taskId, title: view?.capture.title, question: view?.question, progress: view?.progress.label,
        choices: view?.choices.map((choice) => choice.label) ?? [], deleted: task ? Boolean(task.deletedAt) : null, picked,
        contexts: view?.contexts ? { field: view.contexts.title, add: view.contexts.add.label } : null,
    }));
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, CHECK_DB: pullDatabase(), CHECK_MODE: mode, CHECK_CHOICES: JSON.stringify(choices), CHECK_TASK: taskId } })
    .trim().split('\n').pop());

// ---- UI (core's English) ----
const onInbox = (nodes) => !tagged(nodes, 'process-inbox') && Number.isFinite(inboxCount(nodes));
const inProcess = (nodes) => Boolean(tagged(nodes, 'process-inbox'));
const itemTitle = (nodes) => tagged(nodes, 'process-title')?.text;
/** The item and the question as core says them. */
const showsItem = (nodes, view) => inProcess(nodes) && itemTitle(nodes) === view.title && hasText(nodes, view.question);
/** The step as core says it: the item, the question, and core's first choices (the rest can sit below the fold). */
const showsStep = (nodes, view) => showsItem(nodes, view) && view.choices.slice(0, 4).every((label) => withDescription(nodes, label));
const failure = (nodes) => nodes.some((node) => node.text?.includes('Injected commit failure'));
const rotate = async (rotation, expected, description) => {
    requireAppFront();
    sh(`settings put system user_rotation ${rotation}`);
    return waitFor(description, expected, 20_000);
};

const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
let originalMode;
const restore = async () => {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try {
        if (front().includes(`${PKG}/`)) {
            let nodes = await screen();
            // The maintainer's mode comes back (the check switched to guided), then Close leaves the app on its Inbox.
            if (inProcess(nodes) && originalMode === 'quick' && withDescription(nodes, en['process.modeQuick'])) {
                nodes = await tapExpecting(withDescription(nodes, en['process.modeQuick']), (current) => Boolean(withDescription(current, en['process.modeGuided'])), 'quick mode again', 10_000);
            }
            if (inProcess(nodes) && withDescription(nodes, en['common.close'])?.enabled === 'true') await tapExpecting(withDescription(nodes, en['common.close']), onInbox, 'the Inbox', 10_000);
        }
    } catch { /* the app is gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
};

try {
    mkdirSync(work, { recursive: true });
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
    device.launch(ACTIVITY);
    requireAppFront();
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    let nodes = await waitFor('the Inbox', onInbox, 60_000);
    const total = inboxCount(nodes);
    await type(title);
    await tapExpecting(button(await screen(), 'Save'), (current) => draftText(current) === '' || button(current, 'Save')?.enabled === 'false', 'the capture to start');
    nodes = await waitFor('the capture', (current) => inboxCount(current) === total + 1 && draftText(current) === '');

    // (a) The button speaks core's Inbox count.
    let guided = core('guided');
    check(inboxCount(nodes) === guided.total, `(a) "Process Inbox (${guided.total})" is core's Inbox count`);

    // (b) It opens on core's first item and guided question; a phone left in quick mode switches to guided first.
    const opener = withDescription(nodes, `${en['inbox.processButton']} (${guided.total})`);
    nodes = await tapExpecting(opener, inProcess, 'Process Inbox');
    originalMode = withDescription(nodes, en['process.modeGuided']) ? 'quick' : 'guided';
    if (originalMode === 'quick') nodes = await tapExpecting(withDescription(nodes, en['process.modeGuided']), (current) => showsStep(current, guided), 'guided mode');
    nodes = await waitFor('core\'s first step', (current) => showsStep(current, guided), 15_000);
    check(hasText(nodes, guided.progress), `(b) core's item "${guided.title}", question, choices, and progress "${guided.progress}"`);

    // (c) Yes (core's first choice) moves to core's next question, which writes nothing; Back returns.
    const next = core('guided', ['actionable']);
    nodes = await tapExpecting(withDescription(nodes, guided.choices[0]), (current) => showsStep(current, next), 'core\'s next question');
    const back = `‹ ${en['common.back']}`;
    nodes = await tapExpecting(button(nodes, back) ?? fail('no Back on the step'), (current) => showsStep(current, guided), 'the first question again');
    check(true, `(c) "${guided.choices[0]}" shows "${next.question}", and Back returns`);

    // (d) Rotation keeps the step. Landscape asks only for the item: similar tasks can push the question below the fold.
    nodes = await rotate(1, (current) => inProcess(current) && itemTitle(current) === guided.title, 'the step in landscape');
    nodes = await rotate(0, (current) => showsStep(current, guided), 'the step in portrait');
    check(true, '(d) rotation keeps the item and the step');

    // (e) Quick shows core's quick choices for the same item; Guided comes back.
    const quick = core('quick');
    nodes = await tapExpecting(withDescription(nodes, en['process.modeQuick']), (current) => inProcess(current) && itemTitle(current) === quick.title
        && quick.choices.slice(0, 4).every((label) => withDescription(current, label)), 'core\'s quick choices');
    nodes = await tapExpecting(withDescription(nodes, en['process.modeGuided']), (current) => showsStep(current, guided), 'guided again');
    check(true, `(e) Quick shows core's choices (${quick.choices.slice(0, 4).join(', ')}, …) for the same item`);

    // (e) Core's file step (Yes, longer than 2 minutes, I'll do it, single action; no answer writes): the + beside Contexts is
    // dimmed whole while the field is empty, as RN's (opacity 0.5 over its tint), and full once a letter is typed.
    const path = ['actionable', 'no', 'defer', 'single'];
    const filing = core('guided', path);
    const contexts = filing.contexts ?? fail('core\'s file step has no Contexts');
    // Android puts the field's description on a node inside the EditText (as on the capture popup's picker field).
    const contextField = (current) => current.find((node) => node['content-desc'] === contexts.field);
    for (const [at, label] of filing.picked.entries()) {
        nodes = await tapExpecting(withDescription(nodes, label) ?? fail(`no "${label}"`),
            (current) => Boolean(at + 1 < path.length ? withDescription(current, filing.picked[at + 1]) : contextField(current)), `the step after "${label}"`);
    }
    /** The + in the Contexts field's row (another + can sit in More options). */
    const plusNode = (current) => {
        const field = contextField(current);
        return field && current.find((node) => node['content-desc'] === contexts.add && box(node)[1] < box(field)[3] && box(node)[3] > box(field)[1]);
    };
    /** The +'s fill beside its glyph and the step's own color in the 8dp gap to its left, once [ready] holds for the fill (5 s at most). */
    const plus = async (name, ready) => {
        for (let attempt = 0; ; attempt += 1) {
            const [left, top, , bottom] = box(plusNode(await screen()) ?? fail('no + beside Contexts'));
            const y = Math.round((top + bottom) / 2);
            const [fill, under] = device.colors(resolve(work, `plus-${name}.png`), [[left + 8, y], [left - 11, y]]);
            if (ready(fill) || attempt === 10) return { fill, under };
            await sleep(500);
        }
    };
    await device.settle(nodes);
    const emptyPlus = await plus('empty', () => true);
    await device.focusAtEnd(contextField(await screen()));
    requireAppFront();
    sh('input text x');
    // Core's reply turns the + on, and its fill changes when it does.
    const fullPlus = await plus('typed', (fill) => fill !== emptyPlus.fill);
    check(blended(emptyPlus.fill, fullPlus.fill, emptyPlus.under),
        `(e) the file step's + is half its color while Contexts is empty: #${emptyPlus.fill} (full #${fullPlus.fill}, under #${emptyPlus.under})`);
    requireAppFront();
    sh('input keyevent KEYCODE_DEL');
    check((await plus('cleared', (fill) => fill === emptyPlus.fill)).fill === emptyPlus.fill, '(e) the + dims again once the letter is gone');
    // Close, then Process Inbox again: core's session starts over on its first question for (f) and (g).
    if (/mInputShown=true/.test(sh('dumpsys input_method'))) { requireAppFront(); sh('input keyevent KEYCODE_BACK'); await sleep(600); }
    nodes = await tapExpecting(withDescription(await screen(), en['common.close']) ?? fail('no Close'), onInbox, 'the Inbox');
    nodes = await tapExpecting(withDescription(nodes, `${en['inbox.processButton']} (${guided.total})`) ?? fail('no Process Inbox'),
        (current) => showsStep(current, guided), 'core\'s first question again');

    // (f) A failed Trash keeps its exact retry; only for the checks' own capture, never other development data.
    if (CHECK_CAPTURE.test(guided.title)) {
        const trash = en['inbox.trash'];
        const saved = answers('saved');
        setProp('fail_commit', '1');
        nodes = await tapExpecting(withDescription(nodes, trash), failure, 'the injected failure');
        await rotate(1, (current) => failure(current) && itemTitle(current) === guided.title, 'the failure in landscape');
        nodes = await rotate(0, (current) => failure(current) && Boolean(withDescription(current, trash)), 'the failure in portrait');
        check(withDescription(nodes, trash)?.enabled === 'true' && withDescription(nodes, guided.choices[0])?.enabled !== 'true',
            '(f) after rotation the failure stays and only the failed Trash is enabled');
        setProp('fail_commit', '');
        nodes = await tapExpecting(withDescription(nodes, trash), (current) => !failure(current) && (!inProcess(current) || itemTitle(current) !== guided.title), 'the next item');
        const after = core('guided', [], guided.taskId);
        check(after.deleted === true && answers('saved') === saved + 1 && answers('failed') >= 1,
            `(f) the retry trashed "${guided.title}" once, and the step moved on`);
    } else {
        console.log(`note - (f) core's first item "${guided.title}" is not a device check capture; the Trash retry step is skipped`);
    }

    // (g) Process death with a Trash in flight: before the write, then after the write and again during the replay.
    for (const [label, prop, written] of [['before the write', 'delay_before_ms', false], ['after the write', 'delay_after_ms', true]]) {
        nodes = await screen();
        if (!inProcess(nodes)) {
            const open = nodes.find((node) => node['content-desc']?.startsWith(`${en['inbox.processButton']} (`)) ?? fail('no Process Inbox button');
            nodes = await tapExpecting(open, inProcess, 'Process Inbox');
        }
        const item = core('guided');
        if (!CHECK_CAPTURE.test(item.title ?? '')) {
            console.log(`note - (g) core's first item "${item.title}" is not a device check capture; the death steps are skipped`);
            break;
        }
        nodes = await waitFor('the item', (current) => showsStep(current, item), 15_000);
        // Held long enough for Home, the launcher and the kill to finish first (8 s ran out on the S23, run 51).
        setProp(prop, '20000');
        await tapExpecting(withDescription(nodes, en['inbox.trash']), (current) => withDescription(current, en['inbox.trash'])?.enabled !== 'true', 'the Trash in flight');
        if (written) await waitFor('the Trash on disk', () => core('guided', [], item.taskId).deleted === true, 10_000);
        check(record(), `(g) ${label}: the answer's request is on disk before core answers`);
        await killInBackground();
        setProp(prop, '');
        if (written) {
            // A second death while the replay itself is held: the record must still be there for the next launch.
            setProp('delay_before_ms', '20000');
            device.launch(ACTIVITY);
            // The owed answer is replayed before the Inbox list is read, so during the held replay the list is still loading
            // (no Process Inbox button yet); the tab bar shows the app is up (run 53 on the S23).
            await waitFor('the app during the replay', (current) => !tagged(current, 'process-inbox') && Boolean(tab(current, en['tab.inbox'])), 60_000);
            await killInBackground();
            setProp('delay_before_ms', '');
            check(record(), '(g) a death during the replay keeps the request on disk');
        }
        device.launch(ACTIVITY);
        nodes = await waitFor('the Inbox, as RN lands after process death', onInbox, 60_000);
        await waitFor('the replay to finish', () => !record(), 30_000);
        const after = core('guided', [], item.taskId);
        check(after.deleted === written, `(g) ${label}: the app lands on the Inbox, the replay ends the record, and "${item.title}" is ${written ? 'trashed once' : 'kept'}`);
    }
    console.log('Process Inbox device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    await restore();
}
