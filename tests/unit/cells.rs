use super::*;

fn cells() -> Cells {
    Cells::attach(Arc::new(Fleet::join("numbers", 1).unwrap())).unwrap()
}

#[test]
fn refused_integer_numbers_leave_value_and_version_unchanged() {
    let cells = cells();
    let cell = cells.int(Some(7)).unwrap();
    let lower = i64::MIN as f64;
    let upper = -lower;
    for value in [
        1e30,
        -1e30,
        upper,
        f64::from_bits(lower.to_bits() + 1),
        1.5,
        -1.5,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        let version = cell.version().unwrap();
        assert!(cell.set(CellValue::Float(value)).is_err(), "set {value}");
        assert_eq!(cell.get().unwrap(), CellValue::Int(7));
        assert_eq!(cell.version().unwrap(), version);
        assert!(cell.add(value).is_err(), "add {value}");
        assert_eq!(cell.get().unwrap(), CellValue::Int(7));
        assert_eq!(cell.version().unwrap(), version);
    }
}

#[test]
fn representable_integer_boundaries_keep_their_exact_value() {
    let cells = cells();
    let cell = cells.int(None).unwrap();
    let lower = i64::MIN as f64;
    let upper = -lower;
    for value in [
        lower,
        f64::from_bits(lower.to_bits() - 1),
        f64::from_bits(upper.to_bits() - 1),
        -0.0,
        42.0,
    ] {
        let expected = CellValue::Int(value as i64);
        cell.set(CellValue::Float(value)).unwrap();
        assert_eq!(cell.get().unwrap(), expected);
        cell.set(CellValue::Int(0)).unwrap();
        assert_eq!(cell.add(value).unwrap(), expected);
    }
    cell.set(CellValue::Int(i64::MAX)).unwrap();
    let version = cell.version().unwrap();
    assert!(cell.add(1.0).is_err());
    assert_eq!(cell.get().unwrap(), CellValue::Int(i64::MAX));
    assert_eq!(cell.version().unwrap(), version);
}
