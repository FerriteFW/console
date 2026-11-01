//! A migration copy (FRLB) to its layout 3 write plan as JSON, for doing the write by hand over the link:
//! `cargo run -p ferrite-console-core --example frlb_plan -- COPY.frlb > plan.json`.
use ferrite_console_core::migrate::{translate, write_plan, Copy};

fn main() {
    let path = std::env::args().nth(1).expect("usage: frlb_plan COPY.frlb");
    let copy = Copy::from_file(&std::fs::read(&path).expect("read the copy")).expect("a good FRLB copy");
    let t = translate(&copy).expect("translate");
    eprintln!("{:?}", t.summary);
    for n in &t.notes {
        eprintln!("note: {n}");
    }
    for r in &t.regions {
        eprintln!("region {} at {:#08x}, {} B", r.name, r.start, r.data.len());
    }
    let plan = write_plan(&t);
    println!("{}", serde_json::to_string(&plan).unwrap());
}
