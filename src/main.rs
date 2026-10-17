#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use chrono::Datelike;
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tokio::sync::Mutex;

const HOST: &str = "https://api-user.e2ro.com";
const UA: &str = concat!("Tollgate/", env!("CARGO_PKG_VERSION"));
const ACTIONS: [&str; 4] = ["pause", "unpause", "block", "unblock"];

#[derive(Default)]
struct Inner {
    token: Option<String>,
    pending: Option<String>,
    network: Option<String>,
}

struct Eero {
    http: Client,
    dir: PathBuf,
    st: Mutex<Inner>,
    timers: std::sync::Mutex<Vec<Timer>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Timer {
    mac: String,
    resume_at: i64,
}

#[derive(Serialize)]
struct Device {
    mac: String,
    name: String,
    connected: bool,
    paused: bool,
    blocked: bool,
    ip: String,
    maker: String,
    wired: bool,
    resume_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Schedule {
    mac: String,
    action: String,
    time: String,
    /// 0 = Sunday .. 6 = Saturday. Empty means every day, which is also what older schedules.json files hold.
    #[serde(default)]
    days: Vec<u8>,
    #[serde(default = "yes")]
    enabled: bool,
}

fn yes() -> bool {
    true
}

enum Body {
    None,
    Form(Vec<(&'static str, String)>),
    Json(Value),
}

fn valid_mac(m: &str) -> bool {
    !m.is_empty() && m.len() <= 17 && m.chars().all(|c| c.is_ascii_hexdigit() || c == ':')
}

fn last_segment(url: &str) -> String {
    url.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

impl Eero {
    fn new(dir: PathBuf) -> Self {
        let token = fs::read_to_string(dir.join("session.txt")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let timers = fs::read_to_string(dir.join("timers.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Eero {
            http: Client::new(),
            dir,
            st: Mutex::new(Inner { token, ..Default::default() }),
            timers: std::sync::Mutex::new(timers),
        }
    }

    fn save_timers(&self, t: &[Timer]) {
        let _ = fs::create_dir_all(&self.dir);
        let _ = fs::write(self.dir.join("timers.json"), serde_json::to_string(t).unwrap());
    }

    fn forget_timer(&self, mac: &str) {
        let mut t = self.timers.lock().unwrap();
        let n = t.len();
        t.retain(|x| x.mac != mac);
        if t.len() != n {
            self.save_timers(&t);
        }
    }

    async fn call(&self, method: Method, url: &str, token: Option<&str>, body: Body) -> Result<Value, String> {
        // lets verification point the app at a fake Eero server
        let url = match std::env::var("EERO_HOST") {
            Ok(h) => url.replacen(HOST, &h, 1),
            Err(_) => url.to_string(),
        };
        let mut rb = self
            .http
            .request(method, &url)
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, UA)
            .header(header::ACCEPT_LANGUAGE, "en-US");
        if let Some(t) = token {
            rb = rb.header("X-User-Token", t).header(header::COOKIE, format!("s={t}"));
        }
        rb = match body {
            Body::None => rb,
            Body::Form(f) => rb.form(&f),
            Body::Json(j) => rb.json(&j),
        };
        let res = rb.send().await.map_err(|e| format!("Network error: {e}"))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(v);
        }
        if status.as_u16() == 401 && token.is_some() {
            let mut st = self.st.lock().await;
            if st.pending.is_none() {
                st.token = None;
                let _ = fs::remove_file(self.dir.join("session.txt"));
            }
        }
        let msg = v["meta"]["error"].as_str().map(str::to_string).unwrap_or_else(|| text.chars().take(160).collect());
        Err(format!("Eero said {}: {msg}", status.as_u16()))
    }

    async fn token(&self) -> Result<String, String> {
        self.st.lock().await.token.clone().ok_or_else(|| "Not signed in".to_string())
    }

    async fn network(&self, token: &str) -> Result<String, String> {
        if let Some(n) = self.st.lock().await.network.clone() {
            return Ok(n);
        }
        let from_list = |v: &Value| -> Option<String> {
            let d = &v["data"];
            let list = d.as_array().or_else(|| d["networks"].as_array()).or_else(|| d["networks"]["data"].as_array())?;
            list.first().map(|n| last_segment(n["url"].as_str().unwrap_or("")))
        };
        let mut id = from_list(&self.call(Method::GET, &format!("{HOST}/2.2/networks"), Some(token), Body::None).await?);
        if id.as_deref().map_or(true, str::is_empty) {
            id = from_list(&self.call(Method::GET, &format!("{HOST}/2.2/account"), Some(token), Body::None).await?);
        }
        let id = id.filter(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_digit())).ok_or("No eero network found on this account")?;
        self.st.lock().await.network = Some(id.clone());
        Ok(id)
    }

    async fn list(&self) -> Result<Vec<Device>, String> {
        let t = self.token().await?;
        let n = self.network(&t).await?;
        let v = self.call(Method::GET, &format!("{HOST}/2.2/networks/{n}/devices"), Some(&t), Body::None).await?;
        let list = v["data"].as_array().or_else(|| v["data"]["devices"].as_array()).cloned().unwrap_or_default();
        let timers = self.timers.lock().unwrap().clone();
        Ok(list
            .iter()
            .map(|d| {
                let mac = s(d, "mac");
                let name = [s(d, "nickname"), s(d, "display_name"), s(d, "hostname")].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| mac.clone());
                Device {
                    resume_at: timers.iter().find(|t| t.mac == mac).map(|t| t.resume_at),
                    mac,
                    name,
                    connected: d["connected"].as_bool().unwrap_or(false),
                    paused: d["paused"].as_bool().unwrap_or(false),
                    blocked: d["blacklisted"].as_bool().unwrap_or(false),
                    ip: s(d, "ip"),
                    maker: s(d, "manufacturer"),
                    wired: s(d, "connection_type") == "wired",
                }
            })
            .collect())
    }

    async fn apply(&self, mac: &str, action: &str) -> Result<(), String> {
        if !valid_mac(mac) || !ACTIONS.contains(&action) {
            return Err("Bad device or action".into());
        }
        let t = self.token().await?;
        let n = self.network(&t).await?;
        let t = Some(t.as_str());
        match action {
            // device writes are silently dropped on API 2.2, only 2.3 persists them
            "pause" | "unpause" => {
                let url = format!("{HOST}/2.3/networks/{n}/devices/{mac}");
                self.call(Method::PUT, &url, t, Body::Json(json!({ "paused": action == "pause" }))).await?;
            }
            "block" => {
                let url = format!("{HOST}/2.2/networks/{n}/blacklist");
                self.call(Method::POST, &url, t, Body::Form(vec![("mac", mac.to_string())])).await?;
            }
            _ => {
                let url = format!("{HOST}/2.2/networks/{n}/blacklist/{mac}");
                self.call(Method::DELETE, &url, t, Body::None).await?;
            }
        }
        if action == "pause" || action == "unpause" {
            self.forget_timer(mac);
        }
        Ok(())
    }

    fn schedules(&self) -> Vec<Schedule> {
        fs::read_to_string(self.dir.join("schedules.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
}

#[tauri::command]
async fn status(e: State<'_, Arc<Eero>>) -> Result<bool, String> {
    Ok(e.st.lock().await.token.is_some())
}

#[tauri::command]
async fn login(e: State<'_, Arc<Eero>>, user: String) -> Result<(), String> {
    let v = e.call(Method::POST, &format!("{HOST}/2.2/login"), None, Body::Form(vec![("login", user)])).await?;
    let tok = v["data"]["user_token"].as_str().ok_or("Eero did not send a login token")?.to_string();
    e.st.lock().await.pending = Some(tok);
    Ok(())
}

#[tauri::command]
async fn verify(e: State<'_, Arc<Eero>>, code: String) -> Result<(), String> {
    let tok = e.st.lock().await.pending.clone().ok_or("Request a code first")?;
    e.call(Method::POST, &format!("{HOST}/2.2/login/verify"), Some(&tok), Body::Form(vec![("code", code)])).await?;
    let mut st = e.st.lock().await;
    st.token = Some(tok.clone());
    st.pending = None;
    fs::create_dir_all(&e.dir).map_err(|x| x.to_string())?;
    fs::write(e.dir.join("session.txt"), tok).map_err(|x| x.to_string())
}

#[tauri::command]
async fn logout(e: State<'_, Arc<Eero>>) -> Result<(), String> {
    *e.st.lock().await = Inner::default();
    let _ = fs::remove_file(e.dir.join("session.txt"));
    Ok(())
}

#[tauri::command]
async fn devices(e: State<'_, Arc<Eero>>) -> Result<Vec<Device>, String> {
    e.list().await
}

#[tauri::command]
async fn device_action(e: State<'_, Arc<Eero>>, mac: String, action: String) -> Result<(), String> {
    e.apply(&mac, &action).await
}

#[tauri::command]
async fn pause_for(e: State<'_, Arc<Eero>>, mac: String, minutes: i64) -> Result<(), String> {
    if !(1..=1440).contains(&minutes) {
        return Err("Timer must be 1 to 1440 minutes".into());
    }
    e.apply(&mac, "pause").await?;
    let mut t = e.timers.lock().unwrap();
    t.push(Timer { mac, resume_at: chrono::Utc::now().timestamp() + minutes * 60 });
    e.save_timers(&t);
    Ok(())
}

#[tauri::command]
fn get_schedules(e: State<'_, Arc<Eero>>) -> Vec<Schedule> {
    e.schedules()
}

#[tauri::command]
fn set_schedules(e: State<'_, Arc<Eero>>, items: Vec<Schedule>) -> Result<(), String> {
    for i in &items {
        chrono::NaiveTime::parse_from_str(&i.time, "%H:%M").map_err(|_| "Time must be HH:MM")?;
        if !valid_mac(&i.mac) || !ACTIONS.contains(&i.action.as_str()) || i.days.iter().any(|&d| d > 6) {
            return Err("Bad schedule".into());
        }
    }
    fs::create_dir_all(&e.dir).map_err(|x| x.to_string())?;
    fs::write(e.dir.join("schedules.json"), serde_json::to_string_pretty(&items).unwrap()).map_err(|x| x.to_string())
}

async fn scheduler(app: AppHandle, e: Arc<Eero>) {
    let mut last = String::new();
    loop {
        if e.st.lock().await.token.is_some() {
            // a failed resume stays queued and retries on the next tick
            let ts = chrono::Utc::now().timestamp();
            let due: Vec<String> = e.timers.lock().unwrap().iter().filter(|t| t.resume_at <= ts).map(|t| t.mac.clone()).collect();
            for mac in due {
                if e.apply(&mac, "unpause").await.is_ok() {
                    let _ = app.emit("schedule-ran", json!({ "mac": mac, "action": "unpause", "error": Value::Null }));
                }
            }

            let local = chrono::Local::now();
            let now = local.format("%H:%M").to_string();
            if now != last {
                last = now.clone();
                let today = local.weekday().num_days_from_sunday() as u8;
                for sc in e.schedules().into_iter().filter(|x| x.enabled && x.time == now && (x.days.is_empty() || x.days.contains(&today))) {
                    let ok = e.apply(&sc.mac, &sc.action).await;
                    let _ = app.emit("schedule-ran", json!({ "mac": sc.mac, "action": sc.action, "error": ok.err() }));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn tray(app: &tauri::App) -> tauri::Result<()> {
    let auto = CheckMenuItem::with_id(app, "auto", "Start with Windows", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&MenuItem::with_id(app, "show", "Show", true, None::<&str>)?, &auto, &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?],
    )?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Tollgate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id.as_ref() {
            "show" => show(app),
            "auto" => {
                let a = app.autolaunch();
                let _ = if a.is_enabled().unwrap_or(false) { a.disable() } else { a.enable() };
                let _ = auto.set_checked(a.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .on_window_event(|w, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let eero = Arc::new(Eero::new(dir));
            app.manage(eero.clone());
            tauri::async_runtime::spawn(scheduler(app.handle().clone(), eero));
            tray(app)?;
            if !std::env::args().any(|a| a == "--hidden") {
                show(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![status, login, verify, logout, devices, device_action, pause_for, get_schedules, set_schedules])
        .run(tauri::generate_context!())
        .expect("failed to run Tollgate");
}
