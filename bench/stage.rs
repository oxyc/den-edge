//! Copy deterministic fixtures from a read-only mount into the measured cgroup, then become den-edge.

use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn main() {
    copy_tree(Path::new("/fixtures/data"), Path::new("/data")).expect("stage data fixtures");
    copy_tree(Path::new("/fixtures/web"), Path::new("/web")).expect("stage web fixtures");
    let error = Command::new("/den-edge").exec();
    panic!("exec den-edge: {error}");
}
