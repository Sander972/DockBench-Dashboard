use dockbench_collector::proc;
use std::env;
use std::path::PathBuf;

/// Runtime settings from the environment, with the defaults of the compose service.
#[derive(Debug, Clone)]
pub struct Config {
    pub interval_ms: u64,
    pub history_step_ms: u64,
    pub history_hours: u64,
    pub data_dir: PathBuf,
    pub docker_sock: PathBuf,
    pub port: u16,
}

fn num<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            interval_ms: num("INTERVAL_MS", 2000),
            history_step_ms: num("HISTORY_STEP_MS", 10_000),
            history_hours: num("HISTORY_HOURS", 24),
            data_dir: PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into())),
            docker_sock: PathBuf::from(env::var("DOCKER_SOCK").unwrap_or_else(|_| "/var/run/docker.sock".into())),
            port: num("PORT", 9100),
        }
    }
}

fn main() {
    let _cfg = Config::from_env();
    if env::args().any(|a| a == "--once") {
        match proc::read_host() {
            Ok(h) => println!("{}", serde_json::to_string(&h).unwrap()),
            Err(e) => {
                eprintln!("dockbench-collector: {e}");
                std::process::exit(1);
            }
        }
    }
}
