//! Orbit cells: typed values in the fleet's shared memory, the same cells
//! Claviron's PHP `Orbital` reads. Every instance of this application that
//! opens an id reads and updates the same value; additions and appends are
//! atomic, and a waiter is woken by the write itself.

use std::sync::Arc;

use crate::{Error, ErrorKind as Status, Result};
use claviron::orbitive::Fleet;
use claviron::orbitive::cell::{
    CellId, Cells as FleetCells, Orbital, Text, TextId,
};

#[derive(Clone)]
enum Value {
    Int(Orbital<i64>),
    Float(Orbital<f64>),
    Bool(Orbital<bool>),
    Text(Text),
}

/// What a cell holds, as JavaScript sees it.
#[derive(Clone, Debug, PartialEq)]
pub enum CellValue {
    Int(i64),
    Float(f64),
    Bool(bool),
    Text(String),
}

/// The fleet's cell table, opened once per process.
#[derive(Clone)]
pub struct Cells {
    cells: Arc<FleetCells>,
}

impl Cells {
    pub(crate) fn attach(fleet: Arc<Fleet>) -> Result<Self> {
        Ok(Self { cells: Arc::new(FleetCells::new(fleet).map_err(failure)?) })
    }
}

impl Cells {
    pub fn int(
        &self,
        value: Option<i64>,
    ) -> Result<Cell> {
        let cell = self.cells.allocate(value.unwrap_or(0)).map_err(failure)?;
        Ok(Cell { value: Value::Int(cell) })
    }

    pub fn float(
        &self,
        value: Option<f64>,
    ) -> Result<Cell> {
        let cell =
            self.cells.allocate(value.unwrap_or(0.0)).map_err(failure)?;
        Ok(Cell { value: Value::Float(cell) })
    }

    pub fn bool(
        &self,
        value: Option<bool>,
    ) -> Result<Cell> {
        let cell =
            self.cells.allocate(value.unwrap_or(false)).map_err(failure)?;
        Ok(Cell { value: Value::Bool(cell) })
    }

    pub fn string(
        &self,
        value: Option<String>,
    ) -> Result<Cell> {
        let cell = self
            .cells
            .allocate_text(value.as_deref().unwrap_or(""))
            .map_err(failure)?;
        Ok(Cell { value: Value::Text(cell) })
    }

    /// Attach to a cell another process made, by the id it printed. A scalar
    /// id does not say its type; the cell does.
    pub fn open(
        &self,
        id: String,
    ) -> Result<Cell> {
        if id.starts_with("cell:") {
            let cell_id: CellId = id.parse().map_err(failure)?;
            let value = self
                .cells
                .open::<i64>(cell_id)
                .map(Value::Int)
                .or_else(|_| self.cells.open::<f64>(cell_id).map(Value::Float))
                .or_else(|_| self.cells.open::<bool>(cell_id).map(Value::Bool))
                .map_err(failure)?;
            return Ok(Cell { value });
        }
        let text_id: TextId = id.parse().map_err(failure)?;
        let text = self.cells.open_text(text_id).map_err(failure)?;
        Ok(Cell { value: Value::Text(text) })
    }
}

/// A handle to one cell. The value lives in shared memory, not here.
pub struct Cell {
    value: Value,
}

impl Cell {
    /// The id another process opens the same cell by.
    pub fn id(&self) -> String {
        match &self.value {
            Value::Int(cell) => cell.id().to_string(),
            Value::Float(cell) => cell.id().to_string(),
            Value::Bool(cell) => cell.id().to_string(),
            Value::Text(cell) => cell.id().to_string(),
        }
    }

    /// `int`, `float`, `bool` or `string`.
    pub fn kind(&self) -> String {
        match &self.value {
            Value::Int(_) => "int",
            Value::Float(_) => "float",
            Value::Bool(_) => "bool",
            Value::Text(_) => "string",
        }
        .to_owned()
    }

    pub fn get(&self) -> Result<CellValue> {
        Ok(match &self.value {
            Value::Int(cell) => CellValue::Int(cell.load().map_err(failure)?),
            Value::Float(cell) => {
                CellValue::Float(cell.load().map_err(failure)?)
            }
            Value::Bool(cell) => CellValue::Bool(cell.load().map_err(failure)?),
            Value::Text(cell) => CellValue::Text(cell.load().map_err(failure)?),
        })
    }

    pub fn set(
        &self,
        value: CellValue,
    ) -> Result<()> {
        match (&self.value, value) {
            (Value::Int(cell), CellValue::Int(value)) => cell.store(value),
            (Value::Int(cell), CellValue::Float(value)) => {
                cell.store(integer_number(value)?)
            }
            (Value::Float(cell), CellValue::Int(value)) => {
                cell.store(value as f64)
            }
            (Value::Float(cell), CellValue::Float(value)) => cell.store(value),
            (Value::Bool(cell), CellValue::Bool(value)) => cell.store(value),
            (Value::Text(cell), CellValue::Text(value)) => {
                return cell.store(&value).map_err(failure);
            }
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("a {} cell does not take that value", self.kind()),
                ));
            }
        }
        .map_err(failure)
    }

    /// Add atomically and return the value after; int and float cells.
    pub fn add(
        &self,
        by: f64,
    ) -> Result<CellValue> {
        match &self.value {
            Value::Int(cell) => cell
                .fetch_add(integer_number(by)?)
                .map(CellValue::Int)
                .map_err(failure),
            Value::Float(cell) => {
                cell.fetch_add(by).map(CellValue::Float).map_err(failure)
            }
            _ => Err(Error::new(
                Status::InvalidArg,
                format!("a {} cell cannot add {by}", self.kind()),
            )),
        }
    }

    /// Append atomically and return the text after; string cells.
    pub fn append(
        &self,
        text: String,
    ) -> Result<String> {
        let Value::Text(cell) = &self.value else {
            return Err(Error::new(
                Status::InvalidArg,
                "only a string cell can be appended to",
            ));
        };
        cell.append(&text).map_err(failure)?;
        cell.load().map_err(failure)
    }

    /// The write count. Take it before `get()`, and `wait()` misses nothing.
    pub fn version(&self) -> Result<u32> {
        match &self.value {
            Value::Int(cell) => cell.version(),
            Value::Float(cell) => cell.version(),
            Value::Bool(cell) => cell.version(),
            Value::Text(cell) => cell.version(),
        }
        .map_err(failure)
    }

    /// Resolve once the cell has been written since `since`, by any process;
    /// the write count then. Woken by the write, never by an interval.
    pub async fn wait(
        &self,
        since: u32,
    ) -> Result<u32> {
        let value = self.value.clone();
        tokio::task::spawn_blocking(move || match value {
            Value::Int(cell) => cell.wait_changed(since),
            Value::Float(cell) => cell.wait_changed(since),
            Value::Bool(cell) => cell.wait_changed(since),
            Value::Text(cell) => cell.wait_changed(since),
        })
        .await
        .map_err(failure)?
        .map_err(failure)
    }

    /// Give the cell back; every handle to it goes stale.
    pub fn release(&self) -> Result<()> {
        match self.value.clone() {
            Value::Int(cell) => cell.release(),
            Value::Float(cell) => cell.release(),
            Value::Bool(cell) => cell.release(),
            Value::Text(cell) => cell.release(),
        }
        .map_err(failure)
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

// The upper bound is exclusive: i64::MAX rounds up to 2^63 as an f64.
#[doc(hidden)]
pub fn integer_number(value: f64) -> Result<i64> {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value < -(i64::MIN as f64)
    {
        Ok(value as i64)
    } else {
        Err(Error::new(
            Status::InvalidArg,
            "expected a whole number in the i64 range",
        ))
    }
}

#[cfg(test)]
#[path = "../tests/unit/cells.rs"]
mod tests;
