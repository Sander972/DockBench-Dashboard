//! The history budget: a full 24 h ring of a busy host stays under 50 MB of heap and its file under 100 MB at twice the window.

use dockbench_collector::history::{ContainerPoint, History, HostPoint, Point, TopEntry};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicIsize, Ordering};

struct Counting;
static LIVE: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        LIVE.fetch_add(l.size() as isize, Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size() as isize, Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static A: Counting = Counting;

/// Busier than the VPS: 15 containers, 6 of them dev containers with the full 6 top names of 3 pids each, 9 small ones with 2 names, plus a full host group.
fn busy_point(t: u64) -> Point {
    let mut containers = HashMap::new();
    let mut top = HashMap::new();
    for c in 0..16u32 {
        let id = if c == 15 { "host".to_string() } else { format!("{c:064x}") };
        if c < 15 {
            containers.insert(id.clone(), ContainerPoint { name: format!("dockbench-project-{c}"), cpu_pct: 12.345678, mem_used: 1_234_567_890 });
        }
        let names = if c < 6 || c == 15 { 6 } else { 2 };
        let entries = (0..names).map(|i| TopEntry { comm: format!("proc-name-{i}"), pids: vec![100_000 + i, 200_000 + i, 300_000 + i], cpu_pct: 3.14159, rss: 123_456_789 }).collect();
        top.insert(id, entries);
    }
    Point { t, host: HostPoint { cpu_pct: 55.5555, steal_pct: 1.2345, mem_used: 9_876_543_210, load1: 21.37 }, containers, top }
}

#[test]
fn a_full_day_fits_the_budget() {
    let dir = std::env::temp_dir().join(format!("dbc-budget-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let points = 24 * 3600 / 10;
    let t0 = dockbench_collector::history::now_ms() - points * 10_000;
    let before = LIVE.load(Ordering::Relaxed);
    let mut h = History::open(&dir, 24 * 3_600_000);
    for i in 0..points {
        h.push(busy_point(t0 + i * 10_000));
    }
    let heap = LIVE.load(Ordering::Relaxed) - before;
    let file = std::fs::metadata(dir.join("history.jsonl")).unwrap().len() * 2;
    eprintln!("ring of {} points: {} MB heap, file at twice the window {} MB", h.ring.len(), heap >> 20, file >> 20);
    assert_eq!(h.ring.len() as u64, points);
    assert!(heap < 50 << 20, "ring {} MB", heap >> 20);
    assert!(file < 100 << 20, "file {} MB", file >> 20);
    std::fs::remove_dir_all(dir).unwrap();
}
