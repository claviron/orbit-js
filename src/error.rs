//! Errors independent of the JavaScript adapter.

/// The distinction preserved when an adapter translates an error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorKind {
    GenericFailure,
    InvalidArg,
    Cancelled,
}

/// An Orbit operation failed.
#[derive(Debug)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub fn new(
        kind: ErrorKind,
        message: impl Into<String>,
    ) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for Error {
    fn fmt(
        &self,
        formatter: &mut std::fmt::Formatter<'_>,
    ) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
