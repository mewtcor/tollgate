//! Eero client, timers, schedules and saved preferences, shared by the desktop app and the headless server.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};

use chrono::Datelike;
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

const HOST: &str = "https://api-user.e2ro.com";
const UA: &str = concat!("Tollgate/", env!("CARGO_PKG_VERSION"));
const ACTIONS: [&str; 4] = ["pause", "unpause", "block", "unblock"];
/// Keys the UI may store with `set_pref`. They used to live in the desktop window's localStorage.
pub const PREF_KEYS: [&str; 5] = ["nicks", "groups", "seenInfo", "known", "unseen"];

#[derive(Default)]
struct Inner {
    token: Option<String>,
    pending: Option<String>,
    network: Option<String>,
}

pub struct Eero {
    http: Client,
    dir: PathBuf,
    st: Mutex<Inner>,
    timers: std::sync::Mutex<Vec<Timer>>,
    prefs: std::sync::Mutex<()>,
    last_tick: AtomicI64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Timer {
    mac: String,
    resume_at: i64,
}

#[derive(Serialize)]
pub struct Device {
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
pub struct Schedule {
    mac: String,
    action: String,
    time: String,
    /// 0 = Sunday .. 6 = Saturday. Empty means every day, which is also what older schedules.json files hold.
    #[serde(default)]
    days: Vec<u8>,
    #[serde(default = "yes")]
    enabled: bool,
    /// Links the entries of one schedule as the UI shows it: a time range is a pause plus a resume, and a group schedule has entries for every member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rule: Option<String>,
    /// The schedule's name, such as "Bedtime".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// The group the schedule was made for, so the UI can follow changes to its members.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
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

/// Writes a file readable by its owner only on Unix. The eero token in session.txt is as good as a password.
fn write_private(path: &Path, data: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        f.write_all(data.as_bytes())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, data)
    }
}

fn log(msg: impl AsRef<str>) {
    eprintln!("{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg.as_ref());
}

impl Eero {
    pub fn new(dir: PathBuf) -> Self {
        let token = fs::read_to_string(dir.join("session.txt")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let timers = fs::read_to_string(dir.join("timers.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Eero {
            http: Client::new(),
            dir,
            st: Mutex::new(Inner { token, ..Default::default() }),
            timers: std::sync::Mutex::new(timers),
            prefs: std::sync::Mutex::new(()),
            last_tick: AtomicI64::new(0),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn ensure_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|x| x.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }

    fn save_timers(&self, t: &[Timer]) {
        let _ = self.ensure_dir();
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
                log("eero rejected the session (401); signed out until someone signs in again");
            }
        }
        let msg = v["meta"]["error"].as_str().map(str::to_string).unwrap_or_else(|| text.chars().take(160).collect());
        Err(format!("Eero said {}: {msg}", status.as_u16()))
    }

    async fn token(&self) -> Result<String, String> {
        self.st.lock().await.token.clone().ok_or_else(|| "Not signed in".to_string())
    }

    pub async fn status(&self) -> bool {
        self.st.lock().await.token.is_some()
    }

    pub async fn login(&self, user: String) -> Result<(), String> {
        let v = self.call(Method::POST, &format!("{HOST}/2.2/login"), None, Body::Form(vec![("login", user)])).await?;
        let tok = v["data"]["user_token"].as_str().ok_or("Eero did not send a login token")?.to_string();
        self.st.lock().await.pending = Some(tok);
        Ok(())
    }

    pub async fn verify(&self, code: String) -> Result<(), String> {
        let tok = self.st.lock().await.pending.clone().ok_or("Request a code first")?;
        self.call(Method::POST, &format!("{HOST}/2.2/login/verify"), Some(&tok), Body::Form(vec![("code", code)])).await?;
        let mut st = self.st.lock().await;
        st.token = Some(tok.clone());
        st.pending = None;
        self.ensure_dir()?;
        write_private(&self.dir.join("session.txt"), &tok).map_err(|x| x.to_string())?;
        log("signed in");
        Ok(())
    }

    pub async fn logout(&self) {
        *self.st.lock().await = Inner::default();
        let _ = fs::remove_file(self.dir.join("session.txt"));
        log("signed out");
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

    pub async fn list(&self) -> Result<Vec<Device>, String> {
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

    pub async fn apply(&self, mac: &str, action: &str) -> Result<(), String> {
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

    pub async fn pause_for(&self, mac: String, minutes: i64) -> Result<(), String> {
        if !(1..=1440).contains(&minutes) {
            return Err("Timer must be 1 to 1440 minutes".into());
        }
        self.apply(&mac, "pause").await?;
        let mut t = self.timers.lock().unwrap();
        t.push(Timer { mac, resume_at: chrono::Utc::now().timestamp() + minutes * 60 });
        self.save_timers(&t);
        Ok(())
    }

    pub fn schedules(&self) -> Vec<Schedule> {
        fs::read_to_string(self.dir.join("schedules.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn set_schedules(&self, items: Vec<Schedule>) -> Result<(), String> {
        for i in &items {
            chrono::NaiveTime::parse_from_str(&i.time, "%H:%M").map_err(|_| "Time must be HH:MM")?;
            let long = [&i.rule, &i.name, &i.group].iter().any(|v| v.as_ref().is_some_and(|t| t.chars().count() > 64));
            if !valid_mac(&i.mac) || !ACTIONS.contains(&i.action.as_str()) || i.days.iter().any(|&d| d > 6) || long {
                return Err("Bad schedule".into());
            }
        }
        self.ensure_dir()?;
        fs::write(self.dir.join("schedules.json"), serde_json::to_string_pretty(&items).unwrap()).map_err(|x| x.to_string())
    }

    /// Device nicknames, groups and new-device tracking, as one JSON object keyed by `PREF_KEYS`.
    pub fn prefs(&self) -> Map<String, Value> {
        let _g = self.prefs.lock().unwrap();
        self.read_prefs()
    }

    fn read_prefs(&self) -> Map<String, Value> {
        fs::read_to_string(self.dir.join("prefs.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn set_pref(&self, key: &str, value: Value) -> Result<(), String> {
        if !PREF_KEYS.contains(&key) {
            return Err("Unknown setting".into());
        }
        let _g = self.prefs.lock().unwrap();
        let mut p = self.read_prefs();
        p.insert(key.to_string(), value);
        self.ensure_dir()?;
        let tmp = self.dir.join("prefs.json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&p).unwrap()).map_err(|x| x.to_string())?;
        fs::rename(&tmp, self.dir.join("prefs.json")).map_err(|x| x.to_string())
    }

    /// Unix time of the scheduler's last pass, 0 before the first one.
    pub fn last_tick(&self) -> i64 {
        self.last_tick.load(Ordering::Relaxed)
    }
}

/// Runs timers and schedules forever. `notify` gets a `{mac, action, error}` object for each one that ran.
pub async fn scheduler(e: Arc<Eero>, notify: impl Fn(Value) + Send + Sync + 'static) {
    let mut last = String::new();
    loop {
        e.last_tick.store(chrono::Utc::now().timestamp(), Ordering::Relaxed);
        if e.st.lock().await.token.is_some() {
            // a failed resume stays queued and retries on the next tick
            let ts = chrono::Utc::now().timestamp();
            let due: Vec<String> = e.timers.lock().unwrap().iter().filter(|t| t.resume_at <= ts).map(|t| t.mac.clone()).collect();
            for mac in due {
                match e.apply(&mac, "unpause").await {
                    Ok(()) => {
                        log(format!("timer: resumed {mac}"));
                        notify(json!({ "mac": mac, "action": "unpause", "error": Value::Null }));
                    }
                    Err(x) => log(format!("timer: resume {mac} failed, will retry: {x}")),
                }
            }

            let local = chrono::Local::now();
            let now = local.format("%H:%M").to_string();
            if now != last {
                last = now.clone();
                let today = local.weekday().num_days_from_sunday() as u8;
                for sc in e.schedules().into_iter().filter(|x| x.enabled && x.time == now && (x.days.is_empty() || x.days.contains(&today))) {
                    let ok = e.apply(&sc.mac, &sc.action).await;
                    match &ok {
                        Ok(()) => log(format!("schedule {now}: {} {}", sc.action, sc.mac)),
                        Err(x) => log(format!("schedule {now}: {} {} failed: {x}", sc.action, sc.mac)),
                    }
                    notify(json!({ "mac": sc.mac, "action": sc.action, "error": ok.err() }));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
}
