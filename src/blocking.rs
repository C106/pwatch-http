use anyhow::anyhow;
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};

const MAX_IN_FLIGHT: usize = 8;
const MAX_DURATION: Duration = Duration::from_secs(3);

static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn slots() -> Arc<Semaphore> {
    Arc::clone(SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT))))
}

/// Runs blocking kernel/procfs work without allowing an unbounded queue to
/// starve HTTP handlers. A timed-out task is detached; its permit remains held
/// until the native operation returns, preventing a burst of stuck ioctls.
pub async fn run<F, T>(job: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let permit = slots()
        .try_acquire_owned()
        .map_err(|_| anyhow!("blocking operation capacity exhausted"))?;
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        job()
    });
    match timeout(MAX_DURATION, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(anyhow!("blocking worker failed: {error}")),
        Err(_) => Err(anyhow!(
            "blocking operation timed out after {}s",
            MAX_DURATION.as_secs()
        )),
    }
}
