use super::*;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

#[test]
fn parses_file_roots_and_preserves_existing_options() {
    let options = parse_options(&args(&[
        "--port",
        "4321",
        "--file-root",
        "/root",
        "--file-git-metadata-root",
        "/meta-a",
        "--file-git-metadata-root",
        "/meta-b",
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(options.port, 4321);
    assert_eq!(options.file_root, Some(PathBuf::from("/root")));
    assert_eq!(
        options.file_git_metadata_roots,
        [PathBuf::from("/meta-a"), PathBuf::from("/meta-b")]
    );
}

#[test]
fn rejects_missing_values_and_orphan_metadata() {
    for flag in ["--file-root", "--file-git-metadata-root"] {
        let error = parse_options(&args(&[flag])).unwrap_err();
        assert_eq!(error, format!("missing value for {flag}"));
        let error = parse_options(&args(&[flag, "--port", "1234"])).unwrap_err();
        assert_eq!(error, format!("missing value for {flag}"));
    }
    let error = parse_options(&args(&["--file-git-metadata-root", "/meta"])).unwrap_err();
    assert_eq!(error, "--file-git-metadata-root requires --file-root");
}

#[test]
fn help_describes_file_options() {
    let help = help_text();
    assert!(help.contains("--file-root PATH"));
    assert!(help.contains("--file-git-metadata-root PATH"));
    assert!(help.contains("HERDR_WEB_FILE_ROOT"));
}

#[test]
fn environment_child() {
    if std::env::var_os("HERDR_FILE_OPTIONS_TEST_CHILD").is_none() {
        return;
    }
    let options = parse_options(&[]).unwrap().unwrap();
    if std::env::var("HERDR_FILE_OPTIONS_TEST_CHILD").unwrap() == "default" {
        assert_eq!(options.file_root, None);
        assert!(options.file_git_metadata_roots.is_empty());
        assert!(open_file_roots(&options).unwrap().is_empty());
        return;
    }
    assert_eq!(options.file_root, Some(PathBuf::from("/environment-root")));
    let options = parse_options(&args(&["--file-root", "/cli-root"]))
        .unwrap()
        .unwrap();
    assert_eq!(options.file_root, Some(PathBuf::from("/cli-root")));
    let options = parse_options(&args(&["--file-git-metadata-root", "/meta"]))
        .unwrap()
        .unwrap();
    assert_eq!(options.file_root, Some(PathBuf::from("/environment-root")));
}

#[test]
fn environment_root_and_cli_precedence() {
    for (mode, root) in [("1", Some("/environment-root")), ("default", None)] {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "web_bridge::tests::file_options_tests::environment_child",
                "--nocapture",
            ])
            .env("HERDR_FILE_OPTIONS_TEST_CHILD", mode);
        if let Some(root) = root {
            child.env("HERDR_WEB_FILE_ROOT", root);
        } else {
            child.env_remove("HERDR_WEB_FILE_ROOT");
        }
        let output = child.output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
        assert!(output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn valid_roots_open_and_are_retained() {
    let options = parse_options(&args(&[
        "--file-root",
        ".",
        "--file-git-metadata-root",
        ".",
        "--file-git-metadata-root",
        ".",
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(open_file_roots(&options).unwrap().len(), 3);
}

#[cfg(not(target_os = "linux"))]
#[test]
fn configured_roots_fail_closed_on_unsupported_systems() {
    let options = parse_options(&args(&["--file-root", "."]))
        .unwrap()
        .unwrap();
    assert_eq!(
        open_file_roots(&options).err().unwrap().kind(),
        ErrorKind::Unsupported
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn invalid_roots_fail_before_other_startup_work() {
    use std::os::unix::fs::symlink;
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    let path = std::env::temp_dir().join(format!("herdr-file-options-{}", std::process::id()));
    std::fs::create_dir(&path).unwrap();
    let fixture = Fixture(path);
    std::fs::write(fixture.0.join("file"), b"not a directory").unwrap();
    symlink(".", fixture.0.join("link")).unwrap();
    let upload = fixture.0.join("uploads");
    for bad in [
        fixture.0.join("missing"),
        fixture.0.join("file"),
        fixture.0.join("link"),
    ] {
        let bad = bad.to_str().unwrap();
        for values in [
            vec!["--file-root", bad],
            vec!["--file-root", ".", "--file-git-metadata-root", bad],
        ] {
            let mut options = parse_options(&args(&values)).unwrap().unwrap();
            options.upload_dir = upload.clone();
            let error = run_server(options).await.unwrap_err();
            assert!(error.to_string().contains(bad), "{error}");
            assert!(!upload.exists());
        }
    }
}
