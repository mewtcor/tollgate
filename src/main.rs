#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

const HOST: &str = "https://api-user.e2ro.com";
const UA: &str = "eero-ios/2026.8.1 (iPhone; iOS 18.5)";
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
}

#[derive(Serialize, Deserialize, Clone)]
struct Schedule {
    mac: String,
    action: String,
    time: String,
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
        Eero {
            http: Client::new(),
            dir,
            st: Mutex::new(Inner { token, ..Default::default() }),
        }
    }

    async fn call(&self, method: Method, url: &str, token: Option<&str>, body: Body) -> Result<Value, String> {
        let mut rb = self
            .http
            .request(method, url)
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
        Ok(list
            .iter()
            .map(|d| {
                let mac = s(d, "mac");
                let name = [s(d, "nickname"), s(d, "display_name"), s(d, "hostname")].into_iter().find(|x| !x.is_empty()).unwrap_or_else(|| mac.clone());
                Device {
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
fn get_schedules(e: State<'_, Arc<Eero>>) -> Vec<Schedule> {
    e.schedules()
}

#[tauri::command]
fn set_schedules(e: State<'_, Arc<Eero>>, items: Vec<Schedule>) -> Result<(), String> {
    for i in &items {
        chrono::NaiveTime::parse_from_str(&i.time, "%H:%M").map_err(|_| "Time must be HH:MM")?;
        if !valid_mac(&i.mac) || !ACTIONS.contains(&i.action.as_str()) {
            return Err("Bad schedule".into());
        }
    }
    fs::create_dir_all(&e.dir).map_err(|x| x.to_string())?;
    fs::write(e.dir.join("schedules.json"), serde_json::to_string_pretty(&items).unwrap()).map_err(|x| x.to_string())
}

async fn scheduler(app: AppHandle, e: Arc<Eero>) {
    let mut last = String::new();
    loop {
        let now = chrono::Local::now().format("%H:%M").to_string();
        if now != last && e.st.lock().await.token.is_some() {
            last = now.clone();
            for sc in e.schedules().into_iter().filter(|x| x.time == now) {
                let ok = e.apply(&sc.mac, &sc.action).await;
                let _ = app.emit("schedule-ran", json!({ "mac": sc.mac, "action": sc.action, "error": ok.err() }));
            }
        }
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let eero = Arc::new(Eero::new(dir));
            app.manage(eero.clone());
            tauri::async_runtime::spawn(scheduler(app.handle().clone(), eero));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![status, login, verify, logout, devices, device_action, get_schedules, set_schedules])
        .run(tauri::generate_context!())
        .expect("failed to run eero widget");
}
