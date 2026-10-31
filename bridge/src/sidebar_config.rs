//! Read only Herdr's per-agent sidebar overrides for the web bridge.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_ROWS: usize = 16;
const MAX_TOKENS: usize = 16;
const MAX_RULES: usize = 16;
const AGENTS: &[&str] = &[
    "pi",
    "claude",
    "codex",
    "gemini",
    "cursor",
    "devin",
    "agy",
    "cline",
    "omp",
    "mastracode",
    "opencode",
    "copilot",
    "kimi",
    "kiro",
    "droid",
    "amp",
    "grok",
    "hermes",
    "kilo",
    "qodercli",
    "qwen",
    "letta",
    "maki",
    "muse",
];
const TOKENS: &[&str] = &[
    "state_icon",
    "state_text",
    "machine",
    "workspace",
    "tab",
    "pane",
    "agent",
    "terminal_title",
    "terminal_title_stripped",
];

#[derive(Default, Serialize)]
pub(crate) struct SidebarOverrides {
    pub rows_by_agent: BTreeMap<String, Vec<Vec<Token>>>,
}

#[derive(Deserialize)]
#[serde(default)]
struct Config {
    ui: Ui,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct Ui {
    sidebar: Sidebar,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct Sidebar {
    agents: Agents,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct Agents {
    rows_by_agent: BTreeMap<String, Vec<Vec<Token>>>,
}
impl Default for Config {
    fn default() -> Self {
        Self { ui: Ui::default() }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum Token {
    Plain(String),
    Styled(StyledToken),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StyledToken {
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dim: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    rules: Vec<Rule>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rule {
    #[serde(skip_serializing_if = "Option::is_none")]
    equals: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    contains: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    starts_with: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ignore_case: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dim: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hide: Option<bool>,
}

fn valid_color(color: &Option<String>) -> bool {
    color.as_ref().is_none_or(|color| {
        color.strip_prefix('#').is_some_and(|hex| {
            matches!(hex.len(), 3 | 6) && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    })
}

impl Rule {
    fn valid(&self) -> bool {
        let conditions = [
            self.equals.is_some(),
            self.contains.is_some(),
            self.starts_with.is_some(),
            self.gt.is_some(),
            self.lt.is_some(),
        ];
        let numeric = self.gt.is_some() || self.lt.is_some();
        conditions.into_iter().filter(|present| *present).count() == 1
            && (!numeric || self.ignore_case.is_none())
            && self.gt.is_none_or(f64::is_finite)
            && self.lt.is_none_or(f64::is_finite)
            && valid_color(&self.fg)
    }
}

impl Token {
    fn valid(&self) -> bool {
        let name = match self {
            Self::Plain(name) => name,
            Self::Styled(styled) => {
                if !valid_color(&styled.fg)
                    || styled.rules.len() > MAX_RULES
                    || (styled.token == "state_icon" && !styled.rules.is_empty())
                    || !styled.rules.iter().all(Rule::valid)
                {
                    return false;
                }
                &styled.token
            }
        };
        TOKENS.contains(&name.as_str())
            || name.strip_prefix('$').is_some_and(|custom| {
                !custom.is_empty()
                    && custom.len() <= 32
                    && custom
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
    }
}

fn parse(input: &str) -> Option<SidebarOverrides> {
    let config: Config = toml::from_str(input).ok()?;
    let rows_by_agent = config.ui.sidebar.agents.rows_by_agent;
    if rows_by_agent.iter().any(|(agent, rows)| {
        !AGENTS.contains(&agent.as_str())
            || rows.len() > MAX_ROWS
            || rows
                .iter()
                .any(|row| row.len() > MAX_TOKENS || !row.iter().all(Token::valid))
    }) {
        return None;
    }
    Some(SidebarOverrides { rows_by_agent })
}

fn config_path(
    explicit: Option<OsString>,
    xdg: Option<OsString>,
    home: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return Some(path.into());
    }
    if let Some(path) = xdg.filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path).join("herdr/config.toml"));
    }
    home.filter(|value| !value.is_empty())
        .map(|path| PathBuf::from(path).join(".config/herdr/config.toml"))
}

/// Returns only valid per-agent overrides; missing or invalid config uses web defaults.
pub(crate) fn load_sidebar_overrides() -> SidebarOverrides {
    let path = config_path(
        std::env::var_os("HERDR_CONFIG_PATH"),
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    );
    let mut input = String::new();
    let Some(file) = path.and_then(|path| std::fs::File::open(path).ok()) else {
        return SidebarOverrides::default();
    };
    if file
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut input)
        .is_err()
        || input.len() as u64 > MAX_CONFIG_BYTES
    {
        return SidebarOverrides::default();
    }
    parse(&input).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn encoded(input: &str) -> Option<serde_json::Value> {
        parse(input).map(|value| serde_json::to_value(value).unwrap())
    }

    #[test]
    fn chooses_process_environment_path_in_precedence_order() {
        let v = |s: &str| Some(OsString::from(s));
        assert_eq!(
            config_path(v("/explicit"), v("/xdg"), v("/home")),
            Some(PathBuf::from("/explicit"))
        );
        assert_eq!(
            config_path(v(""), v("/xdg"), v("/home")),
            Some(PathBuf::from(""))
        );
        assert_eq!(
            config_path(None, v("/xdg"), v("/home")),
            Some(PathBuf::from("/xdg/herdr/config.toml"))
        );
        assert_eq!(
            config_path(None, v(""), v("/home")),
            Some(PathBuf::from("/home/.config/herdr/config.toml"))
        );
        assert_eq!(config_path(None, None, None), None);
    }

    #[test]
    fn returns_only_overrides_and_preserves_empty_layouts() {
        let input = r##"
secret = 'not-for-clients'
[ui.sidebar.agents]
rows = [['machine']]
row_gap = 2
[ui.sidebar.agents.rows_by_agent]
claude = []
pi = [['state_icon', { token = '$load', fg = '#abc', bold = false, rules = [{ gt = 80, hide = true }, { starts_with = 'low', ignore_case = true, dim = true }] }]]
"##;
        assert_eq!(
            encoded(input),
            Some(json!({"rows_by_agent": {
                "claude": [], "pi": [["state_icon", {"token": "$load", "fg": "#abc", "bold": false,
                    "rules": [{"gt": 80.0, "hide": true}, {"starts_with": "low", "ignore_case": true, "dim": true}]}]]
            }}))
        );
        assert_eq!(encoded(""), Some(json!({"rows_by_agent": {}})));
    }

    #[test]
    fn rejects_invalid_tokens_styles_rules_and_agents() {
        for entry in [
            "'bad'",
            "'$'",
            "'$bad.name'",
            "{ token = 'agent', secret = 'hidden' }",
            "{ token = 'agent', fg = 'red' }",
            "{ token = 'state_icon', rules = [{ equals = 'x' }] }",
            "{ token = 'agent', rules = [{ gt = 3, ignore_case = false }] }",
            "{ token = 'agent', rules = [{ gt = nan }] }",
            "{ token = 'agent', rules = [{ equals = 'x', contains = 'x' }] }",
        ] {
            assert!(
                encoded(&format!(
                    "[ui.sidebar.agents.rows_by_agent]\npi = [[{entry}]]"
                ))
                .is_none(),
                "{entry}"
            );
        }
        assert!(encoded("[ui.sidebar.agents.rows_by_agent]\n'claude-code' = []").is_none());
        assert!(encoded("[ui.sidebar.agents.rows_by_agent]\npi = 'invalid'").is_none());
    }

    #[test]
    fn bounds_rows_tokens_rules_and_custom_names() {
        for count in [16, 17] {
            let rows = vec!["['agent']"; count].join(",");
            assert_eq!(
                encoded(&format!("[ui.sidebar.agents.rows_by_agent]\npi = [{rows}]")).is_some(),
                count == 16
            );
            let tokens = vec!["'agent'"; count].join(",");
            assert_eq!(
                encoded(&format!(
                    "[ui.sidebar.agents.rows_by_agent]\npi = [[{tokens}]]"
                ))
                .is_some(),
                count == 16
            );
            let rules = vec!["{ equals = 'x' }"; count].join(",");
            assert_eq!(encoded(&format!("[ui.sidebar.agents.rows_by_agent]\npi = [[{{ token = 'agent', rules = [{rules}] }}]]")).is_some(), count == 16);
        }
        for count in [32, 33] {
            assert_eq!(
                encoded(&format!(
                    "[ui.sidebar.agents.rows_by_agent]\npi = [['${}']]",
                    "x".repeat(count)
                ))
                .is_some(),
                count == 32
            );
        }
    }
}
