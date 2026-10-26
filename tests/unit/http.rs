use super::*;
use claviron::orbitive::Fleet;
use claviron::orbitive::stream::{Incarnation, StreamSpec, Streams};
use std::sync::Arc;

#[tokio::test]
async fn finished_http_reuses_a_slot_while_native_wrappers_remain_alive() {
    let streams = Streams::with_spec(
        Arc::new(Fleet::join("http-unit", 1).unwrap()),
        Incarnation::new(1),
        StreamSpec::new(246, 1, 256),
    )
    .unwrap();
    let (mut edge, ticket) = streams.create().unwrap();
    let mut wrappers = Vec::new();
    for _ in 0..16 {
        let (read, write) = streams.open(ticket).unwrap().split();
        let incoming = Mutex::new(Some(read));
        let outgoing = Mutex::new(Some(write));
        let stopped = watch::Sender::new(false);
        finish(&incoming, &outgoing, &stopped).await.unwrap();
        // Keeping the wrapper alive models a JS object awaiting collection.
        wrappers.push((incoming, outgoing, stopped));
        edge.rearm(&streams).expect("completed HTTP must release its peer");
    }
    assert_eq!(wrappers.len(), 16);
}

#[tokio::test]
async fn finished_http_wakes_a_pending_body_read_before_releasing_it() {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    let streams = Streams::with_spec(
        Arc::new(Fleet::join("http-read-unit", 1).unwrap()),
        Incarnation::new(1),
        StreamSpec::new(246, 1, 256),
    )
    .unwrap();
    let (mut edge, ticket) = streams.create().unwrap();
    let (input, output) = streams.open(ticket).unwrap().split();
    let incoming = Mutex::new(Some(input));
    let outgoing = Mutex::new(Some(output));
    let stopped = watch::Sender::new(false);
    let mut reading = std::pin::pin!(read(&incoming, &stopped));
    poll_fn(|cx| {
        assert!(reading.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    let (finished, received) =
        tokio::join!(finish(&incoming, &outgoing, &stopped), reading);
    finished.unwrap();
    assert!(received.is_err());
    edge.rearm(&streams).unwrap();
}
