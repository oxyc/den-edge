//! Tiny static process/cgroup observer copied into the benchmark image.
//! It has no daemon and is only run briefly with `docker exec` between samples.

use std::fs;
use std::io::{self, ErrorKind};

fn invalid(path: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, format!("invalid numeric value in {path}"))
}

fn number(path: &str) -> io::Result<u64> {
    fs::read_to_string(path)?.trim().parse().map_err(|_| invalid(path))
}

fn status(name: &str) -> io::Result<u64> {
    let path = "/proc/1/status";
    fs::read_to_string(path)?
        .lines()
        .find(|line| line.starts_with(name))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| invalid(path))
}

fn events() -> io::Result<std::collections::HashMap<String, u64>> {
    let path = "/sys/fs/cgroup/memory.events";
    let mut values = std::collections::HashMap::new();
    for line in fs::read_to_string(path)?.lines() {
        let (key, value) = line.split_once(' ').ok_or_else(|| invalid(path))?;
        values.insert(key.to_owned(), value.parse().map_err(|_| invalid(path))?);
    }
    for key in ["low", "high", "max", "oom", "oom_kill", "oom_group_kill"] {
        if !values.contains_key(key) {
            return Err(invalid(path));
        }
    }
    Ok(values)
}

fn memory_stat() -> io::Result<std::collections::HashMap<String, u64>> {
    let path = "/sys/fs/cgroup/memory.stat";
    let mut values = std::collections::HashMap::new();
    for line in fs::read_to_string(path)?.lines() {
        let (key, value) = line.split_once(' ').ok_or_else(|| invalid(path))?;
        values.insert(key.to_owned(), value.parse().map_err(|_| invalid(path))?);
    }
    for key in ["anon", "file"] {
        if !values.contains_key(key) {
            return Err(invalid(path));
        }
    }
    Ok(values)
}

fn cpu_ticks() -> io::Result<u64> {
    let path = "/proc/1/stat";
    let stat = fs::read_to_string(path)?;
    // comm is parenthesized and may contain spaces. Fields after it begin with field 3.
    let (_, tail) = stat.rsplit_once(") ").ok_or_else(|| invalid(path))?;
    let fields: Vec<&str> = tail.split_whitespace().collect();
    let user = fields.get(11).and_then(|v| v.parse::<u64>().ok()).ok_or_else(|| invalid(path))?;
    let system = fields.get(12).and_then(|v| v.parse::<u64>().ok()).ok_or_else(|| invalid(path))?;
    Ok(user + system)
}

fn tcp_established(path: &str) -> io::Result<usize> {
    Ok(fs::read_to_string(path)?
        .lines().skip(1).filter(|line| line.split_whitespace().nth(3) == Some("01")).count())
}

fn upstream_established(path: &str) -> io::Result<usize> {
    Ok(fs::read_to_string(path)?
        .lines()
        .skip(1)
        .filter(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            fields.get(3) == Some(&"01")
                && fields.get(2).and_then(|remote| remote.rsplit_once(':')).map(|(_, port)| port)
                    == Some("2382") // 9090
        })
        .count())
}

fn main() -> io::Result<()> {
    let fds = fs::read_dir("/proc/1/fd")?.collect::<Result<Vec<_>, _>>()?.len();
    let current = number("/sys/fs/cgroup/memory.current")?;
    let peak = number("/sys/fs/cgroup/memory.peak")?;
    let events = events()?;
    let memory = memory_stat()?;
    println!("cgroup_events_available=1");
    println!("rss_bytes={}", status("VmRSS:")? * 1024);
    println!("cgroup_current_bytes={current}");
    println!("cgroup_anon_bytes={}", memory["anon"]);
    println!("cgroup_file_bytes={}", memory["file"]);
    println!("memory_max_bytes={}", number("/sys/fs/cgroup/memory.max")?);
    println!("memory_swap_max_bytes={}", number("/sys/fs/cgroup/memory.swap.max")?);
    println!("cgroup_peak_bytes={peak}");
    for key in ["low", "high", "max", "oom", "oom_kill", "oom_group_kill"] {
        println!("cgroup_events_{key}={}", events[key]);
    }
    println!("fd_count={fds}");
    println!("tcp_established={}", tcp_established("/proc/1/net/tcp")? + tcp_established("/proc/1/net/tcp6")?);
    println!(
        "upstream_established={}",
        upstream_established("/proc/1/net/tcp")? + upstream_established("/proc/1/net/tcp6")?
    );
    println!("cpu_ticks={}", cpu_ticks()?);
    Ok(())
}
