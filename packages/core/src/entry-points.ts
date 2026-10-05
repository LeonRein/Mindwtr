/**
 * Where an outside entry point goes, shared by React Native and the native Android app: the route a system URL
 * opens (moved from apps/mobile/app/+native-intent.ts), a text share's capture draft and an entity link's target
 * (moved from apps/mobile/hooks/root-layout/use-root-layout-external-capture.ts), and, for the native app,
 * expo-share-intent's reading of an Android text share and the assistant note React Native's MainActivity turns
 * into a capture link. React Native keeps its logging and navigation; the decisions are here.
 */
import {
    isEntityOpenUrl,
    isOpenFeatureUrl,
    isShortcutCaptureUrl,
    parseOpenFeatureUrl,
    resolveOpenFeaturePath,
    type EntityOpenKind,
    type ShortcutCapturePayload,
} from './capture-deeplink';
import { DROPBOX_CALLBACK_SETTINGS_PATH, isDropboxAuthCallbackUrl } from './dropbox-auth-callback';

/** Which of React Native's system-path rules routed a URL; React Native logs some of them. */
export type SystemPathRoute =
    /** expo-share-intent's iOS handoff: the Inbox on a cold start, no navigation ('') on a warm one. */
    | { kind: 'shareHandoff'; path: string }
    | { kind: 'dropboxCallback'; path: string }
    | { kind: 'openFeature'; path: string }
    /** An entity link or a capture link: the Inbox first; the root layout then opens the entity or the capture. */
    | { kind: 'entityOpen' | 'capture'; path: '/inbox' }
    /** A widget's, tile's or control's quick capture: the capture screen, which returns to the previous app when it ends (#1169). */
    | { kind: 'quickCapture'; path: '/capture-modal?origin=system' }
    /** Any other URL: Expo Router routes it by its path. */
    | { kind: 'path'; path: string };

const isQuickCaptureUrl = (path: string): boolean => {
    const url = new URL(path);
    if (url.protocol !== 'mindwtr:') return false;
    return url.hostname === 'capture-quick' || url.pathname === '/capture-quick';
};

/**
 * React Native's redirectSystemPath rules, in its order. Expo Router routes an incoming URL by its path, so a named
 * feature is rewritten to its screen, and an entity or capture link lands on the Inbox for the root layout to finish.
 * Never throws: a URL it cannot read keeps its path.
 */
export function resolveSystemPath(path: string, initial: boolean): SystemPathRoute {
    try {
        // expo-share-intent uses the scheme-derived App Group entry name, not an application route.
        if (/^(mindwtr(?:-dev)?):\/\/dataUrl=\1ShareKey\/?(?:#(?:text|weburl|file|media))?$/.test(path)) {
            return { kind: 'shareHandoff', path: initial ? '/inbox' : '' };
        }
        if (isDropboxAuthCallbackUrl(path)) return { kind: 'dropboxCallback', path: DROPBOX_CALLBACK_SETTINGS_PATH };
        if (isOpenFeatureUrl(path)) return { kind: 'openFeature', path: resolveOpenFeaturePath(parseOpenFeatureUrl(path)?.feature ?? null) };
        if (isEntityOpenUrl(path)) return { kind: 'entityOpen', path: '/inbox' };
        if (isShortcutCaptureUrl(path)) return { kind: 'capture', path: '/inbox' };
        if (isQuickCaptureUrl(path)) {
            // The detailed launcher entry opens an unsaved in-app sheet. Existing
            // widget/tile/control links retain their background-returning modal.
            if (new URL(path).searchParams.get('entry') === 'details') {
                return { kind: 'path', path: '/capture-quick?mode=text' };
            }
            return { kind: 'quickCapture', path: '/capture-modal?origin=system' };
        }
    } catch {
        // Never throws; fall through to the original path.
    }
    return { kind: 'path', path };
}

const trimSharedValue = (value: string | null | undefined): string => (
    typeof value === 'string' ? value.trim() : ''
);

/** A shared item as the capture screen opens it: the title, and a description when the share carries one. */
export type ShareCaptureDraft = { title: string; description?: string };

/**
 * The capture a text or link share opens. An email share (FairEmail and others) carries a real subject: it becomes the
 * title, and the body and link move to the description instead of being dumped into the title together (the link once:
 * not again after a body that already holds it). Otherwise the
 * text (else the link) is the title, and a link other than the title is the description. Null: nothing readable.
 */
export function buildShareCaptureDraft({
    shareSubject,
    shareText,
    shareWebUrl,
}: {
    shareSubject?: string | null;
    shareText?: string | null;
    shareWebUrl?: string | null;
}): ShareCaptureDraft | null {
    const subject = trimSharedValue(shareSubject);
    if (subject) {
        const text = trimSharedValue(shareText);
        const url = trimSharedValue(shareWebUrl);
        const descriptionLines = [text, url && !text.includes(url) ? url : null]
            .filter((line): line is string => Boolean(line));
        return descriptionLines.length > 0 ? { title: subject, description: descriptionLines.join('\n') } : { title: subject };
    }

    const title = trimSharedValue(shareText) || trimSharedValue(shareWebUrl);
    if (!title) return null;
    const url = trimSharedValue(shareWebUrl);
    return url && url !== title ? { title, description: url } : { title };
}

type EntityRecord = { deletedAt?: string | null } | undefined;
/** The store's id maps an entity link is checked against. */
export type EntityOpenLookup = {
    _tasksById?: { get(id: string): EntityRecord };
    _projectsById?: { get(id: string): EntityRecord };
    _areasById?: { get(id: string): EntityRecord };
};
/** Where an entity link goes: a task on Focus, opened on its View tab and outlined; a project, or an area's list, on Projects. */
export type EntityOpenTarget = { pathname: '/focus'; taskId: string } | { pathname: '/projects-screen'; projectId?: string };

/**
 * Deep links are untrusted input (#1017): an entity link opens its entity only while the id still exists in the store;
 * null sends it to the default view. Areas have no detail screen, so an area link opens Projects, the closest view that
 * lists them.
 */
export function resolveEntityOpenTarget(kind: EntityOpenKind, id: string, state: EntityOpenLookup): EntityOpenTarget | null {
    if (kind === 'task') {
        const task = state._tasksById?.get(id);
        if (!task || task.deletedAt) return null;
        return { pathname: '/focus', taskId: id };
    }
    if (kind === 'project') {
        const project = state._projectsById?.get(id);
        if (!project || project.deletedAt) return null;
        return { pathname: '/projects-screen', projectId: id };
    }
    const area = state._areasById?.get(id);
    if (!area || area.deletedAt) return null;
    return { pathname: '/projects-screen' };
}

/** expo-share-intent's web URL match (build/utils.js parseShareIntent), kept byte for byte. */
const SHARED_WEB_URL_RE = /[(http(s)?)://(www.)?-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)/gi;

/** A text share as React Native's root layout receives it. */
export type AndroidTextShare = { text: string; webUrl: string | null; subject: string | null };

/**
 * An Android ACTION_SEND text/plain share as expo-share-intent hands it to React Native: its Android module sends
 * EXTRA_TEXT, and EXTRA_TITLE (else EXTRA_SUBJECT, only when the title is missing) as the subject; its parser takes the
 * first http(s) link in the text as the web URL. Without text the provider reports no share at all: null.
 */
export function readAndroidTextShare(input: {
    text?: string | null;
    title?: string | null;
    subject?: string | null;
}): AndroidTextShare | null {
    if (!input.text) return null;
    const webUrl = input.text.match(SHARED_WEB_URL_RE)?.find((link) => link.startsWith('http')) || null;
    return { text: input.text, webUrl, subject: input.title ?? input.subject ?? null };
}

/**
 * Google Assistant's CREATE_NOTE as React Native's MainActivity rewrites it into a capture link
 * (normalizeCreateNoteIntent in apps/mobile/plugins/android-startup-trace.js): the note's name, else its text (the
 * Assistant's text extra, else EXTRA_TEXT), is the title, and the text is the note when it differs. Null: neither has
 * text, so React Native leaves the intent as it came.
 */
export function buildCreateNoteCapture(input: {
    name?: string | null;
    text?: string | null;
    extraText?: string | null;
}): ShortcutCapturePayload | null {
    const rawTitle = (input.name ?? '').trim();
    const rawText = (input.text ?? input.extraText ?? '').trim();
    const title = rawTitle || rawText;
    if (!title) return null;
    return rawText && rawText !== title ? { title, note: rawText, tags: [] } : { title, tags: [] };
}
