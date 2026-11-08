use dockbench_collector::history::{History, Point};
use dockbench_collector::http::{self, State};
use dockbench_collector::sample::{Sampler, SamplerCfg, Snapshot};
use std::env;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

    pub fn sampler(&self) -> SamplerCfg {
        SamplerCfg { proc_root: PathBuf::from("/proc"), cg_root: PathBuf::from("/sys/fs/cgroup"), docker_sock: self.docker_sock.clone(), interval_ms: self.interval_ms }
    }
}

/// Samples every interval forever: the latest snapshot for /metrics, and one history point per full step.
fn sample_loop(cfg: Config, state: Arc<State>) {
    let mut sampler = Sampler::new(cfg.sampler());
    let interval = Duration::from_millis(cfg.interval_ms);
    // the samples of the step in progress, folded into one history point when the step is full
    let mut pending: Vec<Snapshot> = Vec::new();
    loop {
        let started = Instant::now();
        if let Some(snap) = sampler.tick() {
            *state.latest.lock().unwrap_or_else(|e| e.into_inner()) = Some(snap.clone());
            pending.push(snap);
            let span = pending.last().unwrap().at - pending[0].at + cfg.interval_ms;
            if span >= cfg.history_step_ms {
                let point = Point::from_samples(&pending);
                pending.clear();
                state.history.lock().unwrap_or_else(|e| e.into_inner()).push(point);
            }
        }
        std::thread::sleep(interval.saturating_sub(started.elapsed()));
    }
}

fn main() {
    let cfg = Config::from_env();
    if env::args().any(|a| a == "--once") {
        let mut s = Sampler::new(cfg.sampler());
        s.tick();
        std::thread::sleep(Duration::from_millis(cfg.interval_ms));
        match s.tick() {
            Some(snap) => println!("{}", serde_json::to_string(&snap).unwrap()),
            None => {
                eprintln!("dockbench-collector: cannot read /proc");
                std::process::exit(1);
            }
        }
        return;
    }
    let listener = TcpListener::bind(("0.0.0.0", cfg.port)).unwrap_or_else(|e| {
        eprintln!("dockbench-collector: cannot listen on :{}: {e}", cfg.port);
        std::process::exit(1);
    });
    let history = History::open(&cfg.data_dir, cfg.history_hours * 3_600_000);
    let state = Arc::new(State::new(history));
    eprintln!("dockbench-collector listening on :{}, interval {} ms, step {} ms, keep {} h", cfg.port, cfg.interval_ms, cfg.history_step_ms, cfg.history_hours);
    let s = state.clone();
    std::thread::spawn(move || sample_loop(cfg, s));
    http::serve(listener, state);
}
