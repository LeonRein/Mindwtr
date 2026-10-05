import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../../contexts/language-context';
import {
    getMcpConnectionDetails,
    getMcpServerStatus,
    isMcpServerAvailable,
    setMcpServerConfig,
    type McpServerConfig,
    type McpServerStatus,
} from '../../../lib/mcp-server';
import { Switch } from '../../ui/Switch';
import { SettingRow, SettingsDisclosureCard } from './SettingRow';

const actionClass = 'px-3 py-2 bg-muted rounded-md text-sm font-medium hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed';
const POLL_INTERVAL_MS = 3000;

export function SettingsMcpSection({ isTauri }: { isTauri: boolean }) {
    const { t } = useLanguage();
    const available = isTauri && isMcpServerAvailable();
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<McpServerStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const mounted = useRef(false);
    const inFlight = useRef(false);
    const revision = useRef(0);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; revision.current += 1; };
    }, []);

    useEffect(() => {
        if (!available) return;
        let cancelled = false;
        const requestRevision = revision.current;
        getMcpServerStatus().then((next) => {
            if (!cancelled && requestRevision === revision.current) setStatus(next);
        }).catch(() => {
            if (!cancelled && requestRevision === revision.current) setFailed(true);
        });
        return () => { cancelled = true; };
    }, [available]);

    // Schedule after each response so slow calls never overlap; disabled integration does no polling.
    useEffect(() => {
        if (!available || !status?.enabled || status.error === 'unsupported_os' || busy) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const requestRevision = revision.current;
        const poll = async () => {
            try {
                const next = await getMcpServerStatus();
                if (cancelled || requestRevision !== revision.current) return;
                setStatus(next);
                setFailed(false);
            } catch {
                if (cancelled || requestRevision !== revision.current) return;
                setFailed(true);
                setStatus((current) => current ? { ...current, running: false, url: null, token: null } : null);
            }
            if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
        };
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [available, status?.enabled, status?.error, busy]);

    const runAction = async (config?: McpServerConfig, copy = false) => {
        if (!available || inFlight.current) return;
        if (status?.error === 'unsupported_os' && (config?.enabled || copy)) return;
        inFlight.current = true;
        revision.current += 1;
        setBusy(true);
        setFailed(false);
        setFeedback(null);
        try {
            const next = config ? await setMcpServerConfig(config) : await getMcpServerStatus();
            if (!mounted.current) return;
            setStatus(next);
            if (copy) {
                const details = getMcpConnectionDetails(next);
                if (!details) {
                    setFeedback('settings.mcpCopyFailed');
                    return;
                }
                try {
                    await navigator.clipboard.writeText(details);
                    if (mounted.current) setFeedback('settings.mcpCopied');
                } catch {
                    if (mounted.current) setFeedback('settings.mcpCopyFailed');
                }
            } else if (config?.regenerateToken && !next.error) {
                setFeedback('settings.mcpTokenRotated');
            }
        } catch {
            if (mounted.current) {
                setFailed(true);
                setStatus((current) => current ? { ...current, running: false, url: null, token: null } : null);
            }
        } finally {
            inFlight.current = false;
            if (mounted.current) setBusy(false);
        }
    };

    const error = failed ? 'config_failed' : status?.error;
    const unsupportedOs = status?.error === 'unsupported_os';
    return (
        <SettingsDisclosureCard
            sectionKey="mcpTitle"
            title={t('settings.mcpTitle')} description={t('settings.mcpDesc')}
            open={open} onToggle={() => setOpen((value) => !value)}
        >
            <div className="p-4 space-y-4" aria-busy={busy}>
                {!available ? <p className="text-sm text-muted-foreground">{t('settings.mcpUnavailable')}</p> : <>
                    <SettingRow settingsKey={null} title={t('settings.mcpEnable')} description={t('settings.mcpReadPermission')}>
                        <Switch aria-label={t('settings.mcpEnable')} checked={status?.enabled ?? false}
                            disabled={busy || !status || (unsupportedOs && !status.enabled)} onCheckedChange={(enabled) => void runAction({ enabled, allowWrite: status?.allowWrite ?? false })} />
                    </SettingRow>
                    <p className="text-xs text-muted-foreground">{t('settings.mcpPrivacy')}</p>
                    <p className="text-sm" role="status">
                        {busy || (!status && !error) ? t('common.loading') : t(status?.running ? 'settings.mcpRunning' : 'settings.mcpStopped')}
                    </p>
                    {error && <p className="text-sm text-destructive" role="alert">{t(`settings.mcpError.${error}`)}</p>}
                    {unsupportedOs && error !== 'unsupported_os' && <p className="text-sm text-muted-foreground">{t('settings.mcpError.unsupported_os')}</p>}
                    {!unsupportedOs && (error || (status?.enabled && !status.running)) && <button type="button" className={actionClass} disabled={busy}
                        onClick={() => void runAction(status ? { enabled: status.enabled, allowWrite: status.allowWrite } : undefined)}>{t('common.retry')}</button>}
                    {status?.enabled && !unsupportedOs && <>
                        <SettingRow settingsKey={null} title={t('settings.mcpAllowWrite')} description={t('settings.mcpAllowWriteDesc')}>
                            <Switch aria-label={t('settings.mcpAllowWrite')} checked={status.allowWrite} disabled={busy}
                                onCheckedChange={(allowWrite) => void runAction({ enabled: true, allowWrite })} />
                        </SettingRow>
                        {status.running && status.url && <p className="text-xs font-mono break-all">{status.url}</p>}
                        <p className="text-xs text-muted-foreground">{t('settings.mcpCopyHint')}</p>
                        <div className="flex flex-wrap gap-2">
                            <button type="button" className={actionClass} disabled={busy || !status.running || !status.token}
                                onClick={() => void runAction(undefined, true)}>{t('settings.mcpCopy')}</button>
                            <button type="button" className={actionClass} disabled={busy}
                                onClick={() => void runAction({ enabled: true, allowWrite: status.allowWrite, regenerateToken: true })}>{t('settings.mcpRotate')}</button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t('settings.mcpRotateHint')}</p>
                    </>}
                    {feedback && <p className="text-xs" role="status">{t(feedback)}</p>}
                </>}
            </div>
        </SettingsDisclosureCard>
    );
}
