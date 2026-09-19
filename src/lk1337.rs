use anyhow::{anyhow, Result};
use nix::libc;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
pub const BOOTSTRAP: u64 = 0x4b530001;
const MAGIC: u32 = 0x42464946;
pub const BP_EXECUTE: i32 = 0;
pub const BP_READ: i32 = 1;
pub const BP_WRITE: i32 = 2;
pub const BP_READWRITE: i32 = 3;
pub const BP_F_DETAIL: u32 = 1;
pub const BP_F_BACKTRACE: u32 = 2;
pub const BT_MAX: usize = 32;
pub const MAPS_FILTER_ADD: u64 = 621;
pub const MAPS_FILTER_REMOVE: u64 = 622;
pub const MAPS_FILTER_CLEAR: u64 = 623;
pub const MAPS_FILTER_ENABLE: u64 = 624;
pub const READ: u64 = 601;
pub const WRITE: u64 = 602;
#[repr(C)]
struct Memory {
    pid: i32,
    res: u32,
    addr: u64,
    buffer: u64,
    size: u64,
}
#[repr(C)]
struct Boot {
    magic: u32,
    fd: i32,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct Snapshot {
    pub regs: [u64; 31],
    pub sp: u64,
    pub pc: u64,
    pub pstate: u64,
    pub vregs: [[u64; 2]; 32],
    pub fpsr: u32,
    pub fpcr: u32,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct Hit {
    pub sequence: u64,
    pub timestamp: u64,
    pub addr: u64,
    pub pid: i32,
    pub tid: i32,
    pub flags: u32,
    pub reserved: u32,
    pub before: Snapshot,
    pub after: Snapshot,
    pub bt_count: u32,
    pub bt_flags: u32,
    pub backtrace: [u64; BT_MAX],
}
#[repr(C)]
struct Create {
    addr: u64,
    typ: i32,
    len: i32,
    pid: i32,
    max: i32,
    bp_id: i32,
    flags: u32,
}
#[repr(C)]
struct Id {
    bp_id: i32,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct MapsFilter {
    pub enable: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MapsFilterRule {
    pub pattern: [u8; 256],
}
impl Default for MapsFilterRule {
    fn default() -> Self {
        Self { pattern: [0; 256] }
    }
}
#[repr(C)]
struct Hits {
    bp_id: i32,
    flags: u32,
    buffer: u64,
    capacity: u32,
    count: u32,
    total: u64,
    dropped: u64,
    fp: u64,
}
pub struct Driver {
    fd: RawFd,
}
impl Driver {
    pub fn open() -> Result<Self> {
        // Match LK1337.hpp exactly; bootstrap returns the FD through the request,
        // not through ioctl's return value.
        let socket =
            unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
        if socket < 0 {
            return Err(anyhow!(
                "LK1337 socket failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let socket = unsafe { OwnedFd::from_raw_fd(socket) };
        let mut request = Boot {
            magic: MAGIC,
            fd: -1,
        };
        let rc = unsafe { libc::ioctl(socket.as_raw_fd(), BOOTSTRAP as libc::Ioctl, &mut request) };
        // errno is meaningful only after a failed call, and must be saved before
        // closing the socket (or making another syscall).
        let error = (rc < 0).then(std::io::Error::last_os_error);
        let fd = bootstrap_result(request.fd, rc, error)?;
        Ok(Self { fd })
    }
    fn io<T>(&self, n: u64, v: &mut T) -> Result<()> {
        let rc = unsafe { libc::ioctl(self.fd, n as libc::Ioctl, v) };
        if rc < 0 {
            let e = std::io::Error::last_os_error();
            Err(anyhow!("ioctl {} failed: {}", n, e))
        } else {
            Ok(())
        }
    }
    pub fn create(
        &self,
        addr: u64,
        typ: i32,
        len: i32,
        pid: i32,
        cap: i32,
        flags: u32,
    ) -> Result<i32> {
        let mut c = Create {
            addr,
            typ,
            len,
            pid,
            max: cap,
            bp_id: -1,
            flags,
        };
        self.io(610, &mut c)?;
        Ok(c.bp_id)
    }
    pub fn remove(&self, id: i32) -> Result<()> {
        self.io(611, &mut Id { bp_id: id })
    }
    pub fn hits(&self, id: i32) -> Result<Vec<Hit>> {
        let mut v = vec![Hit::default(); 256];
        let mut h = Hits {
            bp_id: id,
            flags: 1,
            buffer: v.as_mut_ptr() as u64,
            capacity: 256,
            count: 0,
            total: 0,
            dropped: 0,
            fp: 0,
        };
        self.io(616, &mut h)?;
        v.truncate(h.count as usize);
        Ok(v)
    }
}
impl Driver {
    pub fn enable_maps_filter(&self, enable: bool) -> Result<()> {
        let mut f = MapsFilter {
            enable: enable as u32,
        };
        self.io(MAPS_FILTER_ENABLE, &mut f)
    }
    pub fn clear_maps_filter(&self) -> Result<()> {
        let mut z = MapsFilter::default();
        self.io(MAPS_FILTER_CLEAR, &mut z)
    }
}
impl Driver {
    pub fn add_maps_rule(&self, pattern: &str) -> Result<()> {
        let mut r = MapsFilterRule::default();
        let b = pattern.as_bytes();
        let n = b.len().min(r.pattern.len() - 1);
        r.pattern[..n].copy_from_slice(&b[..n]);
        self.io(MAPS_FILTER_ADD, &mut r)
    }
    pub fn remove_maps_rule(&self, pattern: &str) -> Result<()> {
        let mut r = MapsFilterRule::default();
        let b = pattern.as_bytes();
        let n = b.len().min(r.pattern.len() - 1);
        r.pattern[..n].copy_from_slice(&b[..n]);
        self.io(MAPS_FILTER_REMOVE, &mut r)
    }
}
impl Driver {
    pub fn read_memory(&self, pid: i32, addr: u64, size: usize) -> Result<Vec<u8>> {
        let mut b = vec![0u8; size];
        let mut m = Memory {
            pid,
            res: 0,
            addr,
            buffer: b.as_mut_ptr() as u64,
            size: size as u64,
        };
        self.io(READ, &mut m)?;
        Ok(b)
    }
    pub fn write_memory(&self, pid: i32, addr: u64, data: &[u8]) -> Result<()> {
        let mut m = Memory {
            pid,
            res: 0,
            addr,
            buffer: data.as_ptr() as u64,
            size: data.len() as u64,
        };
        self.io(WRITE, &mut m)
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

fn bootstrap_result(fd: RawFd, rc: libc::c_int, error: Option<std::io::Error>) -> Result<RawFd> {
    // The reference wrapper accepts a returned FD even when ioctl reports an error.
    if fd >= 0 {
        return Ok(fd);
    }
    let context = format!(
        "LK1337 bootstrap failed (command=0x{BOOTSTRAP:08x}, magic=0x{MAGIC:08x}, request_size={}, rc={rc}, returned_fd={fd})",
        std::mem::size_of::<Boot>()
    );
    match error {
        Some(error) if error.raw_os_error() == Some(libc::ENOTTY) => Err(anyhow!(
            "{context}: {error}; bootstrap ioctl was not handled on this socket and no driver FD was returned; memory ioctl 601/602 was not attempted"
        )),
        Some(error) => Err(anyhow!("{context}: {error}")),
        None => Err(anyhow!("{context}: ioctl succeeded but did not return a driver FD")),
    }
}

#[cfg(test)]
mod memory_abi_tests {
    use super::{bootstrap_result, Boot, Memory, MAGIC};
    use std::mem::{offset_of, size_of};

    #[test]
    fn memory_matches_lk1337_header() {
        assert_eq!(size_of::<Memory>(), 32);
        assert_eq!(offset_of!(Memory, pid), 0);
        assert_eq!(offset_of!(Memory, res), 4);
        assert_eq!(offset_of!(Memory, addr), 8);
        assert_eq!(offset_of!(Memory, buffer), 16);
        assert_eq!(offset_of!(Memory, size), 24);
    }

    #[test]
    fn bootstrap_matches_header() {
        assert_eq!(size_of::<Boot>(), 8);
        assert_eq!(offset_of!(Boot, magic), 0);
        assert_eq!(offset_of!(Boot, fd), 4);
        assert_eq!(MAGIC, 0x42464946);
    }

    #[test]
    fn returned_fd_takes_priority_over_ioctl_errno() {
        assert_eq!(
            bootstrap_result(
                0,
                -1,
                Some(std::io::Error::from_raw_os_error(nix::libc::ENOTTY))
            )
            .unwrap(),
            0
        );
        assert_eq!(bootstrap_result(42, 0, None).unwrap(), 42);
    }

    #[test]
    fn missing_fd_does_not_report_stale_errno() {
        let message = bootstrap_result(-1, 0, None).unwrap_err().to_string();
        assert!(message.contains("ioctl succeeded but did not return"));
        assert!(!message.contains("os error"));
        let message = bootstrap_result(
            -1,
            -1,
            Some(std::io::Error::from_raw_os_error(nix::libc::ENOTTY)),
        )
        .unwrap_err()
        .to_string();
        assert!(message.contains("command=0x4b530001"));
        assert!(message.contains("memory ioctl 601/602 was not attempted"));
    }
}
