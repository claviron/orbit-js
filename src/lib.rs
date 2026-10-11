//! Serve a JavaScript application behind a Claviron edge over Orbit Link.
//!
//! The process takes a lane in its fleet's Link segment under a name, the way
//! a Claviron runner does, and the edge writes HTTP exchanges into it. This
//! module reads them on its own Tokio runtime — the lane's bell wakes the
//! reactor, no thread is parked and nothing polls — and hands each to
//! JavaScript as a promise. The application answers with a status, headers
//! and a body; the head goes back to the edge worker that asked, the body
//! through the exchange's stream slot.

use std::sync::{Arc, Mutex};

mod cells;
mod events;
mod lifecycle;

use claviron::orbit::transport::{
    ControlCommand, Exchange as ExchangeFrame, ExchangeReply, FrameKind,
    Received, ShutdownNotice, TRANSPORT_FLEET_CAPACITY, Ticket,
    TransportBodies, TransportSegment, frame_kind,
};
use claviron::orbitive::{Fleet, NodeId};
use claviron::orbitive::link::InboxReceiver;
use claviron::orbitive::shm::LaneHold;
use claviron::orbitive::stream::{ReadHalf, WriteHalf};
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// What a lane says serves its name, so the edge's directory reads `js`.
pub(crate) const RUNTIME: &str = "js";

/// A process's first life; a supervisor would count restarts, and there is
/// none here.
const INCARNATION: u64 = 1;

/// How much one `read()` takes from a request body at most. The slot's own
/// buffer bounds what is there to take.
const READ_CHUNK: usize = 64 * 1024;

#[napi(object)]
pub struct JoinOptions {
    /// The Link fleet the edge routes to.
    pub fleet: String,
    /// The name this process serves in that fleet.
    pub name: String,
}

/// This process's place in a Link fleet.
#[napi]
pub struct Link {
    segment: Arc<TransportSegment>,
    bodies: Arc<TransportBodies>,
    lane: u32,
    hold: Mutex<Option<LaneHold>>,
    receiver: tokio::sync::Mutex<Option<InboxReceiver>>,
    /// Set by `close()`. A `next()` parked on the lane watches it too, so a
    /// close ends that wait at once instead of waiting for a frame.
    closed: tokio::sync::watch::Sender<bool>,
    events: Arc<events::Events>,
    lifecycle: Arc<lifecycle::Lifecycle>,
    controls: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<lifecycle::ControlEvent>>,
    name: String,
    cells: Option<cells::Cells>,
    cells_unavailable: Option<String>,
    delivered: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<events::DeliveredEvent>>,
}

/// Take a lane in `fleet` under `name` and start reading it.
#[napi]
pub async fn join(options: JoinOptions) -> Result<Link> {
    let segment = Arc::new(
        TransportSegment::for_fleet(&options.fleet).map_err(failure)?,
    );
    let joined =
        segment.join(&options.name, RUNTIME, INCARNATION).map_err(failure)?;
    let bodies = Arc::new(
        TransportBodies::for_fleet(&options.fleet, joined.lane, INCARNATION)
            .map_err(failure)?,
    );
    bodies.reclaimed(&joined.reclaimed);
    let receiver = segment.receiver(joined.lane).map_err(failure)?;
    // This process's lane index is its node in the fleet: a lane is held by
    // one live process, so the index is unique while it lives — what the
    // Link's "forwarded once, at its origin" rule and per-node rings need. A
    // fleet shared with a supervised Claviron runner would number its nodes
    // differently; an orbit-js application keeps a fleet of its own.
    let node = u16::try_from(joined.lane)
        .map_err(|_| failure("the lane does not fit a fleet node"))?;
    let capacity = u16::try_from(TRANSPORT_FLEET_CAPACITY)
        .map_err(|_| failure("the fleet capacity does not fit u16"))?;
    let fleet = Arc::new(
        Fleet::join_shm_as(&options.fleet, capacity, NodeId::new(node))
            .map_err(failure)?,
    );
    let (cells, cells_unavailable) =
        match cells::Cells::attach(Arc::clone(&fleet)) {
            Ok(cells) => (Some(cells), None),
            Err(error) => (None, Some(error.reason.clone())),
        };
    let (lifecycle, controls) =
        lifecycle::Lifecycle::new(Arc::clone(&segment), &options.name, node);
    let (events, delivered) = events::Events::join(
        fleet,
        &options.name,
        segment.link(),
        joined.lane,
        Arc::clone(&lifecycle),
    )?;
    Ok(Link {
        segment,
        bodies,
        lane: joined.lane as u32,
        hold: Mutex::new(Some(joined.hold)),
        receiver: tokio::sync::Mutex::new(Some(receiver)),
        closed: tokio::sync::watch::channel(false).0,
        events,
        lifecycle,
        controls: tokio::sync::Mutex::new(controls),
        name: options.name.clone(),
        cells,
        cells_unavailable,
        delivered: tokio::sync::Mutex::new(delivered),
    })
}

#[napi]
impl Link {
    /// The lane this process took; its address in the fleet.
    #[napi(getter)]
    pub fn lane(&self) -> u32 {
        self.lane
    }

    /// The next request, or `null` once the link is closed.
    #[napi]
    pub async fn next(&self) -> Result<Option<Exchange>> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow_and_update() {
            return Ok(None);
        }
        let mut held = self.receiver.lock().await;
        let mut frame = Vec::new();
        loop {
            let Some(receiver) = held.as_mut() else {
                return Ok(None);
            };
            let received = tokio::select! {
                received = receiver.next(&mut frame) => received.map_err(failure)?,
                _ = closed.changed() => return Ok(None),
            };
            match received {
                Received::Frame => {}
                Received::Event => {
                    self.events.accept(&frame);
                    continue;
                }
                // Directory changes come in a later milestone; reading past
                // them keeps the lane flowing.
                Received::Directory(_) => continue,
            }
            match frame_kind(&frame) {
                Ok(FrameKind::Request) => {}
                Ok(FrameKind::Control) => {
                    if let Ok(command) = ControlCommand::decode(&frame) {
                        self.control(command);
                    }
                    continue;
                }
                Ok(FrameKind::ShutdownInitiated) => {
                    if let Ok(notice) = ShutdownNotice::decode(&frame) {
                        self.lifecycle.edge_shutdown(notice.edge);
                    }
                    continue;
                }
                _ => continue,
            }
            let Ok(exchange) = ExchangeFrame::decode(&frame) else {
                continue;
            };
            if !self.lifecycle.running() {
                // The application is stopped; the process and its lane are
                // not. Answer without running the handler.
                self.refuse(exchange, 503).await;
                continue;
            }
            if exchange.upgrade {
                // WebSocket upgrades are not served yet: refuse rather than
                // leave the edge waiting.
                self.refuse(exchange, 501).await;
                continue;
            }
            return Exchange::new(
                exchange,
                Arc::clone(&self.segment),
                &self.bodies,
            )
            .map(Some);
        }
    }

    /// Stop being a target: release the lane, then its hold. Requests already
    /// taken may still be answered.
    #[napi]
    pub async fn close(&self) {
        self.closed.send_replace(true);
        self.events.stop();
        self.receiver.lock().await.take();
        let _ = self.segment.inbox().release_lane(self.lane as usize);
        drop(self.hold.lock().expect("lane hold").take());
    }

    /// The fleet's cells, shared with every instance of this application.
    #[napi(getter)]
    pub fn cells(&self) -> Result<cells::Cells> {
        self.cells.clone().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!(
                    "Orbit cells are not available: {}",
                    self.cells_unavailable.as_deref().unwrap_or("unknown")
                ),
            )
        })
    }

    /// Receive events on these topics, from the other instances of this
    /// application and from across the Link. Subscribing is what tells the
    /// edge's side to send them.
    #[napi]
    pub fn subscribe(&self, topics: Vec<String>) {
        self.events.subscribe(topics);
    }

    #[napi]
    pub fn unsubscribe(&self, topics: Vec<String>) {
        self.events.unsubscribe(topics);
    }

    /// Publish an application event; returns its id. With `target`
    /// (`[runtime, name]`), only that application receives it.
    #[napi]
    pub fn publish(
        &self,
        topic: String,
        payload: serde_json::Value,
        target: Option<Vec<String>>,
    ) -> Result<String> {
        let target = match target.as_deref() {
            None => None,
            Some([runtime, name]) => Some((runtime.clone(), name.clone())),
            Some(_) => {
                return Err(Error::new(
                    Status::InvalidArg,
                    "target is [runtime, name]",
                ));
            }
        };
        self.events.publish(topic, &payload, target)
    }

    /// The next subscribed event, or `null` once the link is closed.
    #[napi]
    pub async fn next_event(&self) -> Option<events::DeliveredEvent> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow_and_update() {
            return None;
        }
        let mut delivered = self.delivered.lock().await;
        tokio::select! {
            event = delivered.recv() => event,
            _ = closed.changed() => None,
        }
    }

    /// The next thing the edge said — a lifecycle change, a named command or
    /// an edge shutdown — or `null` once the link is closed.
    #[napi]
    pub async fn next_control(&self) -> Option<lifecycle::ControlEvent> {
        let mut closed = self.closed.subscribe();
        if *closed.borrow_and_update() {
            return None;
        }
        let mut controls = self.controls.lock().await;
        tokio::select! {
            event = controls.recv() => event,
            _ = closed.changed() => None,
        }
    }

    /// Whether the application is running (not stopped by the edge).
    #[napi(getter)]
    pub fn running(&self) -> bool {
        self.lifecycle.running()
    }

    fn control(
        &self,
        command: ControlCommand,
    ) {
        if command.application != self.name {
            return;
        }
        match command.name.as_str() {
            "status" if command.target.is_none() => self.lifecycle.publish_state(),
            "start" | "stop" | "restart" => {
                let ours = command.target.as_ref().is_some_and(|target| {
                    target.runtime == RUNTIME && target.name == self.name
                });
                if ours
                    && let Err(error) =
                        self.events.publish_lifecycle(&command.name)
                {
                    eprintln!("orbit-js: lifecycle command could not spread: {error}");
                }
            }
            _ => self.lifecycle.command(command.name, command.payload),
        }
    }

    /// Answer without the handler: the status, and an empty body the edge
    /// sees end, so nothing waits on a reply that will not come.
    async fn refuse(
        &self,
        exchange: ExchangeFrame,
        status: u16,
    ) {
        if let Ok(refused) =
            Exchange::new(exchange, Arc::clone(&self.segment), &self.bodies)
        {
            refused.refuse(status).await;
        }
    }
}

/// One request and the means to answer it.
#[napi]
pub struct Exchange {
    segment: Arc<TransportSegment>,
    correlation: u64,
    origin: u16,
    ticket: Option<Ticket>,
    method: String,
    url: String,
    headers: Vec<Vec<String>>,
    has_body: bool,
    incoming: tokio::sync::Mutex<Option<ReadHalf>>,
    outgoing: tokio::sync::Mutex<Option<WriteHalf>>,
    replied: Mutex<bool>,
    /// Set by `abort`, so a read or write waiting on the edge gives up its
    /// half instead of holding it while the exchange is abandoned.
    aborted: tokio::sync::watch::Sender<bool>,
}

impl Exchange {
    fn new(
        exchange: ExchangeFrame,
        segment: Arc<TransportSegment>,
        bodies: &TransportBodies,
    ) -> Result<Self> {
        let (incoming, outgoing) = match exchange.body {
            Some(ticket) => {
                let (read, write) =
                    bodies.accept(ticket).map_err(failure)?.split();
                (Some(read), Some(write))
            }
            None => (None, None),
        };
        let headers: Vec<Vec<String>> = exchange
            .headers
            .iter()
            .map(|(name, value)| {
                vec![
                    String::from_utf8_lossy(name).into_owned(),
                    String::from_utf8_lossy(value).into_owned(),
                ]
            })
            .collect();
        let url = url(&exchange, &headers);
        Ok(Self {
            segment,
            correlation: exchange.correlation,
            origin: exchange.origin,
            ticket: exchange.body,
            method: exchange.method,
            url,
            headers,
            has_body: incoming.is_some(),
            incoming: tokio::sync::Mutex::new(incoming),
            outgoing: tokio::sync::Mutex::new(outgoing),
            replied: Mutex::new(false),
            aborted: tokio::sync::watch::Sender::new(false),
        })
    }
}

impl Exchange {
    /// Reply `status` with an empty, finished body, unless a reply head went
    /// out already. Returns whether this was the reply.
    async fn refuse(
        &self,
        status: u16,
    ) -> bool {
        self.incoming.lock().await.take();
        if self.respond(status, Vec::new()).is_err() {
            return false;
        }
        if let Some(mut outgoing) = self.outgoing.lock().await.take() {
            let _ = outgoing.shutdown().await;
        }
        true
    }
}

#[napi]
impl Exchange {
    #[napi(getter)]
    pub fn method(&self) -> String {
        self.method.clone()
    }

    #[napi(getter)]
    pub fn url(&self) -> String {
        self.url.clone()
    }

    /// `[name, value]` pairs, in the order they arrived.
    #[napi(getter)]
    pub fn headers(&self) -> Vec<Vec<String>> {
        self.headers.clone()
    }

    /// Whether the request has a body at all. Absent is not empty.
    #[napi(getter)]
    pub fn has_body(&self) -> bool {
        self.has_body
    }

    /// The next piece of the request body, or `null` at its end.
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        let mut held = self.incoming.lock().await;
        let Some(incoming) = held.as_mut() else {
            return Ok(None);
        };
        let mut aborted = self.aborted.subscribe();
        if *aborted.borrow_and_update() {
            return Err(abandoned());
        }
        let mut piece = vec![0u8; READ_CHUNK];
        let read = tokio::select! {
            read = incoming.read(&mut piece) => read.map_err(failure)?,
            _ = aborted.changed() => return Err(abandoned()),
        };
        if read == 0 {
            held.take();
            return Ok(None);
        }
        piece.truncate(read);
        Ok(Some(piece.into()))
    }

    /// Send the reply head to the edge worker that asked. Once only.
    #[napi]
    pub fn respond(
        &self,
        status: u16,
        headers: Vec<Vec<String>>,
    ) -> Result<()> {
        let mut replied = self.replied.lock().expect("reply flag");
        if *replied {
            return Err(Error::new(
                Status::GenericFailure,
                "this exchange was already answered",
            ));
        }
        let reply = ExchangeReply {
            correlation: self.correlation,
            status,
            headers: headers
                .into_iter()
                .filter_map(|pair| match pair.as_slice() {
                    [name, value] => Some((
                        name.as_bytes().to_vec(),
                        value.as_bytes().to_vec(),
                    )),
                    _ => None,
                })
                .collect(),
            body: self.ticket,
        };
        let frame = reply.encode().map_err(failure)?;
        self.segment
            .inbox()
            .write(self.origin as usize, &frame)
            .map_err(failure)?;
        *replied = true;
        Ok(())
    }

    /// Write a piece of the reply body.
    #[napi]
    pub async fn write(&self, chunk: Buffer) -> Result<()> {
        let mut held = self.outgoing.lock().await;
        let Some(outgoing) = held.as_mut() else {
            return Err(Error::new(
                Status::GenericFailure,
                "this exchange has no body slot to write to",
            ));
        };
        let mut aborted = self.aborted.subscribe();
        if *aborted.borrow_and_update() {
            return Err(abandoned());
        }
        tokio::select! {
            written = outgoing.write_all(&chunk) => written.map_err(failure),
            _ = aborted.changed() => Err(abandoned()),
        }
    }

    /// Close the reply body; the edge sees its end.
    #[napi]
    pub async fn end(&self) -> Result<()> {
        if let Some(mut outgoing) = self.outgoing.lock().await.take() {
            outgoing.shutdown().await.map_err(failure)?;
        }
        Ok(())
    }

    /// Abandon the exchange. Before a reply head the edge gets a 503 with an
    /// empty body; after it, the body is cut, so the edge sees it unfinished.
    /// Either way nothing on the edge is left waiting for this process.
    #[napi]
    pub async fn abort(&self) {
        self.aborted.send_replace(true);
        if !self.refuse(503).await
            && let Some(mut outgoing) = self.outgoing.lock().await.take()
        {
            outgoing.reset();
        }
    }
}

fn abandoned() -> Error {
    Error::new(Status::Cancelled, "this exchange was abandoned")
}

/// The request's absolute URL, as a `Request` needs one: scheme, the host the
/// client asked for, the path as it arrived and the query.
fn url(
    exchange: &ExchangeFrame,
    headers: &[Vec<String>],
) -> String {
    let host = headers
        .iter()
        .find(|pair| pair[0].eq_ignore_ascii_case("host"))
        .map_or("localhost", |pair| pair[1].as_str());
    let scheme =
        if exchange.scheme.is_empty() { "http" } else { &exchange.scheme };
    let path = String::from_utf8_lossy(&exchange.raw_path);
    if exchange.query.is_empty() {
        format!("{scheme}://{host}{path}")
    } else {
        format!(
            "{scheme}://{host}{path}?{}",
            String::from_utf8_lossy(&exchange.query)
        )
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}
