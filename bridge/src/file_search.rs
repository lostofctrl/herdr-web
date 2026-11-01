//! Bounded, confined filename and content search.
//!
//! The walk is descriptor-relative like every other file operation: it never
//! follows a symbolic link, never leaves the pinned root, and stops at a depth,
//! entry, byte or result limit so one request cannot traverse an unbounded tree.
//! Content search reads only bounded regular files and reports the first match.

use crate::file_root::FileRoot;
use std::io;
use std::path::{Path, PathBuf};

const MAX_SEARCH_DEPTH: usize = 8;
const MAX_SCAN_ENTRIES: usize = 50_000;
const MAX_RESULTS: usize = 200;
pub(crate) const DEFAULT_LIMIT: usize = 200;
const MAX_CONTENT_BYTES: usize = 256 * 1024;
const MAX_QUERY_BYTES: usize = 256;
const MAX_DIR_ENTRIES: usize = 10_000;
const SKIPPED_DIRECTORIES: [&str; 1] = [".git"];

pub(crate) struct SearchHit {
    pub(crate) path: String,
    pub(crate) line: Option<usize>,
}

/// Rejects an unusable query before any directory is touched.
pub(crate) fn validate(query: &str, limit: usize) -> io::Result<()> {
    if query.is_empty() || query.len() > MAX_QUERY_BYTES || query.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid search query",
        ));
    }
    if limit == 0 || limit > MAX_RESULTS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid search limit",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
struct Walk {
    depth: usize,
    entries: usize,
    results: Vec<SearchHit>,
    query: String,
    content: bool,
    limit: usize,
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn search(
        &self,
        query: &str,
        content: bool,
        limit: usize,
    ) -> io::Result<Vec<SearchHit>> {
        validate(query, limit)?;
        let mut walk = Walk {
            depth: 0,
            entries: 0,
            results: Vec::new(),
            query: query.to_lowercase(),
            content,
            limit,
        };
        walk.directory(self, Path::new(""), 0)?;
        Ok(walk.results)
    }
}

#[cfg(target_os = "linux")]
impl Walk {
    fn directory(&mut self, root: &FileRoot, path: &Path, depth: usize) -> io::Result<()> {
        if depth > MAX_SEARCH_DEPTH || self.results.len() >= self.limit {
            return Ok(());
        }
        let listed = match if path.as_os_str().is_empty() {
            root.list_typed(Path::new(""), MAX_DIR_ENTRIES)
        } else {
            root.list_typed(path, MAX_DIR_ENTRIES)
        } {
            Ok(listed) => listed,
            // A directory removed between listing and opening is not a search failure.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in listed {
            if self.results.len() >= self.limit || self.entries >= MAX_SCAN_ENTRIES {
                return Ok(());
            }
            self.entries += 1;
            let Some(name) = entry.path.file_name() else {
                continue;
            };
            if entry.kind == "directory" {
                if SKIPPED_DIRECTORIES.iter().any(|skipped| *skipped == name) {
                    continue;
                }
                self.directory(root, &entry.path, depth + 1)?;
                continue;
            }
            if entry.kind != "file" {
                // Symbolic links and other entries are never followed by search.
                continue;
            }
            let relative = self.relative(&entry.path);
            if relative.to_lowercase().contains(&self.query) {
                self.results.push(SearchHit {
                    path: relative,
                    line: None,
                });
                continue;
            }
            if !self.content {
                continue;
            }
            if let Some(line) = self.first_matching_line(root, &entry.path) {
                self.results.push(SearchHit {
                    path: relative,
                    line: Some(line),
                });
            }
        }
        Ok(())
    }

    fn first_matching_line(&self, root: &FileRoot, path: &Path) -> Option<usize> {
        let bytes = root.read_file(path, MAX_CONTENT_BYTES).ok()?;
        if bytes.contains(&0) {
            return None;
        }
        let text = std::str::from_utf8(&bytes).ok()?;
        text.lines()
            .position(|line| line.to_lowercase().contains(&self.query))
            .map(|index| index + 1)
    }

    fn relative(&self, path: &PathBuf) -> String {
        path.to_string_lossy().into_owned()
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
impl FileRoot {
    pub(crate) fn search(
        &self,
        query: &str,
        content: bool,
        limit: usize,
    ) -> io::Result<Vec<SearchHit>> {
        validate(query, limit)?;
        let _ = content;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "confined file search requires Linux",
        ))
    }
}
