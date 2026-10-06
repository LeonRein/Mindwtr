// Language check for the isolated native Android development app.
//
//   node apps/android-native/scripts/check-language-device.mjs <adb-serial> [apk]
//
// Installs the debug APK with `install -r` (existing development data stays)
// and compares the labels with core's own dictionaries (en.ts and zh-Hans.ts,
// read from source): (a) with no override the tabs, the capture button, and
// the Inbox scope line (RN's "All areas" under Process Inbox) show core's English, so the
// phone's language must resolve to English; (b) with the debug-only property
// `debug.mindwtr.native.language=zh` and a fresh process, the same labels show
// core's Chinese and the app logs `language=zh missing=0`; (c) with the
// property cleared and a fresh process, English again. It never changes the
// phone's system language. It touches only the development package (it
// refuses any other APK), never launches over another app, and clears its
// debug properties on exit. Leave the device on its home screen before running.
// Exit 0 = pass, 1 = fail, 2 = refused before touching the device, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { button, check, connect, evidenced, Stopped, tab } from './device.mjs';

const [serial, apkArg] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node check-language-device.mjs <adb-serial> [apk]');
    process.exit(2);
}
const app = resolve(import.meta.dirname, '..');
const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';
// Never install anything but the development package (install -r would upgrade it).
const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
if (apkPackage !== PKG) {
    console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
    process.exit(2);
}
const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const TAG = 'MindwtrNativeDev';
const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'language'];

// Core's dictionaries, as core's translator reads them: the language's text, else English. zh is a full locale.
const locales = resolve(app, '../../packages/core/src/i18n/locales');
const { en } = await import(resolve(locales, 'en.ts'));
const { zhHans } = await import(resolve(locales, 'zh-Hans.ts'));
const label = (language, key) => (language === 'zh' ? zhHans[key] : undefined) ?? en[key];

const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
const { sh, home, front, pid, waitFor, logs } = device;
const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);

/** A fresh process (force-stop, launch), then every checked label must be core's text in [language]. */
const expectLanguage = async (language, step) => {
    await device.stopApp();
    await waitFor('home screen', () => front().includes(`${home}/`), 10_000);
    device.launch(ACTIVITY);
    const [inbox, focus, capture, scope] = ['tab.inbox', 'tab.next', 'nav.addTask', 'projects.allAreas'].map((key) => label(language, key));
    const nodes = await waitFor(`the ${language} Inbox`, (current) => tab(current, inbox)
        && current.some((node) => node.text === scope), 60_000);
    // The quick-access tab holds the view core's quickAccessView names: Projects, Review, or Contexts, each in core's words.
    const quick = ['nav.projects', 'tab.review', 'nav.contexts'].map((key) => [key, label(language, key)]).find(([, text]) => tab(nodes, text))
        ?? ['nav.projects', label(language, 'nav.projects')];
    for (const [name, text] of [['tab.inbox', inbox], ['tab.next', focus], quick]) {
        check(Boolean(tab(nodes, text)), `(${step}) the ${name} tab reads core's ${language} "${text}"`);
    }
    // RN's center capture button is labelled with core's nav.addTask.
    check(Boolean(button(nodes, capture)), `(${step}) the capture button reads core's ${language} "${capture}"`);
    check(nodes.some((node) => node.text === scope), `(${step}) the Inbox scope line reads core's ${language} "${scope}"`);
    const line = logs(pid(), TAG).split('\n').find((entry) => entry.includes('Native Android labels')) ?? '';
    check(line.includes(`language=${language} missing=0`), `(${step}) the app logged ${line.slice(line.indexOf('Native Android labels')) || 'no labels line'}`);
};

try {
    console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')}) / locale ${sh('getprop persist.sys.locale')}`);
    console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
    for (const name of PROPS) setProp(name, '');
    const beforeInstall = front();
    if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) {
        throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
    }
    execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });

    await expectLanguage('en', 'a');
    setProp('language', 'zh');
    await expectLanguage('zh', 'b');
    setProp('language', '');
    await expectLanguage('en', 'c');
    console.log('Language device check passed');
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    for (const name of PROPS) { try { setProp(name, ''); } catch { /* device gone */ } }
    try { sh(`rm -f ${UI_FILE}`); } catch { /* device gone */ }
}
