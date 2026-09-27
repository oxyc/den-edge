//! Tiny static process/cgroup observer copied into the benchmark image.
//! It has no daemon and is only run briefly with `docker exec` between samples.

use std::fs;

fn number(path: &str) -> u64 {
    fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn status(name: &str) -> u64 {
    fs::read_to_string("/proc/1/status")
        .ok()
        .and_then(|body| {
            body.lines()
                .find(|line| line.starts_with(name))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse::<u64>().ok())
        })
        .unwrap_or(0)
}

fn event(name: &str) -> u64 {
    fs::read_to_string("/sys/fs/cgroup/memory.events")
        .ok()
        .and_then(|body| {
            body.lines().find_map(|line| {
                let (key, value) = line.split_once(' ')?;
                (key == name).then(|| value.parse::<u64>().ok()).flatten()
            })
        })
        .unwrap_or(0)
}

fn events_available() -> bool {
    fs::read_to_string("/sys/fs/cgroup/memory.events")
        .ok()
        .map(|body| {
            ["oom", "oom_kill"].iter().all(|wanted| {
                body.lines().any(|line| {
                    line.split_once(' ')
                        .is_some_and(|(key, value)| key == *wanted && value.parse::<u64>().is_ok())
                })
            })
        })
        .unwrap_or(false)
}

fn cpu_ticks() -> u64 {
    let Ok(stat) = fs::read_to_string("/proc/1/stat") else { return 0 };
    // comm is parenthesized and may contain spaces. Fields after it begin with field 3.
    let Some((_, tail)) = stat.rsplit_once(") ") else { return 0 };
    let fields: Vec<&str> = tail.split_whitespace().collect();
    fields.get(11).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
        + fields.get(12).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
}

fn tcp_established(path: &str) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|body| body.lines().skip(1).filter(|line| line.split_whitespace().nth(3) == Some("01")).count())
        .unwrap_or(0)
}

fn upstream_established(path: &str) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|body| {
            body.lines()
                .skip(1)
                .filter(|line| {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    fields.get(3) == Some(&"01")
                        && fields.get(2).and_then(|remote| remote.rsplit_once(':')).map(|(_, port)| port)
                            == Some("2382") // 9090
                })
                .count()
        })
        .unwrap_or(0)
}

fn main() {
    let fds = fs::read_dir("/proc/1/fd").map(|entries| entries.count()).unwrap_or(0);
    let current = number("/sys/fs/cgroup/memory.current");
    let peak = number("/sys/fs/cgroup/memory.peak");
    println!(
        "cgroup_events_available={}",
        u8::from(events_available())
    );
    println!("rss_bytes={}", status("VmRSS:") * 1024);
    println!("cgroup_current_bytes={current}");
    println!("cgroup_peak_bytes={peak}");
    println!("cgroup_events_low={}", event("low"));
    println!("cgroup_events_high={}", event("high"));
    println!("cgroup_events_max={}", event("max"));
    println!("cgroup_events_oom={}", event("oom"));
    println!("cgroup_events_oom_kill={}", event("oom_kill"));
    println!("cgroup_events_oom_group_kill={}", event("oom_group_kill"));
    println!("fd_count={fds}");
    println!("tcp_established={}", tcp_established("/proc/1/net/tcp") + tcp_established("/proc/1/net/tcp6"));
    println!(
        "upstream_established={}",
        upstream_established("/proc/1/net/tcp") + upstream_established("/proc/1/net/tcp6")
    );
    println!("cpu_ticks={}", cpu_ticks());
}
