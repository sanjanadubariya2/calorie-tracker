import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import {
  DEFAULT_SETTINGS,
  getBlockedUsers,
  getSocialSettings,
  saveSocialSettings,
  unblockUser,
  type BlockedUser,
  type SocialSettings,
} from "@/lib/socialActivity";

interface Props {
  visible: boolean;
  /** `changed` is true when something was saved, so the feed can reload. */
  onClose: (changed: boolean) => void;
}

const KIND_ROWS: { key: keyof SocialSettings; label: string; hint: string }[] = [
  { key: "share_streaks", label: "Streak milestones", hint: "e.g. a 7-day logging streak" },
  { key: "share_habits", label: "Habit milestones", hint: "e.g. meals logged on 30 days" },
  { key: "share_achievements", label: "Achievements", hint: "e.g. a first completed challenge" },
  { key: "share_challenges", label: "Challenges", hint: "joining and completing challenges" },
];

/** Who sees my activity, and who I've blocked. Saved by the database under RLS. */
export function SharingSettingsModal({ visible, onClose }: Props) {
  const [settings, setSettings] = useState<SocialSettings>(DEFAULT_SETTINGS);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setLoading(true);
    setError(null);
    setChanged(false);
    Promise.all([getSocialSettings(), getBlockedUsers()])
      .then(([s, b]) => { if (live) { setSettings(s); setBlocked(b); } })
      .catch(() => { if (live) setError("Couldn't load your settings."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [visible]);

  async function update(patch: Partial<SocialSettings>) {
    const prev = settings;
    const next = { ...settings, ...patch };
    setSettings(next);              // optimistic; reverted on failure
    setSaving(true);
    setError(null);
    try {
      await saveSocialSettings(next);
      setChanged(true);
    } catch {
      setSettings(prev);
      setError("Couldn't save. Your previous setting is kept.");
    } finally {
      setSaving(false);
    }
  }

  async function unblock(userId: string) {
    setError(null);
    try {
      await unblockUser(userId);
      setBlocked((b) => b.filter((x) => x.user_id !== userId));
      setChanged(true);
    } catch {
      setError("Couldn't unblock. Try again.");
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => onClose(changed)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="sharing-settings">
          <View style={styles.titleRow}>
            <Text style={styles.title}>Activity visibility</Text>
            <Pressable testID="sharing-close" onPress={() => onClose(changed)} hitSlop={12}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>
          {loading ? (
            <ActivityIndicator color={colors.link} style={{ marginVertical: spacing.xl }} />
          ) : (
            <ScrollView>
              <View style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.label}>Share my activity with friends</Text>
                  <Text style={styles.hint}>Off by default. Only accepted friends can see it.</Text>
                </View>
                <Switch
                  testID="share-activity"
                  value={settings.share_activity}
                  disabled={saving}
                  onValueChange={(v) => update({ share_activity: v })}
                  trackColor={{ true: colors.progressFill, false: colors.progressTrack }}
                />
              </View>
              {KIND_ROWS.map((r) => (
                <View key={r.key} style={[styles.row, !settings.share_activity && styles.dim]}>
                  <View style={styles.rowText}>
                    <Text style={styles.label}>{r.label}</Text>
                    <Text style={styles.hint}>{r.hint}</Text>
                  </View>
                  <Switch
                    testID={r.key}
                    value={settings[r.key]}
                    disabled={saving || !settings.share_activity}
                    onValueChange={(v) => update({ [r.key]: v })}
                    trackColor={{ true: colors.progressFill, false: colors.progressTrack }}
                  />
                </View>
              ))}
              <Text style={styles.never}>
                Never shared: what you eat, calories, nutrition, weight or any health details.
              </Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Text style={styles.section}>Blocked</Text>
              {blocked.length === 0 ? (
                <Text style={styles.hint}>You haven't blocked anyone.</Text>
              ) : (
                blocked.map((b) => (
                  <View key={b.user_id} style={styles.row}>
                    <Text style={[styles.label, styles.rowText]}>{b.username ? `@${b.username}` : "Unknown user"}</Text>
                    <Pressable testID={`unblock-${b.user_id}`} style={styles.pill} onPress={() => unblock(b.user_id)}>
                      <Text style={styles.pillText}>Unblock</Text>
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(19,32,26,0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: spacing.lg, maxHeight: "85%", borderWidth: 1, borderColor: colors.cardBorder,
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  done: { ...typography.label, color: colors.link },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  rowText: { flex: 1 },
  dim: { opacity: 0.45 },
  label: { ...typography.body, fontSize: 15, color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  never: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.md, lineHeight: 17 },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
  section: { ...typography.label, color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.xs },
  pill: { borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  pillText: { ...typography.caption, color: colors.textPrimary },
});
