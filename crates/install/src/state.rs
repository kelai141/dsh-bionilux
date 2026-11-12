//! 槽位状态机：允许多个 runtime 并存，但「可用」只有一个权威判据。
//!
//! 合法边来自上游契约 §4。`Ready` 之后的事实（工具是否真能执行）不在这里——它由执行探针决定，
//! 所以本模块只保证「状态不会被非法跳变污染」，不保证「Ready 代表能用」。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotState {
    #[default]
    NotInstalled,
    PreparingAssets,
    Verifying,
    InstalledDisabled,
    Activating,
    Ready,
    Updating,
    Disabling,
    Failed,
}

impl SlotState {
    pub fn can_transition_to(self, next: SlotState) -> bool {
        use SlotState::*;
        if self == next {
            return true;
        }
        matches!(
            (self, next),
            (NotInstalled, PreparingAssets)
                | (PreparingAssets, Verifying)
                | (PreparingAssets, Failed)
                | (Verifying, InstalledDisabled)
                | (Verifying, Failed)
                | (InstalledDisabled, Activating)
                | (InstalledDisabled, PreparingAssets)
                | (Activating, Ready)
                | (Activating, Failed)
                | (Ready, Updating)
                | (Ready, Disabling)
                | (Updating, Ready)
                | (Updating, Failed)
                | (Disabling, InstalledDisabled)
                | (Failed, NotInstalled)
                | (Failed, PreparingAssets)
                | (Ready, NotInstalled)
                | (InstalledDisabled, NotInstalled)
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub state: SlotState,
    #[serde(default)]
    pub runtime_version: Option<String>,
    #[serde(default)]
    pub rootfs_sha256: Option<String>,
    #[serde(default)]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub schema_version: u32,
    pub default_runtime_id: Option<String>,
    #[serde(default)]
    pub runtimes: BTreeMap<String, Slot>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            schema_version: STATE_SCHEMA_VERSION,
            default_runtime_id: None,
            runtimes: BTreeMap::new(),
        }
    }
}

pub const STATE_SCHEMA_VERSION: u32 = 1;

impl Store {
    /// 读状态；文件缺失或损坏都回到默认值（损坏不能阻止用户重装）。
    pub fn load(path: &Path) -> Store {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Store>(&text).ok())
            .map(|store| Store {
                schema_version: STATE_SCHEMA_VERSION,
                ..store
            })
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建状态目录失败: {e}"))?;
        }
        let text =
            serde_json::to_string_pretty(self).map_err(|e| format!("序列化状态失败: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("写入状态失败: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("状态落位失败: {e}"))
    }

    pub fn slot(&self, runtime_id: &str) -> Slot {
        self.runtimes.get(runtime_id).cloned().unwrap_or_default()
    }

    /// 迁移一个槽位；非法边直接报错（调用方应该发现自己算错了状态）。
    pub fn transition(&mut self, runtime_id: &str, next: SlotState) -> Result<(), String> {
        let current = self.slot(runtime_id);
        if !current.state.can_transition_to(next) {
            return Err(format!(
                "非法状态迁移: {:?} -> {:?}（{runtime_id}）",
                current.state, next
            ));
        }
        let slot = self.runtimes.entry(runtime_id.to_string()).or_default();
        slot.state = next;
        slot.updated_at = now_secs();
        Ok(())
    }

    pub fn set_default(&mut self, runtime_id: &str) {
        self.default_runtime_id = Some(runtime_id.to_string());
    }
}

fn now_secs() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "linux-runtime-state-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn happy_path_reaches_ready() {
        let mut store = Store::default();
        for next in [
            SlotState::PreparingAssets,
            SlotState::Verifying,
            SlotState::InstalledDisabled,
            SlotState::Activating,
            SlotState::Ready,
        ] {
            store.transition("debian-minimal", next).unwrap();
        }
        assert_eq!(store.slot("debian-minimal").state, SlotState::Ready);
    }

    #[test]
    fn rejects_shortcut_to_ready() {
        let mut store = Store::default();
        assert!(store.transition("r", SlotState::Ready).is_err());
    }

    #[test]
    fn failure_is_absorbing_until_reset() {
        let mut store = Store::default();
        store.transition("r", SlotState::PreparingAssets).unwrap();
        store.transition("r", SlotState::Failed).unwrap();
        assert!(store.transition("r", SlotState::Verifying).is_err());
        store.transition("r", SlotState::NotInstalled).unwrap();
        assert_eq!(store.slot("r").state, SlotState::NotInstalled);
    }

    #[test]
    fn roundtrip_persists_slots_and_default() {
        let dir = scratch("roundtrip");
        let path = dir.join("state.json");
        let mut store = Store::default();
        store.transition("a", SlotState::PreparingAssets).unwrap();
        store.transition("b", SlotState::PreparingAssets).unwrap();
        store.set_default("a");
        store.save(&path).unwrap();

        let loaded = Store::load(&path);
        assert_eq!(loaded.default_runtime_id.as_deref(), Some("a"));
        assert_eq!(loaded.runtimes.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_state_falls_back_to_default() {
        let dir = scratch("corrupt");
        let path = dir.join("state.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(Store::load(&path).runtimes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
