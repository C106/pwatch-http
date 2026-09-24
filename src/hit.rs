use crate::{
    arch,
    maps::{AddressResolution, MapRegion},
    perf::SampleData,
};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub seq: u64,
    pub breakpoint_id: u64,
    pub pid: u32,
    pub tid: u32,
    pub timestamp_ms: u128,
    pub regs: Vec<RegisterValue>,
    pub simd: Vec<RegisterValue>,
    pub backtrace: Option<Vec<String>>,
    pub backtrace_frames: Option<Vec<AddressValue>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegisterValue {
    pub name: String,
    pub value: String,
    pub map: Option<MapRegion>,
    pub resolved: Option<AddressResolution>,
    pub display: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AddressValue {
    pub value: String,
    pub resolved: Option<AddressResolution>,
    pub display: String,
}

#[derive(Default)]
pub struct HitFactory {
    next_seq: AtomicU64,
}

impl HitFactory {
    pub fn make_hit_with_maps(
        &self,
        breakpoint_id: u64,
        data: SampleData,
        reg_resolutions: Vec<Option<AddressResolution>>,
        backtrace_resolutions: Option<Vec<Option<AddressResolution>>>,
    ) -> Hit {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let regs = data
            .regs
            .iter()
            .enumerate()
            .map(|(idx, value)| RegisterValue {
                name: arch::id_to_str(idx).to_string(),
                value: format!("0x{value:016x}"),
                map: reg_resolutions
                    .get(idx)
                    .cloned()
                    .flatten()
                    .map(|resolved| resolved.region),
                resolved: reg_resolutions.get(idx).cloned().unwrap_or(None),
                display: display_address(*value, reg_resolutions.get(idx).and_then(Option::as_ref)),
            })
            .collect();
        let backtrace = data
            .backtrace
            .as_ref()
            .map(|frames| frames.iter().map(|addr| format!("0x{addr:016x}")).collect());
        let simd = data
            .simd
            .iter()
            .enumerate()
            .flat_map(|(index, value)| {
                [
                    make_simd_register(index, "lo", value[0]),
                    make_simd_register(index, "hi", value[1]),
                ]
            })
            .collect();
        let backtrace_frames = data.backtrace.map(|frames| {
            frames
                .into_iter()
                .enumerate()
                .map(|(idx, addr)| {
                    let resolved = backtrace_resolutions
                        .as_ref()
                        .and_then(|resolutions| resolutions.get(idx))
                        .cloned()
                        .flatten();
                    AddressValue {
                        value: format!("0x{addr:016x}"),
                        display: display_address(addr, resolved.as_ref()),
                        resolved,
                    }
                })
                .collect()
        });

        Hit {
            seq,
            breakpoint_id,
            pid: data.pid,
            tid: data.tid,
            timestamp_ms,
            regs,
            simd,
            backtrace,
            backtrace_frames,
        }
    }
}

fn make_simd_register(index: usize, part: &str, value: u64) -> RegisterValue {
    let value = format!("0x{value:016x}");
    RegisterValue {
        name: format!("v{index}.{part}"),
        value: value.clone(),
        map: None,
        resolved: None,
        display: value,
    }
}

fn display_address(addr: u64, resolved: Option<&AddressResolution>) -> String {
    match resolved {
        Some(resolved) => format!("0x{addr:016x} ({})", resolved.display),
        None => format!("0x{addr:016x}"),
    }
}

#[cfg(test)]
mod tests {
    use super::HitFactory;
    use crate::perf::SampleData;

    #[test]
    fn hit_serialization_contains_simd_halves_as_hex_strings() {
        let hit = HitFactory::default().make_hit_with_maps(
            7,
            SampleData {
                pid: 11,
                tid: 12,
                regs: Vec::new(),
                backtrace: None,
                simd: vec![[0x0123_4567_89ab_cdef, 0xfedc_ba98_7654_3210]],
            },
            Vec::new(),
            None,
        );

        let json = serde_json::to_value(hit).unwrap();
        assert_eq!(json["simd"][0]["name"], "v0.lo");
        assert_eq!(json["simd"][0]["value"], "0x0123456789abcdef");
        assert_eq!(json["simd"][1]["name"], "v0.hi");
        assert_eq!(json["simd"][1]["value"], "0xfedcba9876543210");
    }
}
