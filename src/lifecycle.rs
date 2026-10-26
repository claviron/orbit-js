//! The application inside this process, as the edge manages it.
//!
//! The process, its lane and its Link stay up; what the edge stops, starts and
//! restarts is the application — the handler answering requests — the way a
//! Claviron runner's `ApplicationManager` stops an application without its
//! process leaving. A stopped application answers requests with 503 without
//! running the handler, and JavaScript is told so it can cancel its work.
//!
//! A command reaches one lane. The instance that receives it spreads the
//! decision to every instance of the application through the fleet's event
//! ring, as a runner's master would to its workers, so the application stops
//! as a whole rather than in one process.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::SystemTime;

use claviron::app::fleet::{
    FleetApplicationListSnapshot, FleetApplicationPlacement,
    FleetApplicationStatus, encode_link_snapshot_rows,
};
use claviron::app::{
    ApplicationDescription, ApplicationId, ApplicationLifecycle,
    ApplicationName, ApplicationRuntime,
};
use claviron::orbit::service::{FleetMember, FleetMemberRole};
use claviron::orbit::transport::TransportSegment;
use tokio::sync::mpsc;

use crate::RUNTIME;

/// The internal topic instances of one application share lifecycle decisions
/// on, addressed to that application only.
pub(crate) const LIFECYCLE_TOPIC: &str = "orbit-js.lifecycle.v1";

/// Something the edge said, for JavaScript.
pub struct ControlEvent {
    /// `lifecycle`, `command` or `shutdown`.
    pub kind: String,
    /// For `lifecycle`: `start`, `stop` or `restart`.
    pub action: Option<String>,
    /// For `command`: the application-defined name.
    pub name: Option<String>,
    pub payload: Option<Vec<u8>>,
    /// For `shutdown`: the edge that is shutting down.
    pub edge: Option<String>,
}

pub(crate) struct Lifecycle {
    description: ApplicationDescription,
    segment: Arc<TransportSegment>,
    name: String,
    lane: u16,
    running: AtomicBool,
    generation: AtomicU64,
    notify: mpsc::UnboundedSender<ControlEvent>,
}

impl Lifecycle {
    pub(crate) fn new(
        segment: Arc<TransportSegment>,
        name: &str,
        lane: u16,
        frameworks: Vec<String>,
        icon: Option<String>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<ControlEvent>) {
        let (notify, receiver) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                description: ApplicationDescription {
                    frameworks,
                    icon,
                    ..ApplicationDescription::new("javascript", "fetch")
                        .runner("orbit-js")
                },
                segment,
                name: name.to_owned(),
                lane,
                running: AtomicBool::new(true),
                generation: AtomicU64::new(1),
                notify,
            }),
            receiver,
        )
    }

    pub(crate) fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub(crate) fn id(&self) -> Option<ApplicationId> {
        Some(ApplicationId::new(
            ApplicationRuntime::new(RUNTIME).ok()?,
            ApplicationName::new(self.name.clone()).ok()?,
        ))
    }

    /// Apply a decision every instance received. A restart, or a start after
    /// a stop, is a new generation, as a runner counts it.
    pub(crate) fn apply(
        &self,
        action: &str,
    ) {
        match action {
            "start" => {
                if !self.running.swap(true, Ordering::AcqRel) {
                    self.generation.fetch_add(1, Ordering::AcqRel);
                }
            }
            "stop" => self.running.store(false, Ordering::Release),
            "restart" => {
                self.running.store(true, Ordering::Release);
                self.generation.fetch_add(1, Ordering::AcqRel);
            }
            _ => return,
        }
        let _ = self.notify.send(ControlEvent {
            kind: "lifecycle".to_owned(),
            action: Some(action.to_owned()),
            name: None,
            payload: None,
            edge: None,
        });
        self.publish_state();
    }

    pub(crate) fn command(
        &self,
        name: String,
        payload: Vec<u8>,
    ) {
        let _ = self.notify.send(ControlEvent {
            kind: "command".to_owned(),
            action: None,
            name: Some(name),
            payload: Some(payload),
            edge: None,
        });
    }

    pub(crate) fn edge_shutdown(
        &self,
        edge: String,
    ) {
        let _ = self.notify.send(ControlEvent {
            kind: "shutdown".to_owned(),
            action: None,
            name: None,
            payload: None,
            edge: Some(edge),
        });
    }

    /// Tell the edges in this fleet what this instance hosts, in the same
    /// rows a runner reports, so the linked-application view shows it.
    pub(crate) fn publish_state(&self) {
        let Some(id) = self.id() else { return };
        let now = SystemTime::now();
        let running = self.running();
        let snapshot = FleetApplicationListSnapshot {
            captured_at: now,
            members_expected: 1,
            members_reporting: 1,
            applications: vec![FleetApplicationStatus {
                id,
                placements: vec![FleetApplicationPlacement {
                    description: self.description.clone(),
                    member: FleetMember {
                        node_id: self.lane,
                        role: FleetMemberRole::Standalone,
                    },
                    lifecycle: if running {
                        ApplicationLifecycle::Running
                    } else {
                        ApplicationLifecycle::Stopped
                    },
                    enabled: running,
                    generation: self.generation.load(Ordering::Acquire),
                    pool: None,
                    last_error: None,
                    last_error_truncated: false,
                    observed_at: now,
                }],
            }],
        };
        let member = FleetMember {
            node_id: self.lane,
            role: FleetMemberRole::Standalone,
        };
        match encode_link_snapshot_rows(&snapshot, member) {
            Ok(rows) => {
                if let Err(error) =
                    self.segment.publish_application_state(&self.name, &rows)
                {
                    eprintln!(
                        "orbit-js: application state was not reported: {error}"
                    );
                }
            }
            Err(error) => {
                eprintln!(
                    "orbit-js: application state could not be encoded: {error}"
                )
            }
        }
    }
}
