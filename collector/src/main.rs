use dockbench_collector::sample::{Sampler, SamplerCfg};
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

impl Config {
    pub fn sampler(&self) -> SamplerCfg {
        SamplerCfg { proc_root: PathBuf::from("/proc"), cg_root: PathBuf::from("/sys/fs/cgroup"), docker_sock: self.docker_sock.clone(), interval_ms: self.interval_ms }
    }
}

fn main() {
    let cfg = Config::from_env();
    if env::args().any(|a| a == "--once") {
        let mut s = Sampler::new(cfg.sampler());
        s.tick();
        std::thread::sleep(std::time::Duration::from_millis(cfg.interval_ms));
        match s.tick() {
            Some(snap) => println!("{}", serde_json::to_string(&snap).unwrap()),
            None => {
                eprintln!("dockbench-collector: cannot read /proc");
                std::process::exit(1);
            }
        }
    }
}
