//! Headless Tollgate. Runs the eero timers and schedules around the clock and serves the same UI as the
//! desktop app to any browser. Configured by environment variables, see README.md ("Run it 24/7 on Linux").

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tollgate_core::Eero;

const INDEX: &str = include_str!("../../../ui/index.html");
const APP_JS: &str = include_str!("../../../ui/app.js");
const STYLE: &str = include_str!("../../../ui/style.css");
const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

struct App {
    eero: Arc<Eero>,
    events: broadcast::Sender<Value>,
    password: Option<String>,
}

type Shared = State<Arc<App>>;

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn data_dir() -> PathBuf {
    // systemd sets STATE_DIRECTORY when the unit has StateDirectory=
    env("TOLLGATE_DATA").or_else(|| env("STATE_DIRECTORY").and_then(|d| d.split(':').next().map(str::to_string))).unwrap_or_else(|| "/var/lib/tollgate".into()).into()
}

#[tokio::main]
async fn main() {
    let bind: SocketAddr = env("TOLLGATE_BIND").unwrap_or_else(|| "127.0.0.1:8787".into()).parse().unwrap_or_else(|e| fail(&format!("TOLLGATE_BIND is not an address like 0.0.0.0:8787: {e}")));
    let password = env("TOLLGATE_PASSWORD");
    if password.is_none() && !bind.ip().is_loopback() && env("TOLLGATE_INSECURE").as_deref() != Some("1") {
        fail("set TOLLGATE_PASSWORD before listening on the network, or anyone on your Wi-Fi can pause every device (TOLLGATE_INSECURE=1 skips this check)");
    }

    let dir = data_dir();
    let eero = Arc::new(Eero::new(dir.clone()));
    let (events, _) = broadcast::channel(64);
    let tx = events.clone();
    tokio::spawn(tollgate_core::scheduler(eero.clone(), move |ev| {
        let _ = tx.send(ev);
    }));

    let app = Arc::new(App { eero: eero.clone(), events, password });
    let router = Router::new()
        .route("/", get(|| async { page(INDEX, "text/html; charset=utf-8") }))
        .route("/index.html", get(|| async { page(INDEX, "text/html; charset=utf-8") }))
        .route("/app.js", get(|| async { page(APP_JS, "text/javascript; charset=utf-8") }))
        .route("/style.css", get(|| async { page(STYLE, "text/css; charset=utf-8") }))
        .route("/api/events", get(events_stream))
        .route("/api/{cmd}", post(command))
        .layer(middleware::from_fn_with_state(app.clone(), auth))
        // health stays open so a monitor can poll it without the password; it reveals no account details
        .route("/api/health", get(health))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(bind).await.unwrap_or_else(|e| fail(&format!("cannot listen on {bind}: {e}")));
    eprintln!(
        "Tollgate {} listening on http://{bind}, data in {}, {}",
        env!("CARGO_PKG_VERSION"),
        dir.display(),
        if eero.status().await { "signed in" } else { "not signed in yet" }
    );
    axum::serve(listener, router).with_graceful_shutdown(shutdown()).await.unwrap_or_else(|e| fail(&e.to_string()));
}

fn fail(msg: &str) -> ! {
    eprintln!("tollgate-server: {msg}");
    std::process::exit(1)
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

fn page(body: &'static str, kind: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, kind),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}

/// HTTP basic auth with any user name and TOLLGATE_PASSWORD. Browsers prompt for it once and resend it,
/// including on the event stream.
async fn auth(State(app): Shared, headers: HeaderMap, req: Request, next: Next) -> Response {
    let Some(want) = app.password.as_deref() else { return next.run(req).await };
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Basic "))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b.trim()).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.split_once(':').map(|(_, p)| p.to_string()));
    if given.is_some_and(|g| same(g.as_bytes(), want.as_bytes())) {
        return next.run(req).await;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mut res = (StatusCode::UNAUTHORIZED, "Password required").into_response();
    res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Basic realm=\"Tollgate\", charset=\"UTF-8\""));
    res
}

/// Compares without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn health(State(app): Shared) -> Json<Value> {
    let tick = app.eero.last_tick();
    Json(json!({
        "ok": tick > 0 && chrono::Utc::now().timestamp() - tick < 90,
        "signed_in": app.eero.status().await,
        "last_tick": tick,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn events_stream(State(app): Shared) -> impl IntoResponse {
    let stream = BroadcastStream::new(app.events.subscribe()).filter_map(|ev| ev.ok().map(|v| Ok::<_, std::convert::Infallible>(Event::default().event("schedule-ran").data(v.to_string()))));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn arg<T: DeserializeOwned>(args: &Value, k: &str) -> Result<T, String> {
    serde_json::from_value(args.get(k).cloned().unwrap_or(Value::Null)).map_err(|_| format!("Missing or bad '{k}'"))
}

/// The desktop app's Tauri commands, one per path, with the same JSON arguments and results.
async fn command(State(app): Shared, Path(cmd): Path<String>, body: Bytes) -> Response {
    let args: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).unwrap_or(Value::Null) };
    let e = &app.eero;
    let out: Result<Value, String> = async {
        Ok(match cmd.as_str() {
            "status" => json!(e.status().await),
            "login" => json!(e.login(arg(&args, "user")?).await?),
            "verify" => json!(e.verify(arg(&args, "code")?).await?),
            "logout" => json!(e.logout().await),
            "devices" => json!(e.list().await?),
            "device_action" => json!(e.apply(&arg::<String>(&args, "mac")?, &arg::<String>(&args, "action")?).await?),
            "pause_for" => json!(e.pause_for(arg(&args, "mac")?, arg(&args, "minutes")?).await?),
            "get_schedules" => json!(e.schedules()),
            "set_schedules" => json!(e.set_schedules(arg(&args, "items")?)?),
            "get_prefs" => json!(e.prefs()),
            "set_pref" => json!(e.set_pref(&arg::<String>(&args, "key")?, args.get("value").cloned().unwrap_or(Value::Null))?),
            _ => return Err(format!("Unknown command {cmd}")),
        })
    }
    .await;
    match out {
        Ok(v) => Json(v).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}
