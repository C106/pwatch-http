use crate::{lk1337::Driver, server::error_response};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        DefaultBodyLimit, Query,
    },
    http::{header::CACHE_CONTROL, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 4096;

pub(crate) fn routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/memory/read", get(read_memory))
        .route("/memory/write", post(write_memory))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[derive(Deserialize)]
struct ReadRequest {
    pid: u32,
    addr: String,
    #[serde(default = "default_size")]
    size: usize,
}

fn default_size() -> usize {
    256
}

#[derive(Deserialize)]
struct WriteRequest {
    pid: u32,
    addr: String,
    data: String,
}

#[derive(Debug, Serialize)]
struct MemoryRow {
    addr: String,
    hex: String,
    ascii: String,
}

#[derive(Debug, Serialize)]
struct ReadResponse {
    pid: u32,
    addr: String,
    size: usize,
    next_addr: Option<String>,
    data: Vec<u8>,
    rows: Vec<MemoryRow>,
}

#[derive(Serialize)]
struct WriteResponse {
    pid: u32,
    addr: String,
    written: usize,
}

fn validate(pid: u32, addr: &str, size: usize) -> Result<u64, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("pid must be between 1 and 2147483647".into());
    }
    if !(1..=MAX_BYTES).contains(&size) {
        return Err(format!("size must be between 1 and {MAX_BYTES} bytes"));
    }
    let text = addr.trim();
    let text = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    if text.is_empty() || text.len() > 16 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("addr must be a hexadecimal string of at most 16 digits".into());
    }
    let addr = u64::from_str_radix(text, 16).map_err(|e| e.to_string())?;
    addr.checked_add(size as u64 - 1)
        .ok_or("address range overflows u64")?;
    Ok(addr)
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    let digits: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if digits.is_empty()
        || digits.len() > MAX_BYTES * 2
        || digits.len() % 2 != 0
        || !digits.iter().all(u8::is_ascii_hexdigit)
    {
        return Err(format!(
            "data must contain 1..={MAX_BYTES} hex byte pairs, optionally separated by whitespace"
        ));
    }
    Ok(digits
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |b: u8| {
                if b.is_ascii_digit() {
                    b - b'0'
                } else {
                    b.to_ascii_lowercase() - b'a' + 10
                }
            };
            (nibble(pair[0]) << 4) | nibble(pair[1])
        })
        .collect())
}

fn format_read(pid: u32, addr: u64, data: Vec<u8>) -> ReadResponse {
    let rows = data
        .chunks(16)
        .enumerate()
        .map(|(i, bytes)| MemoryRow {
            addr: format!("0x{:016x}", addr + (i * 16) as u64),
            hex: bytes
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .join(" "),
            ascii: bytes
                .iter()
                .map(|&b| {
                    if (0x20..=0x7e).contains(&b) {
                        b as char
                    } else {
                        '.'
                    }
                })
                .collect(),
        })
        .collect();
    ReadResponse {
        pid,
        addr: format!("0x{addr:016x}"),
        size: data.len(),
        next_addr: addr
            .checked_add(data.len() as u64)
            .map(|n| format!("0x{n:016x}")),
        data,
        rows,
    }
}

async fn read_memory(query: Result<Query<ReadRequest>, QueryRejection>) -> Response {
    let Query(request) = match query {
        Ok(q) => q,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, e.body_text()),
    };
    let addr = match validate(request.pid, &request.addr, request.size) {
        Ok(addr) => addr,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, e),
    };
    match tokio::task::spawn_blocking(move || {
        let data = Driver::open()?.read_memory(request.pid as i32, addr, request.size)?;
        Ok::<_, anyhow::Error>(format_read(request.pid, addr, data))
    })
    .await
    {
        Ok(Ok(body)) => ([(CACHE_CONTROL, "no-store")], Json(body)).into_response(),
        Ok(Err(e)) => error_response(StatusCode::BAD_GATEWAY, e),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn write_memory(body: Result<Json<WriteRequest>, JsonRejection>) -> Response {
    let Json(request) = match body {
        Ok(body) => body,
        Err(e) => return error_response(e.status(), e.body_text()),
    };
    let data = match decode_hex(&request.data) {
        Ok(data) => data,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, e),
    };
    let addr = match validate(request.pid, &request.addr, data.len()) {
        Ok(addr) => addr,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, e),
    };
    match tokio::task::spawn_blocking(move || {
        Driver::open()?.write_memory(request.pid as i32, addr, &data)?;
        Ok::<_, anyhow::Error>(WriteResponse {
            pid: request.pid,
            addr: format!("0x{addr:016x}"),
            written: data.len(),
        })
    })
    .await
    {
        Ok(Ok(body)) => ([(CACHE_CONTROL, "no-store")], Json(body)).into_response(),
        Ok(Err(e)) => error_response(StatusCode::BAD_GATEWAY, e),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_and_range_validation() {
        assert_eq!(
            validate(1, " 0X20000000000001 ", 16).unwrap(),
            0x20000000000001
        );
        assert_eq!(validate(1, "ff", 1).unwrap(), 255);
        assert_eq!(validate(1, "0", MAX_BYTES).unwrap(), 0);
        for pid in [0, i32::MAX as u32 + 1] {
            assert!(validate(pid, "10", 1).is_err());
        }
        for size in [0, MAX_BYTES + 1] {
            assert!(validate(1, "10", size).is_err());
        }
        for addr in ["", "0x", "+1", "xyz", "10000000000000000"] {
            assert!(validate(1, addr, 1).is_err());
        }
        assert!(validate(1, "ffffffffffffffff", 2).is_err());
        assert!(validate(1, "ffffffffffffffff", 1).is_ok());
    }

    #[test]
    fn hex_bytes_are_exact_and_bounded() {
        assert_eq!(decode_hex("00 aB\nFF\t42").unwrap(), [0, 171, 255, 66]);
        for data in ["", " ", "a", "0x12", "gg", "123"] {
            assert!(decode_hex(data).is_err());
        }
        assert_eq!(
            decode_hex(&"ff".repeat(MAX_BYTES)).unwrap().len(),
            MAX_BYTES
        );
        assert!(decode_hex(&"ff".repeat(MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn hex_rows_preserve_address_precision_and_partial_rows() {
        let data = vec![0, 32, 65, 126, 127, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 66];
        let response = format_read(123, 0x20000000000001, data.clone());
        assert_eq!(response.addr, "0x0020000000000001");
        assert_eq!(response.rows.len(), 2);
        assert_eq!(response.rows[0].ascii, ". A~............");
        assert_eq!(response.rows[1].hex, "42");
        assert_eq!(response.rows[1].addr, "0x0020000000000011");
        assert_eq!(response.next_addr.as_deref(), Some("0x0020000000000012"));
        assert_eq!(response.data, data);
        assert!(format_read(1, u64::MAX, vec![0]).next_addr.is_none());
    }

    #[tokio::test]
    async fn invalid_requests_return_json_without_calling_driver() {
        let response = read_memory(Ok(Query(ReadRequest {
            pid: 1,
            addr: "0x10".into(),
            size: 0,
        })))
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["error"].as_str().unwrap().contains("size"));
        let response = write_memory(Ok(Json(WriteRequest {
            pid: 1,
            addr: "0x10".into(),
            data: "xyz".into(),
        })))
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
