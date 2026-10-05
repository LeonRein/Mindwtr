//! Device-local, opt-in lifecycle for the bundled MCP helper. The helper only
//! reaches the existing native write path through a private Local API bridge.
use crate::config::read_config_verified;
use crate::local_api::{start_private_mcp_api_bridge, LocalApiServerState, PrivateMcpApiBridge};
use crate::{
    get_config_path, get_secrets_path, lock_config_read_modify_write, write_config_files,
    AppConfigToml,
};
use rand::RngCore;
use serde::Serialize;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MCP_HOST: &str = "127.0.0.1";
const MCP_PORT: u16 = 8722;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_GRACE: Duration = Duration::from_millis(200);
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_LINE_LIMIT: usize = 4096;

#[derive(Clone, Default, PartialEq, Eq)]
struct McpConfig {
    enabled: bool,
    allow_write: bool,
    token: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpError {
    HelperMissing,
    PortInUse,
    StartFailed,
    Exited,
    ConfigFailed,
    #[cfg(any(target_os = "macos", test))]
    UnsupportedOs,
}

impl McpError {
    fn code(self) -> &'static str {
        match self {
            Self::HelperMissing => "helper_missing",
            Self::PortInUse => "port_in_use",
            Self::StartFailed => "start_failed",
            Self::Exited => "exited",
            Self::ConfigFailed => "config_failed",
            #[cfg(any(target_os = "macos", test))]
            Self::UnsupportedOs => "unsupported_os",
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_mcp_support(version: Option<&str>) -> Result<(), McpError> {
    let version = version.ok_or(McpError::UnsupportedOs)?.trim();
    let components = version.split('.').collect::<Vec<_>>();
    if components.is_empty()
        || components.len() > 3
        || components.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || part.parse::<u32>().is_err()
        })
    {
        return Err(McpError::UnsupportedOs);
    }
    if components[0]
        .parse::<u32>()
        .map_err(|_| McpError::UnsupportedOs)?
        < 13
    {
        return Err(McpError::UnsupportedOs);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_support() -> Result<(), McpError> {
    // This guard is specific to the Bun helper; keep the host app's older OS
    // support intact. A fixed-size sysctl read avoids process launch/timeouts.
    let mut version = [0_u8; 64];
    let mut length = version.len();
    let result = unsafe {
        libc::sysctlbyname(
            b"kern.osproductversion\0".as_ptr().cast(),
            version.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length == 0 || length > version.len() {
        return Err(McpError::UnsupportedOs);
    }
    let bytes = version[..length]
        .strip_suffix(&[0])
        .ok_or(McpError::UnsupportedOs)?;
    macos_mcp_support(std::str::from_utf8(bytes).ok())
}

#[cfg(not(target_os = "macos"))]
fn platform_support() -> Result<(), McpError> {
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatus {
    enabled: bool,
    running: bool,
    allow_write: bool,
    port: u16,
    url: Option<String>,
    token: Option<String>,
    error: Option<String>,
}

fn lock_recovering<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn config_from_toml(config: &AppConfigToml) -> McpConfig {
    let enabled =
        |value: Option<&String>| value.is_some_and(|raw| raw.trim().eq_ignore_ascii_case("true"));
    McpConfig {
        enabled: enabled(config.mcp_enabled.as_ref()),
        allow_write: enabled(config.mcp_allow_write.as_ref()),
        token: config
            .mcp_token
            .as_ref()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty()),
    }
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn apply_config(config: &mut AppConfigToml, next: &McpConfig) {
    config.mcp_enabled = Some(next.enabled.to_string());
    config.mcp_allow_write = Some(next.allow_write.to_string());
    config.mcp_token = next.token.clone();
}

fn read_mcp_config(app: &tauri::AppHandle) -> Result<McpConfig, McpError> {
    // read_config can migrate legacy secrets and publish a repaired pair.
    // Protect that possible write from concurrent settings transactions too.
    let _guard = lock_config_read_modify_write().map_err(|_| McpError::ConfigFailed)?;
    read_config_verified(app)
        .map(|config| config_from_toml(&config))
        .map_err(|_| McpError::ConfigFailed)
}

/// The outer RMW lock remains held across read, token creation, and publication;
/// unrelated Local API/sync/settings fields cannot be overwritten by a stale
/// snapshot. Persistence always precedes starting a new child.
fn update_config(
    app: &tauri::AppHandle,
    requested: Option<(bool, bool, bool)>,
) -> Result<McpConfig, McpError> {
    let _guard = lock_config_read_modify_write().map_err(|_| McpError::ConfigFailed)?;
    update_config_with(
        || read_config_verified(app),
        requested,
        |config| write_config_files(&get_config_path(app), &get_secrets_path(app), config),
    )
}

fn update_config_with(
    read: impl FnOnce() -> Result<AppConfigToml, String>,
    requested: Option<(bool, bool, bool)>,
    write: impl FnOnce(&AppConfigToml) -> Result<(), String>,
) -> Result<McpConfig, McpError> {
    let mut stored = read().map_err(|_| McpError::ConfigFailed)?;
    let mut next = config_from_toml(&stored);
    if let Some((enabled, allow_write, regenerate)) = requested {
        next.enabled = enabled;
        next.allow_write = allow_write;
        if regenerate {
            next.token = Some(generate_token());
        }
    }
    if next.enabled && next.token.is_none() {
        next.token = Some(generate_token());
    }
    if requested.is_some() || next != config_from_toml(&stored) {
        apply_config(&mut stored, &next);
        write(&stored).map_err(|_| McpError::ConfigFailed)?;
    }
    Ok(next)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupEvent {
    Ready,
    Failed(McpError),
}

fn parse_startup_line(line: &[u8]) -> Option<StartupEvent> {
    let event: serde_json::Value = serde_json::from_slice(line).ok()?;
    match event.get("event").and_then(serde_json::Value::as_str) {
        Some("mindwtr-mcp-ready")
            if event.get("port").and_then(serde_json::Value::as_u64) == Some(MCP_PORT as u64) =>
        {
            Some(StartupEvent::Ready)
        }
        Some("mindwtr-mcp-error") => match event.get("code").and_then(serde_json::Value::as_str) {
            Some("port_in_use") => Some(StartupEvent::Failed(McpError::PortInUse)),
            Some("start_failed") => Some(StartupEvent::Failed(McpError::StartFailed)),
            _ => None,
        },
        _ => None,
    }
}

/// Drain continuously to prevent a full pipe from stalling the helper, but
/// retain at most one bounded line and never forward its contents to logs.
fn drain_stderr(mut stderr: impl Read, events: mpsc::SyncSender<StartupEvent>) {
    let mut chunk = [0_u8; 1024];
    let mut line = Vec::with_capacity(STDERR_LINE_LIMIT);
    let mut overflow = false;
    loop {
        let read = match stderr.read(&mut chunk) {
            Ok(read) => read,
            Err(_) => return,
        };
        if read == 0 {
            if !overflow {
                if let Some(event) = parse_startup_line(&line) {
                    let _ = events.try_send(event);
                }
            }
            return;
        }
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                if !overflow {
                    if let Some(event) = parse_startup_line(&line) {
                        let _ = events.try_send(event);
                    }
                }
                line.clear();
                overflow = false;
            } else if line.len() < STDERR_LINE_LIMIT && !overflow {
                line.push(*byte);
            } else {
                overflow = true;
            }
        }
    }
}

/// Kept independent of AppHandle so timeout, EOF, crash, and reaping behavior
/// can be exercised with real fixture processes.
struct ManagedProcess {
    child: Option<Child>,
    lease: Option<ChildStdin>,
}

impl ManagedProcess {
    fn start(
        command: &mut Command,
        timeout: Duration,
        shutdown: Option<&AtomicBool>,
    ) -> Result<Self, McpError> {
        if shutdown.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err(McpError::StartFailed);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(crate::CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|_| McpError::StartFailed)?;
        let lease = child.stdin.take();
        let stderr = child.stderr.take();
        let mut process = Self {
            child: Some(child),
            lease,
        };
        let Some(stderr) = stderr else {
            return Err(McpError::StartFailed);
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || drain_stderr(stderr, sender));
        let deadline = Instant::now() + timeout;
        loop {
            if shutdown.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(McpError::StartFailed);
            }
            match receiver.try_recv() {
                Ok(StartupEvent::Ready) if process.is_running() => return Ok(process),
                Ok(StartupEvent::Failed(error)) => return Err(error),
                Ok(StartupEvent::Ready) => return Err(McpError::StartFailed),
                Err(_) => {}
            }
            if !process.is_running() || Instant::now() >= deadline {
                return Err(McpError::StartFailed);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn is_running(&mut self) -> bool {
        match self.child.as_mut().map(Child::try_wait) {
            Some(Ok(None)) => true,
            Some(Ok(Some(_))) => {
                self.child.take(); // try_wait has already reaped it.
                self.lease.take();
                false
            }
            Some(Err(_)) => {
                self.stop();
                false
            }
            None => false,
        }
    }

    fn wait_until(child: &mut Child, deadline: Instant) -> bool {
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Err(_) => return false,
                Ok(None) => thread::sleep(Duration::from_millis(10)),
            }
        }
        false
    }

    fn stop(&mut self) {
        self.lease.take(); // EOF asks the helper to close HTTP and exit.
        let Some(mut child) = self.child.take() else {
            return;
        };
        if Self::wait_until(&mut child, Instant::now() + STOP_GRACE) {
            return;
        }
        let _ = child.kill();
        if !Self::wait_until(&mut child, Instant::now() + REAP_TIMEOUT) {
            // SIGKILL/TerminateProcess has been requested. An exceptional OS
            // stall must not block quit; retain ownership in a background
            // reaper rather than leaking a zombie when the OS unblocks.
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn helper_path_for(executable: &Path, debug_target: Option<&str>) -> Result<PathBuf, McpError> {
    let directory = executable.parent().ok_or(McpError::HelperMissing)?;
    let suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let installed = directory.join(format!("mindwtr-mcp{suffix}"));
    if installed.is_file() {
        return Ok(installed);
    }
    if let Some(target) = debug_target {
        let debug = directory.join(format!("mindwtr-mcp-{target}{suffix}"));
        if debug.is_file() {
            return Ok(debug);
        }
    }
    Err(McpError::HelperMissing)
}

fn helper_path() -> Result<PathBuf, McpError> {
    let executable = std::env::current_exe().map_err(|_| McpError::HelperMissing)?;
    let target = if cfg!(debug_assertions) {
        option_env!("MINDWTR_TARGET_TRIPLE")
    } else {
        None
    };
    helper_path_for(&executable, target)
}

fn check_port_available(port: u16) -> Result<(), McpError> {
    TcpListener::bind((MCP_HOST, port))
        .map(|_| ())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                McpError::PortInUse
            } else {
                McpError::StartFailed
            }
        })
}

fn helper_command(
    path: &Path,
    config: &McpConfig,
    api_url: &str,
    api_token: &str,
) -> Result<Command, McpError> {
    let token = config.token.as_deref().ok_or(McpError::ConfigFailed)?;
    let mut command = Command::new(path);
    command
        .current_dir(path.parent().ok_or(McpError::HelperMissing)?)
        .env_remove("BUN_BE_BUN")
        .env_remove("BUN_OPTIONS")
        .env_remove("NODE_OPTIONS")
        .env("MINDWTR_MCP_API_URL", api_url)
        .env("MINDWTR_MCP_API_TOKEN", api_token)
        .env("MINDWTR_MCP_HTTP_PORT", MCP_PORT.to_string())
        .env("MINDWTR_MCP_HTTP_TOKEN", token)
        .env("MINDWTR_MCP_ALLOW_WRITE", config.allow_write.to_string());
    Ok(command)
}

#[derive(Default)]
struct McpRuntime {
    process: Option<ManagedProcess>,
    bridge: Option<PrivateMcpApiBridge>,
    applied_config: Option<McpConfig>,
    last_error: Option<McpError>,
}

impl McpRuntime {
    fn fail(&mut self, error: McpError) {
        self.stop();
        self.last_error = Some(error);
    }

    fn status_after_read(
        &mut self,
        config: Result<McpConfig, McpError>,
        support: Result<(), McpError>,
    ) -> McpServerStatus {
        self.refresh();
        match config {
            Err(error) => {
                self.fail(error);
                self.status(McpConfig::default())
            }
            Ok(config) => {
                if self.process.is_some() && self.applied_config.as_ref() != Some(&config) {
                    // A verified out-of-band disable, credential rotation, or
                    // policy edit must revoke the old instance before showing
                    // the new config. Status reads never automatically restart.
                    self.stop();
                    self.last_error = config.enabled.then_some(McpError::Exited);
                }
                if let Err(error) = support {
                    self.fail(error);
                }
                self.status(config)
            }
        }
    }

    fn stop(&mut self) {
        // Terminate the public endpoint before revoking its private bridge.
        self.process.take();
        self.bridge.take();
        self.applied_config.take();
    }

    fn refresh(&mut self) {
        if self
            .process
            .as_mut()
            .is_some_and(|child| !child.is_running())
        {
            self.stop();
            self.last_error = Some(McpError::Exited);
        }
    }

    fn start(
        app: &tauri::AppHandle,
        local_api: &LocalApiServerState,
        config: &McpConfig,
        shutdown: &AtomicBool,
    ) -> Result<(ManagedProcess, Option<PrivateMcpApiBridge>), McpError> {
        if shutdown.load(Ordering::SeqCst) {
            return Err(McpError::StartFailed);
        }
        platform_support()?;
        let path = helper_path()?;
        check_port_available(MCP_PORT)?;
        let bridge = start_private_mcp_api_bridge(app.clone(), local_api, config.allow_write)
            .map_err(|_| McpError::StartFailed)?;
        let mut command = helper_command(&path, config, &bridge.url(), bridge.token())?;
        let process = ManagedProcess::start(&mut command, STARTUP_TIMEOUT, Some(shutdown))?;
        log::info!("Managed MCP server ready extra.releaseCheck=v1.3.4/bundled-mcp");
        Ok((process, Some(bridge)))
    }

    fn reconcile(
        &mut self,
        app: &tauri::AppHandle,
        local_api: &LocalApiServerState,
        config: &McpConfig,
        shutdown: &AtomicBool,
    ) {
        self.reconcile_with_support(config, platform_support(), |config| {
            Self::start(app, local_api, config, shutdown)
        });
    }

    fn reconcile_with_support(
        &mut self,
        config: &McpConfig,
        support: Result<(), McpError>,
        start: impl FnOnce(
            &McpConfig,
        ) -> Result<(ManagedProcess, Option<PrivateMcpApiBridge>), McpError>,
    ) {
        if let Err(error) = support {
            self.fail(error);
            return;
        }
        self.reconcile_with(config, start);
    }

    fn reconcile_with(
        &mut self,
        config: &McpConfig,
        start: impl FnOnce(
            &McpConfig,
        ) -> Result<(ManagedProcess, Option<PrivateMcpApiBridge>), McpError>,
    ) {
        self.refresh();
        if !config.enabled {
            self.stop();
            self.last_error = None;
        } else if self.process.is_none() || self.applied_config.as_ref() != Some(config) {
            self.stop();
            match start(config) {
                Ok((process, bridge)) => {
                    self.process = Some(process);
                    self.bridge = bridge;
                    self.applied_config = Some(config.clone());
                    self.last_error = None;
                }
                Err(error) => {
                    self.last_error = Some(error);
                    log::warn!("Managed MCP startup failed code={}", error.code());
                }
            }
        }
    }

    fn status(&self, config: McpConfig) -> McpServerStatus {
        let running = self.process.is_some();
        McpServerStatus {
            enabled: config.enabled,
            running,
            allow_write: config.allow_write,
            port: MCP_PORT,
            url: running.then(|| format!("http://{MCP_HOST}:{MCP_PORT}/mcp")),
            token: if config.enabled { config.token } else { None },
            error: self.last_error.map(|error| error.code().to_string()),
        }
    }
}

impl Drop for McpRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
pub(crate) struct McpServerState {
    inner: Mutex<McpRuntime>,
    shutting_down: AtomicBool,
}

pub(crate) fn start_configured_mcp_server(
    app: &tauri::AppHandle,
    state: &McpServerState,
    local_api: &LocalApiServerState,
) {
    let mut runtime = lock_recovering(&state.inner);
    if state.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    match update_config(app, None) {
        Ok(config) => runtime.reconcile(app, local_api, &config, &state.shutting_down),
        Err(error) => {
            runtime.stop();
            runtime.last_error = Some(error);
            log::warn!("Managed MCP configuration failed code={}", error.code());
        }
    }
}

pub(crate) fn stop_mcp_server(state: &McpServerState) {
    // Signal before waiting for the mutex so a helper still awaiting readiness
    // exits its startup loop promptly. Pending setup cannot restart after quit.
    state.shutting_down.store(true, Ordering::SeqCst);
    lock_recovering(&state.inner).stop();
}

#[tauri::command(async)]
pub(crate) fn get_mcp_server_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpServerState>,
) -> Result<McpServerStatus, String> {
    let mut runtime = lock_recovering(&state.inner);
    Ok(runtime.status_after_read(read_mcp_config(&app), platform_support()))
}

#[tauri::command(async)]
pub(crate) fn set_mcp_server_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpServerState>,
    local_api: tauri::State<'_, LocalApiServerState>,
    enabled: bool,
    allow_write: bool,
    regenerate_token: Option<bool>,
) -> Result<McpServerStatus, String> {
    let mut runtime = lock_recovering(&state.inner);
    if state.shutting_down.load(Ordering::SeqCst) {
        runtime.stop();
        return Ok(runtime.status(read_mcp_config(&app).unwrap_or_default()));
    }
    let support = platform_support();
    if enabled && support.is_err() {
        // Refuse enabling on unsupported systems; disabling still proceeds to
        // the verified config transaction below so an old preference can clear.
        return Ok(runtime.status_after_read(read_mcp_config(&app), support));
    }
    match update_config(
        &app,
        Some((enabled, allow_write, regenerate_token.unwrap_or(false))),
    ) {
        Ok(config) => {
            // Repeating the same config is an explicit retry after exit/failure.
            runtime.reconcile(&app, &local_api, &config, &state.shutting_down);
            Ok(runtime.status(config))
        }
        Err(error) => {
            runtime.stop();
            runtime.last_error = Some(error);
            Ok(runtime.status(read_mcp_config(&app).unwrap_or_default()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_mcp_macos_minimum_version_and_unknown_version_fail_closed() {
        for version in [
            None,
            Some(""),
            Some("10.15.7"),
            Some("12.7.6"),
            Some("13..1"),
            Some("13.1beta"),
            Some("13.0.0.1"),
            Some("4294967296.0"),
        ] {
            assert_eq!(macos_mcp_support(version), Err(McpError::UnsupportedOs));
        }
        for version in [
            "13", "13.0", "13.0.0", "13.6.2", "14.0", "26.0.1", " 13.0.1 ",
        ] {
            assert_eq!(macos_mcp_support(Some(version)), Ok(()));
        }
    }

    #[test]
    fn managed_mcp_unsupported_os_reports_while_disabled_and_refuses_launch() {
        let mut runtime = McpRuntime::default();
        for enabled in [false, true] {
            let config = McpConfig {
                enabled,
                token: Some("fixture-token".into()),
                ..McpConfig::default()
            };
            runtime.reconcile_with_support(&config, Err(McpError::UnsupportedOs), |_| {
                panic!("unsupported OS must never execute the helper")
            });
            let status = runtime.status_after_read(Ok(config), Err(McpError::UnsupportedOs));
            assert_eq!(status.enabled, enabled);
            assert!(!status.running);
            assert_eq!(status.error.as_deref(), Some("unsupported_os"));
        }
        // An unsupported host can still publish an explicit disabled setting.
        let stored = AppConfigToml {
            mcp_enabled: Some("true".into()),
            ..AppConfigToml::default()
        };
        let disabled = update_config_with(
            || Ok(stored),
            Some((false, false, false)),
            |next| {
                assert_eq!(next.mcp_enabled.as_deref(), Some("false"));
                Ok(())
            },
        )
        .unwrap();
        assert!(!disabled.enabled);
    }

    #[test]
    fn managed_mcp_verified_first_launch_defaults_without_a_missing_file_failure() {
        let directory = tempfile::tempdir().unwrap();
        let stored = crate::config::read_config_files_verified(
            &directory.path().join("config.toml"),
            &directory.path().join("secrets.toml"),
        )
        .unwrap();
        assert!(!config_from_toml(&stored).enabled);
        assert!(!config_from_toml(&stored).allow_write);
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_verified_config_drift_revokes_old_listener_without_restart() {
        for change in ["disable", "token", "write", "unsupported"] {
            let directory = tempfile::tempdir().unwrap();
            let config_path = directory.path().join("config.toml");
            let secrets_path = directory.path().join("secrets.toml");
            let mut stored = AppConfigToml {
                mcp_enabled: Some("true".into()),
                mcp_allow_write: Some("false".into()),
                mcp_token: Some("old-token".into()),
                ..AppConfigToml::default()
            };
            write_config_files(&config_path, &secrets_path, &stored).unwrap();
            let mut runtime = McpRuntime::default();
            let mut command = fixture_command(&directory, "printf '{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}\\n' >&2\nwhile read -r line; do :; done");
            runtime.process =
                Some(ManagedProcess::start(&mut command, Duration::from_secs(1), None).unwrap());
            let pid = runtime
                .process
                .as_ref()
                .unwrap()
                .child
                .as_ref()
                .unwrap()
                .id() as i32;
            let bridge = PrivateMcpApiBridge::lifetime_fixture();
            let port: u16 = bridge.url().rsplit(':').next().unwrap().parse().unwrap();
            runtime.bridge = Some(bridge);
            runtime.applied_config = Some(config_from_toml(&stored));
            match change {
                "disable" => stored.mcp_enabled = Some("false".into()),
                "token" => stored.mcp_token = Some("new-token".into()),
                "write" => stored.mcp_allow_write = Some("true".into()),
                "unsupported" => {}
                _ => unreachable!(),
            }
            // A strictly valid file edit is adopted by generation verification.
            let mut public = stored.clone();
            public.mcp_token = None;
            let private = AppConfigToml {
                mcp_token: stored.mcp_token.clone(),
                ..AppConfigToml::default()
            };
            std::fs::write(&config_path, toml::to_string(&public).unwrap()).unwrap();
            std::fs::write(&secrets_path, toml::to_string(&private).unwrap()).unwrap();
            let read = crate::config::read_config_files_verified(&config_path, &secrets_path)
                .map(|stored| config_from_toml(&stored))
                .map_err(|_| McpError::ConfigFailed);
            let support = if change == "unsupported" {
                macos_mcp_support(None)
            } else {
                Ok(())
            };
            let status = runtime.status_after_read(read, support);
            assert!(!status.running);
            assert!(runtime.process.is_none());
            assert!(runtime.bridge.is_none());
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert!(TcpListener::bind((MCP_HOST, port)).is_ok());
            assert!(status.url.is_none());
            if change == "disable" {
                assert!(!status.enabled);
                assert!(status.token.is_none());
                assert!(status.error.is_none());
            } else {
                assert!(status.enabled);
                assert_eq!(
                    status.error.as_deref(),
                    Some(if change == "unsupported" {
                        "unsupported_os"
                    } else {
                        "exited"
                    })
                );
                assert_eq!(status.allow_write, change == "write");
                assert_eq!(
                    status.token.as_deref(),
                    Some(if change == "token" {
                        "new-token"
                    } else {
                        "old-token"
                    })
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_corrupt_or_unreadable_config_revokes_live_child_and_private_bridge() {
        for secrets in [false, true] {
            for unreadable in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let config_path = directory.path().join("config.toml");
                let secrets_path = directory.path().join("secrets.toml");
                let original = AppConfigToml {
                    mcp_enabled: Some("true".into()),
                    mcp_token: Some("live-token".into()),
                    ..AppConfigToml::default()
                };
                write_config_files(&config_path, &secrets_path, &original).unwrap();
                let mut runtime = McpRuntime::default();
                let mut command = fixture_command(&directory, "printf '{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}\\n' >&2\nwhile read -r line; do :; done");
                runtime.process = Some(
                    ManagedProcess::start(&mut command, Duration::from_secs(1), None).unwrap(),
                );
                let pid = runtime
                    .process
                    .as_ref()
                    .unwrap()
                    .child
                    .as_ref()
                    .unwrap()
                    .id() as i32;
                let bridge = PrivateMcpApiBridge::lifetime_fixture();
                let port: u16 = bridge.url().rsplit(':').next().unwrap().parse().unwrap();
                assert!(TcpListener::bind((MCP_HOST, port)).is_err());
                runtime.bridge = Some(bridge);
                runtime.applied_config = Some(config_from_toml(&original));
                let broken_path = if secrets { &secrets_path } else { &config_path };
                if unreadable {
                    std::fs::remove_file(broken_path).unwrap();
                    std::fs::create_dir(broken_path).unwrap(); // Deterministic read failure even for root.
                } else {
                    std::fs::write(broken_path, "mcp_enabled = truncated-value\n").unwrap();
                }
                let before_public = std::fs::read(&config_path).ok();
                let before_secrets = std::fs::read(&secrets_path).ok();
                let read =
                    || crate::config::read_config_files_verified(&config_path, &secrets_path);
                let verified = read()
                    .map(|stored| config_from_toml(&stored))
                    .map_err(|_| McpError::ConfigFailed);
                let status = runtime.status_after_read(verified, Ok(()));
                assert!(!status.enabled);
                assert!(!status.running);
                assert!(status.url.is_none());
                assert!(status.token.is_none());
                assert_eq!(status.error.as_deref(), Some("config_failed"));
                assert_eq!(
                    unsafe { libc::kill(pid, 0) },
                    -1,
                    "old helper must be gone and reaped"
                );
                assert!(runtime.bridge.is_none());
                assert!(
                    TcpListener::bind((MCP_HOST, port)).is_ok(),
                    "private listener must close"
                );
                let update = update_config_with(read, Some((true, true, true)), |_| {
                    panic!("failed verification must never publish defaults")
                });
                assert!(matches!(update, Err(McpError::ConfigFailed)));
                assert_eq!(std::fs::read(&config_path).ok(), before_public);
                assert_eq!(std::fs::read(&secrets_path).ok(), before_secrets);
            }
        }
    }

    #[test]
    fn managed_mcp_defaults_off_and_read_only_and_preserves_local_api() {
        let mut stored = AppConfigToml {
            local_api_enabled: Some("true".into()),
            local_api_port: Some("3457".into()),
            local_api_token: Some("external-secret".into()),
            sync_path: Some("/unrelated/path".into()),
            ..AppConfigToml::default()
        };
        let default = config_from_toml(&stored);
        assert!(!default.enabled);
        assert!(!default.allow_write);
        let next = McpConfig {
            enabled: true,
            token: Some(generate_token()),
            ..default
        };
        apply_config(&mut stored, &next);
        assert_eq!(stored.local_api_token.as_deref(), Some("external-secret"));
        assert_eq!(stored.local_api_port.as_deref(), Some("3457"));
        assert_eq!(stored.local_api_enabled.as_deref(), Some("true"));
        assert_eq!(stored.sync_path.as_deref(), Some("/unrelated/path"));
        assert!(!config_from_toml(&stored).allow_write);
    }

    #[test]
    fn managed_mcp_tokens_are_random_and_hidden_while_disabled() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(token, generate_token());
        let runtime = McpRuntime::default();
        let mut config = McpConfig {
            token: Some(token.clone()),
            ..McpConfig::default()
        };
        assert!(runtime.status(config.clone()).token.is_none());
        config.enabled = true;
        assert_eq!(
            runtime.status(config).token.as_deref(),
            Some(token.as_str())
        );
    }

    #[test]
    fn managed_mcp_startup_parser_only_accepts_fixed_events() {
        assert_eq!(
            parse_startup_line(br#"{"event":"mindwtr-mcp-ready","port":8722}"#),
            Some(StartupEvent::Ready)
        );
        assert_eq!(
            parse_startup_line(br#"{"event":"mindwtr-mcp-ready","port":1234}"#),
            None
        );
        assert_eq!(
            parse_startup_line(br#"{"event":"mindwtr-mcp-error","code":"port_in_use"}"#),
            Some(StartupEvent::Failed(McpError::PortInUse))
        );
        assert_eq!(
            parse_startup_line(br#"{"event":"mindwtr-mcp-error","code":"credential secret"}"#),
            None
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut flood = vec![b'x'; STDERR_LINE_LIMIT * 4];
        flood.extend_from_slice(b"\n{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}\n");
        drain_stderr(flood.as_slice(), sender);
        assert_eq!(receiver.try_recv().unwrap(), StartupEvent::Ready);
    }

    #[test]
    fn managed_mcp_port_in_use_has_a_safe_error() {
        let listener = TcpListener::bind((MCP_HOST, 0)).unwrap();
        assert_eq!(
            check_port_available(listener.local_addr().unwrap().port()),
            Err(McpError::PortInUse)
        );
    }

    #[test]
    fn managed_mcp_helper_lookup_is_adjacent_and_does_not_use_path() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("mindwtr");
        assert_eq!(
            helper_path_for(&executable, None),
            Err(McpError::HelperMissing)
        );
        let suffix = if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        };
        let target = directory
            .path()
            .join(format!("mindwtr-mcp-test-target{suffix}"));
        std::fs::write(&target, b"fixture").unwrap();
        assert_eq!(
            helper_path_for(&executable, Some("test-target")).unwrap(),
            target
        );
        assert_eq!(
            helper_path_for(&executable, None),
            Err(McpError::HelperMissing)
        );
        let installed = directory.path().join(format!("mindwtr-mcp{suffix}"));
        std::fs::write(&installed, b"fixture").unwrap();
        assert_eq!(
            helper_path_for(&executable, Some("test-target")).unwrap(),
            installed
        );
    }

    #[test]
    fn managed_mcp_credentials_are_only_environment_and_write_mode_is_explicit() {
        let config = McpConfig {
            enabled: true,
            allow_write: false,
            token: Some("public-secret".into()),
        };
        let command = helper_command(
            Path::new("/bundled/mindwtr-mcp"),
            &config,
            "http://127.0.0.1:12345",
            "private-secret",
        )
        .unwrap();
        assert_eq!(command.get_args().count(), 0);
        let environment = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            environment["MINDWTR_MCP_HTTP_TOKEN"].as_deref(),
            Some("public-secret")
        );
        assert_eq!(
            environment["MINDWTR_MCP_API_TOKEN"].as_deref(),
            Some("private-secret")
        );
        assert_eq!(
            environment["MINDWTR_MCP_ALLOW_WRITE"].as_deref(),
            Some("false")
        );
        assert_eq!(environment["BUN_BE_BUN"], None);
    }

    #[cfg(unix)]
    fn fixture_command(directory: &tempfile::TempDir, body: &str) -> Command {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.path().join("mindwtr-mcp");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Command::new(path)
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_starts_then_stops_and_reaps_after_stdin_eof() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = fixture_command(&directory, "printf '{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}\\n' >&2\nwhile read -r line; do :; done");
        let mut child = ManagedProcess::start(&mut command, Duration::from_secs(1), None).unwrap();
        assert!(child.is_running());
        child.lease.take(); // Model parent death: all writers of stdin disappear.
        let deadline = Instant::now() + Duration::from_secs(1);
        while child.is_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!child.is_running());
        assert!(child.child.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_readiness_timeout_kills_and_reaps_the_child() {
        let directory = tempfile::tempdir().unwrap();
        let pid_path = directory.path().join("pid");
        let mut command = fixture_command(
            &directory,
            &format!(
                "printf '%s' $$ > '{}'\nwhile :; do :; done",
                pid_path.display()
            ),
        );
        let started = Instant::now();
        assert!(matches!(
            ManagedProcess::start(&mut command, Duration::from_millis(50), None),
            Err(McpError::StartFailed)
        ));
        assert!(started.elapsed() < Duration::from_secs(3));
        let pid: i32 = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "helper must be gone and reaped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_error_exit_and_drop_cleanup_do_not_leave_a_child() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = fixture_command(&directory, "printf '{\"event\":\"mindwtr-mcp-error\",\"code\":\"port_in_use\"}\\n' >&2\nwhile read -r line; do :; done");
        assert!(matches!(
            ManagedProcess::start(&mut command, Duration::from_secs(1), None),
            Err(McpError::PortInUse)
        ));
        let mut command = fixture_command(&directory, "printf '{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}\\n' >&2\nwhile read -r line; do :; done");
        let mut child = ManagedProcess::start(&mut command, Duration::from_secs(1), None).unwrap();
        let pid = child.child.as_ref().unwrap().id() as i32;
        child.child.as_mut().unwrap().kill().unwrap();
        let mut runtime = McpRuntime::default();
        runtime.process = Some(child);
        let deadline = Instant::now() + Duration::from_secs(1);
        while runtime.process.is_some() && Instant::now() < deadline {
            runtime.refresh();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(runtime.process.is_none());
        assert_eq!(runtime.last_error, Some(McpError::Exited));
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        let mut command = fixture_command(
            &directory,
            "printf '{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}\\n' >&2\nwhile :; do :; done",
        );
        let child = ManagedProcess::start(&mut command, Duration::from_secs(1), None).unwrap();
        let pid = child.child.as_ref().unwrap().id() as i32;
        drop(child);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_rotation_write_mode_disable_and_retry_replace_only_the_managed_child() {
        let directory = tempfile::tempdir().unwrap();
        let applied = directory.path().join("applied-config");
        let fixture = fixture_command(&directory, &format!(
            "printf '%s|%s' \"$MINDWTR_MCP_HTTP_TOKEN\" \"$MINDWTR_MCP_ALLOW_WRITE\" > '{}'\nprintf '{{\"event\":\"mindwtr-mcp-ready\",\"port\":8722}}\\n' >&2\nwhile read -r line; do :; done",
            applied.display()
        ));
        let path = PathBuf::from(fixture.get_program());
        let starts = std::cell::Cell::new(0);
        let start = |config: &McpConfig| {
            starts.set(starts.get() + 1);
            let mut command =
                helper_command(&path, config, "http://127.0.0.1:12345", &generate_token())?;
            ManagedProcess::start(&mut command, Duration::from_secs(1), None)
                .map(|process| (process, None))
        };
        let mut runtime = McpRuntime::default();
        let mut config = McpConfig::default();
        runtime.reconcile_with(&config, |_| panic!("disabled must not execute helper"));
        config.enabled = true;
        config.token = Some("initial-token".into());
        runtime.reconcile_with(&config, start);
        assert_eq!(
            std::fs::read_to_string(&applied).unwrap(),
            "initial-token|false"
        );
        let first = runtime
            .process
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id() as i32;
        runtime.reconcile_with(&config, start);
        assert_eq!(
            starts.get(),
            1,
            "unchanged running config must retain child"
        );
        config.token = Some("rotated-token".into());
        runtime.reconcile_with(&config, start);
        assert_eq!(
            unsafe { libc::kill(first, 0) },
            -1,
            "old token's helper must be reaped"
        );
        assert_eq!(
            std::fs::read_to_string(&applied).unwrap(),
            "rotated-token|false"
        );
        let second = runtime
            .process
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id() as i32;
        config.allow_write = true;
        runtime.reconcile_with(&config, start);
        assert_eq!(unsafe { libc::kill(second, 0) }, -1);
        assert_eq!(
            std::fs::read_to_string(&applied).unwrap(),
            "rotated-token|true"
        );
        let third = runtime
            .process
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id() as i32;
        config.enabled = false;
        runtime.reconcile_with(&config, |_| panic!("disable must not execute helper"));
        assert_eq!(unsafe { libc::kill(third, 0) }, -1);
        assert!(runtime.status(config.clone()).token.is_none());
        config.enabled = true;
        runtime.reconcile_with(&config, |_| Err(McpError::PortInUse));
        assert!(runtime.process.is_none());
        assert_eq!(runtime.last_error, Some(McpError::PortInUse));
        runtime.reconcile_with(&config, start); // Same enabled config explicitly retries.
        assert!(runtime.process.is_some());
        assert!(runtime.last_error.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn managed_mcp_quit_cancels_pending_startup_and_prevents_later_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let pid_path = directory.path().join("pid");
        let mut command = fixture_command(
            &directory,
            &format!(
                "printf '%s' $$ > '{}'\nwhile :; do :; done",
                pid_path.display()
            ),
        );
        let shutdown = std::sync::Arc::new(AtomicBool::new(false));
        let quit = shutdown.clone();
        let signal = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            quit.store(true, Ordering::SeqCst);
        });
        let began = Instant::now();
        assert!(matches!(
            ManagedProcess::start(&mut command, STARTUP_TIMEOUT, Some(&shutdown)),
            Err(McpError::StartFailed)
        ));
        signal.join().unwrap();
        assert!(began.elapsed() < Duration::from_secs(2));
        let pid: i32 = std::fs::read_to_string(&pid_path).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        std::fs::remove_file(&pid_path).unwrap();
        assert!(matches!(
            ManagedProcess::start(&mut command, STARTUP_TIMEOUT, Some(&shutdown)),
            Err(McpError::StartFailed)
        ));
        assert!(
            !pid_path.exists(),
            "a pending setup after quit must never spawn"
        );
    }
}
