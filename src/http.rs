//! Terminal ownership of an HTTP exchange's stream halves.

use claviron::orbitive::stream::{ReadHalf, WriteHalf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, watch};

pub(crate) async fn read(
    incoming: &Mutex<Option<ReadHalf>>,
    stopped: &watch::Sender<bool>,
) -> crate::Result<Option<Vec<u8>>> {
    let mut held = incoming.lock().await;
    let Some(incoming) = held.as_mut() else { return Ok(None) };
    let mut stopped = stopped.subscribe();
    if *stopped.borrow_and_update() {
        return Err(crate::abandoned());
    }
    let mut piece = vec![0u8; crate::READ_CHUNK];
    let read = tokio::select! {
        read = incoming.read(&mut piece) => read.map_err(crate::failure)?,
        _ = stopped.changed() => return Err(crate::abandoned()),
    };
    if read == 0 {
        held.take();
        return Ok(None);
    }
    piece.truncate(read);
    Ok(Some(piece))
}

pub(crate) async fn finish(
    incoming: &Mutex<Option<ReadHalf>>,
    outgoing: &Mutex<Option<WriteHalf>>,
    stopped: &watch::Sender<bool>,
) -> std::io::Result<()> {
    // Publish FIN before retiring unread input. Even a failed shutdown is a
    // terminal HTTP path: a wrapper awaiting GC must retain no stream half.
    let result = match outgoing.lock().await.take() {
        Some(mut outgoing) => outgoing.shutdown().await,
        None => Ok(()),
    };
    // A concurrent read may hold the input mutex. Wake it before taking that
    // mutex; neither peer progress nor garbage collection is a close signal.
    stopped.send_replace(true);
    incoming.lock().await.take();
    result
}

#[cfg(test)]
#[path = "../tests/unit/http.rs"]
mod tests;
