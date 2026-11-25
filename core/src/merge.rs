//! LINK-21.1: a settings (or APRS settings) write puts the edits on the radio as it is now. The record read before
//! the write (`fresh`) is the start; only the fields the editor changed since its own read (`base` -> `edited`) are
//! taken from the edits. A field the radio changed since that read and the editor didn't (the home channel, the FM
//! radio's frequency, a setting changed on the radio's menu) keeps the radio's value; a field both changed takes the
//! edit, and the write dialog says so.
//!
//! A field is what the record's writer puts in one piece (an integer, a text, a byte): bytes are never taken half
//! from one side and half from the other, but for a byte of packed on/off flags, merged flag by flag.

use crate::settings::{Change, Extras};
use serde::Serialize;

/// One field of a record: `len` bytes at `at`; `bits` for a byte of packed flags (merged bit by bit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub at: usize,
    pub len: usize,
    pub bits: bool,
}

/// A field shown by a name of its own when the radio changed it (no menu item shows it): its name and its value.
pub struct Named {
    pub at: usize,
    pub name: &'static str,
    pub value: fn(&[u8]) -> String,
}

/// The write's record and values, and what the radio changed since the editor's read.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Merged {
    pub record: Vec<u8>,
    pub extras: Extras,
    /// What changed on the radio since the editor's read (`from` as read, `to` as the radio holds it now).
    pub radio: Vec<Change>,
    /// Of those, the ones the edits replace (`from` the radio's value now, `to` the edit's).
    pub overridden: Vec<Change>,
}

/// Every field over `len` bytes: `fields`, and each byte they don't cover as a field of its own.
fn cover(fields: &[Field], len: usize) -> Vec<Field> {
    let mut out = Vec::new();
    let mut n = 0;
    let mut fs: Vec<Field> = fields.iter().copied().filter(|f| f.at + f.len <= len).collect();
    fs.sort_by_key(|f| f.at);
    for f in fs {
        if f.at < n {
            continue;
        }
        out.extend((n..f.at).map(|at| Field { at, len: 1, bits: false }));
        out.push(f);
        n = f.at + f.len;
    }
    out.extend((n..len).map(|at| Field { at, len: 1, bits: false }));
    out
}

/// The three-way merge of the record: per field, the edit when it differs from `base`, else the radio's (`fresh`).
/// Records of different lengths (another firmware's layout) aren't merged: the edited record goes, and the write's
/// plan refuses it (LINK-21).
pub fn bytes(fields: &[Field], base: &[u8], edited: &[u8], fresh: &[u8]) -> Vec<u8> {
    if base.len() != edited.len() || fresh.len() != edited.len() {
        return edited.to_vec();
    }
    let mut out = fresh.to_vec();
    for f in cover(fields, edited.len()) {
        let r = f.at..f.at + f.len;
        if f.bits {
            for i in r {
                let mine = base[i] ^ edited[i];
                out[i] = (fresh[i] & !mine) | (edited[i] & mine);
            }
        } else if edited[r.clone()] != base[r.clone()] {
            out[r.clone()].copy_from_slice(&edited[r]);
        }
    }
    out
}

/// The terminal-backed values merged the same way, value by value.
pub fn extras(base: &Extras, edited: &Extras, fresh: &Extras) -> Extras {
    let mut out = fresh.clone();
    for (k, v) in edited {
        if base.get(k) != Some(v) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn other(n: usize, what: &str) -> Change {
    Change {
        id: "other".into(),
        path: String::new(),
        group: String::new(),
        name: what.into(),
        from: String::new(),
        to: format!("{n} {} no menu item shows", if n == 1 { "value" } else { "values" }),
    }
}

/// The merge and its report. `diff` is the record's own (menu items, then one "other" line when no item differs);
/// `named` the fields with no menu item that get a line of their own. `whole`: the edited record goes as it is (a
/// loaded file: a backup or a codeplug, LINK-21.1), the radio's changes since the read listed as replaced.
#[allow(clippy::too_many_arguments)]
pub fn merge(
    fields: &[Field],
    named: &[Named],
    base: (&[u8], &Extras),
    edited: (&[u8], &Extras),
    fresh: (&[u8], &Extras),
    other_name: &str,
    whole: bool,
    diff: impl Fn(&[u8], &Extras, &[u8], &Extras) -> Vec<Change>,
) -> Merged {
    let (record, ex) = if whole {
        (edited.0.to_vec(), edited.1.clone())
    } else {
        (bytes(fields, base.0, edited.0, fresh.0), extras(base.1, edited.1, fresh.1))
    };
    let mut radio: Vec<Change> = diff(base.0, base.1, fresh.0, fresh.1).into_iter().filter(|c| c.id != "other").collect();
    let mut overridden: Vec<Change> = if radio.is_empty() {
        Vec::new()
    } else {
        diff(fresh.0, fresh.1, &record, &ex).into_iter().filter(|c| radio.iter().any(|r| r.id == c.id)).collect()
    };
    // The fields the radio changed that no menu item shows: by name, or counted as one line.
    if base.0.len() == fresh.0.len() && fresh.0.len() == record.len() {
        let (mut hidden, mut hidden_over) = (0, 0);
        for f in cover(fields, fresh.0.len()) {
            let r = f.at..f.at + f.len;
            if base.0[r.clone()] == fresh.0[r.clone()] {
                continue;
            }
            let mut probe = base.0.to_vec();
            probe[r.clone()].copy_from_slice(&fresh.0[r.clone()]);
            if diff(base.0, base.1, &probe, base.1).iter().any(|c| c.id != "other") {
                continue; // a menu item shows it: listed above
            }
            let over = record[r.clone()] != fresh.0[r.clone()];
            if let Some(n) = named.iter().find(|n| n.at == f.at) {
                let line = |from: &[u8], to: &[u8]| Change {
                    id: format!("field.{}", f.at),
                    path: String::new(),
                    group: String::new(),
                    name: n.name.into(),
                    from: (n.value)(from),
                    to: (n.value)(to),
                };
                radio.push(line(base.0, fresh.0));
                if over {
                    overridden.push(line(fresh.0, &record));
                }
            } else {
                hidden += 1;
                hidden_over += over as usize;
            }
        }
        if hidden > 0 {
            radio.push(other(hidden, other_name));
        }
        if hidden_over > 0 {
            overridden.push(other(hidden_over, other_name));
        }
    }
    Merged { record, extras: ex, radio, overridden }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: [Field; 2] = [Field { at: 0, len: 2, bits: false }, Field { at: 3, len: 1, bits: true }];

    /// LINK-21.1: per field, the edit where the editor changed it, the radio's elsewhere; never half of each.
    #[test]
    fn bytes_by_field() {
        let base = [1, 1, 0, 0b0000];
        // The editor changed byte 2 and flag 0; the radio the u16 (its high byte) and flag 1.
        let edited = [1, 1, 7, 0b0001];
        let fresh = [1, 9, 5, 0b0010];
        assert_eq!(bytes(&F, &base, &edited, &fresh), vec![1, 9, 7, 0b0011]);
        // Both changed the u16, the editor only its low byte: the edit's whole field wins, not a mix.
        let edited = [2, 1, 0, 0];
        assert_eq!(bytes(&F, &base, &edited, &fresh), vec![2, 1, 5, 0b0010]);
        // Another length: the edited record as it is.
        assert_eq!(bytes(&F, &base, &edited, &[0; 5]), edited.to_vec());
    }

    /// LINK-21.1: the values no record carries merge value by value.
    #[test]
    fn extras_by_value() {
        let m = |p: &[(&str, &str)]| -> Extras { p.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() };
        let base = m(&[("a", "1"), ("b", "1"), ("c", "1")]);
        let edited = m(&[("a", "2"), ("b", "1"), ("c", "3")]);
        let fresh = m(&[("a", "1"), ("b", "5"), ("c", "4"), ("d", "1")]);
        assert_eq!(extras(&base, &edited, &fresh), m(&[("a", "2"), ("b", "5"), ("c", "3"), ("d", "1")]));
    }
}
