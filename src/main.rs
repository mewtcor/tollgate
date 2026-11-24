#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tollgate_core::{Device, Eero, Schedule};

type E<'a> = State<'a, Arc<Eero>>;

#[tauri::command]
async fn status(e: E<'_>) -> Result<bool, String> {
    Ok(e.status().await)
}

#[tauri::command]
async fn login(e: E<'_>, user: String) -> Result<(), String> {
    e.login(user).await
}

#[tauri::command]
async fn verify(e: E<'_>, code: String) -> Result<(), String> {
    e.verify(code).await
}

#[tauri::command]
async fn logout(e: E<'_>) -> Result<(), String> {
    e.logout().await;
    Ok(())
}

#[tauri::command]
async fn devices(e: E<'_>) -> Result<Vec<Device>, String> {
    e.list().await
}

#[tauri::command]
async fn device_action(e: E<'_>, mac: String, action: String) -> Result<(), String> {
    e.apply(&mac, &action).await
}

#[tauri::command]
async fn pause_for(e: E<'_>, mac: String, minutes: i64) -> Result<(), String> {
    e.pause_for(mac, minutes).await
}

#[tauri::command]
fn get_schedules(e: E<'_>) -> Vec<Schedule> {
    e.schedules()
}

#[tauri::command]
fn set_schedules(e: E<'_>, items: Vec<Schedule>) -> Result<(), String> {
    e.set_schedules(items)
}

#[tauri::command]
fn get_prefs(e: E<'_>) -> Map<String, Value> {
    e.prefs()
}

#[tauri::command]
fn set_pref(e: E<'_>, key: String, value: Value) -> Result<(), String> {
    e.set_pref(&key, value)
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
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(tollgate_core::scheduler(eero, move |ev| {
                let _ = handle.emit("schedule-ran", ev);
            }));
            tray(app)?;
            if !std::env::args().any(|a| a == "--hidden") {
                show(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![status, login, verify, logout, devices, device_action, pause_for, get_schedules, set_schedules, get_prefs, set_pref])
        .run(tauri::generate_context!())
        .expect("failed to run Tollgate");
}
