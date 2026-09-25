use crate::filter::RegFilter;
use crate::lk1337;
use perf_event_open_sys as sys;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::task::JoinHandle;

pub fn start_driver_watch<F>(config: &WatchConfig, mut on_hit: F) -> anyhow::Result<RunningWatch>
where
    F: FnMut(crate::perf::SampleData) + Send + 'static,
{
    let driver = std::sync::Arc::new(lk1337::Driver::open()?);
    let typ = match config.ty {
        x if x == sys::bindings::HW_BREAKPOINT_X => lk1337::BP_EXECUTE,
        x if x == sys::bindings::HW_BREAKPOINT_R => lk1337::BP_READ,
        x if x == sys::bindings::HW_BREAKPOINT_W => lk1337::BP_WRITE,
        _ => lk1337::BP_READWRITE,
    };
    let len = if typ == lk1337::BP_EXECUTE {
        4
    } else if config.len == 0 {
        1
    } else {
        config.len as i32
    };
    let mut flags = lk1337::BP_F_DETAIL;
    if config.backtrace {
        flags |= lk1337::BP_F_BACKTRACE;
    }
    let id = driver.create(config.addr, typ, len, config.pid as i32, 256, flags)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let thread_cancel = Arc::clone(&cancel);
    let filter = config.filter.clone();
    let thread = std::thread::spawn(move || {
        let mut consecutive_errors = 0u32;
        while !thread_cancel.load(Ordering::Relaxed) {
            match driver.hits(id) {
                Ok(hits) => {
                    consecutive_errors = 0;
                    for hit in hits {
                        let mut regs = hit.after.regs.to_vec();
                        regs.push(hit.after.sp);
                        regs.push(hit.after.pc);
                        let count = (hit.bt_count as usize).min(lk1337::BT_MAX);
                        let backtrace = (count > 0).then(|| hit.backtrace[..count].to_vec());
                        let data = crate::perf::SampleData {
                            pid: hit.pid as u32,
                            tid: hit.tid as u32,
                            regs,
                            backtrace,
                            simd: hit.after.vregs.to_vec(),
                        };
                        if filter.as_ref().is_none_or(|filter| filter.matches(&data)) {
                            on_hit(data);
                        }
                    }
                }
                Err(error) => {
                    consecutive_errors += 1;
                    log::error!(
                        "LK1337 hit polling failed (consecutive={}): {}",
                        consecutive_errors,
                        error
                    );
                    if consecutive_errors >= 10 {
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = driver.remove(id);
    });
    Ok(RunningWatch {
        cancel,
        tasks: vec![tokio::task::spawn_blocking(move || {
            let _ = thread.join();
        })],
    })
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct WatchConfig {
    pub pid: u32,
    pub thread: bool,
    pub type_name: String,
    pub addr_text: String,
    pub ty: u32,
    pub addr: u64,
    pub len: u64,
    pub backtrace: bool,
    pub buf_size: usize,
    pub filter: Option<RegFilter>,
}

#[derive(Debug, Serialize)]
pub struct WatchStart {
    pub threads: Vec<u32>,
}

pub struct RunningWatch {
    cancel: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}

impl RunningWatch {
    pub async fn stop(self) {
        self.cancel.store(true, Ordering::Relaxed);
        // The driver poll is a blocking ioctl. Detach cleanup so DELETE can
        // acknowledge cancellation without waiting for an in-flight ioctl.
        drop(self.tasks);
    }
}

pub fn parse_len(s: &str) -> Option<u32> {
    match s {
        "1" => Some(sys::bindings::HW_BREAKPOINT_LEN_1),
        "2" => Some(sys::bindings::HW_BREAKPOINT_LEN_2),
        "4" => Some(sys::bindings::HW_BREAKPOINT_LEN_4),
        "8" => Some(sys::bindings::HW_BREAKPOINT_LEN_8),
        "" => Some(sys::bindings::HW_BREAKPOINT_LEN_1),
        _ => None,
    }
}

pub fn parse_watchpoint_type(s: &str) -> Option<(u32, u32)> {
    if let Some(s) = s.strip_prefix("rw") {
        let len = parse_len(s)?;
        Some((sys::bindings::HW_BREAKPOINT_RW, len))
    } else if let Some(s) = s.strip_prefix('r') {
        let len = parse_len(s)?;
        Some((sys::bindings::HW_BREAKPOINT_R, len))
    } else if let Some(s) = s.strip_prefix('w') {
        let len = parse_len(s)?;
        Some((sys::bindings::HW_BREAKPOINT_W, len))
    } else if s == "x" {
        Some((
            sys::bindings::HW_BREAKPOINT_X,
            std::mem::size_of::<nix::libc::c_long>() as u32,
        ))
    } else {
        None
    }
}

pub fn parse_addr(s: &str) -> Option<u64> {
    u64::from_str_radix(s.strip_prefix("0x").unwrap_or(s), 16).ok()
}

pub fn start_watch<F>(
    config: WatchConfig,
    handle_event: F,
) -> anyhow::Result<(WatchStart, RunningWatch)>
where
    F: FnMut(crate::perf::SampleData) + Send + Clone + 'static,
{
    let running = start_driver_watch(&config, handle_event)?;
    Ok((
        WatchStart {
            threads: vec![config.pid],
        },
        running,
    ))
}
