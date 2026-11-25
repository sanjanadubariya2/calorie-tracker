import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_ROWS,
  getNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
} from "@/lib/notifications";
import { disablePush, enablePush, getPushStatus, pushSupported, type PushStatus } from "@/lib/pushNotifications";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const PUSH_MESSAGES: Record<PushStatus, string> = {
  enabled: "Friend requests, challenge invitations and reminders, and comments can reach your lock screen.",
  denied: "Notifications are blocked for this app in your device settings.",
  unsupported: "Push notifications aren't available on this device or build. Everything still shows here in the app.",
  error: "Couldn't turn on push notifications. Check your connection and try again.",
};

/** Which notifications to receive, and the opt-in for push on this device. */
export function NotificationSettingsSheet({ visible, onClose }: Props) {
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([getNotificationPreferences(), getPushStatus()])
      .then(([p, s]) => { if (live) { setPrefs(p); setPush(s); } })
      .catch(() => { if (live) setError("Couldn't load your settings."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [visible]);

  async function update(patch: Partial<NotificationPreferences>) {
    const prev = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setSaving(true);
    setError(null);
    try {
      await saveNotificationPreferences(next);
    } catch {
      setPrefs(prev);
      setError("Couldn't save. Your previous setting is kept.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePush(on: boolean) {
    setSaving(true);
    setError(null);
    try {
      if (on) {
        const status = await enablePush();
        setPush(status);
        setPrefs((p) => ({ ...p, push_enabled: status === "enabled" }));
      } else {
        await disablePush();
        setPrefs((p) => ({ ...p, push_enabled: false }));
      }
    } finally {
      setSaving(false);
    }
  }

  const canPush = pushSupported() && push !== "unsupported";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="notification-settings-sheet">
          <View style={styles.titleRow}>
            <Text style={styles.title}>Notification settings</Text>
            <Pressable testID="notification-settings-close" onPress={onClose} style={styles.close}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>
          {loading ? (
            <ActivityIndicator color={colors.link} style={{ margin: spacing.xl }} />
          ) : (
            <ScrollView>
              <Text style={styles.section}>In the app</Text>
              {PREFERENCE_ROWS.map((r) => (
                <View key={r.key} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>{r.label}</Text>
                    <Text style={styles.hint}>{r.hint}</Text>
                  </View>
                  <Switch testID={`pref-${r.key}`} value={prefs[r.key]} disabled={saving}
                          onValueChange={(v) => update({ [r.key]: v })}
                          trackColor={{ true: colors.progressFill, false: colors.progressTrack }} />
                </View>
              ))}

              <Text style={styles.section}>Push notifications</Text>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Send to this device</Text>
                  <Text style={styles.hint} testID="push-status">
                    {prefs.push_enabled && push === "enabled" ? PUSH_MESSAGES.enabled
                      : push && push !== "enabled" ? PUSH_MESSAGES[push]
                      : "Off. Only personal things are pushed, at most a few a day. No reminders to log food."}
                  </Text>
                </View>
                <Switch testID="pref-push" value={prefs.push_enabled && push === "enabled"} disabled={saving || !canPush}
                        onValueChange={togglePush} trackColor={{ true: colors.progressFill, false: colors.progressTrack }} />
              </View>
              {push === "denied" ? (
                <Pressable testID="open-device-settings" onPress={() => Linking.openSettings().catch(() => undefined)}
                           style={styles.linkRow}>
                  <Text style={styles.link}>Open device settings</Text>
                </Pressable>
              ) : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
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
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg,
    maxHeight: "85%", borderWidth: 1, borderColor: colors.cardBorder,
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { ...typography.title, color: colors.textPrimary },
  close: { minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
  done: { ...typography.label, color: colors.link },
  section: { ...typography.label, color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md,
         borderBottomWidth: 1, borderBottomColor: colors.divider, minHeight: 56 },
  label: { ...typography.body, fontSize: 15, color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },
  linkRow: { paddingVertical: spacing.md, minHeight: 44 },
  link: { ...typography.label, color: colors.link },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
});
