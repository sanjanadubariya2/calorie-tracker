import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { CatalogEntry } from "@/lib/challenges";

export interface InvitableFriend {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
}

interface Props {
  entry: CatalogEntry | null;
  loadFriends: () => Promise<InvitableFriend[]>;
  busy?: boolean;
  error?: string | null;
  onStart: (entry: CatalogEntry, invite: string[], startsTomorrow: boolean) => void;
  onClose: () => void;
}

const MAX_INVITES = 9;

/** Start a personal challenge, or a friend challenge by inviting up to 9 friends. */
export function StartChallengeModal({ entry, loadFriends, busy, error, onStart, onClose }: Props) {
  const [friends, setFriends] = useState<InvitableFriend[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [tomorrow, setTomorrow] = useState(false);

  const code = entry?.template_code;
  useEffect(() => {
    if (!code) return;
    let live = true;
    setSelected([]);
    setTomorrow(false);
    setFriends(null);
    loadFriends().then((f) => { if (live) setFriends(f); }).catch(() => { if (live) setFriends([]); });
    return () => { live = false; };
  }, [code, loadFriends]);

  if (!entry) return null;
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_INVITES ? [...s, id] : s));

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="start-challenge">
          <View style={styles.titleRow}>
            <Text style={styles.title}>{entry.title}</Text>
            <Pressable onPress={onClose} hitSlop={12} testID="start-close">
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.body}>{entry.description}</Text>

          <Text style={styles.section}>Starts</Text>
          <View style={styles.segment}>
            {[false, true].map((t) => (
              <Pressable key={String(t)} testID={t ? "start-tomorrow" : "start-today"}
                         style={[styles.segmentItem, tomorrow === t && styles.segmentActive]} onPress={() => setTomorrow(t)}>
                <Text style={[styles.segmentText, tomorrow === t && styles.segmentTextActive]}>{t ? "Tomorrow" : "Today"}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.section}>Invite friends (optional)</Text>
          <ScrollView style={{ maxHeight: 240 }}>
            {friends === null ? (
              <ActivityIndicator color={colors.progressFill} />
            ) : friends.length === 0 ? (
              <Text style={styles.small}>No friends to invite yet. You can still do it on your own.</Text>
            ) : (
              friends.map((f) => {
                const on = selected.includes(f.user_id);
                return (
                  <Pressable key={f.user_id} testID={`invite-${f.user_id}`} style={styles.friend} onPress={() => toggle(f.user_id)}
                             accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                    <Avatar seed={f.user_id} photoUrl={f.avatar_url} label={f.username ?? undefined} size={32} />
                    <Text style={styles.friendName}>{f.username ? `@${f.username}` : "Friend"}</Text>
                    <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.tick}>✓</Text> : null}</View>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
          <Text style={styles.small}>
            Friends see each other's day counts in the challenge, listed alphabetically. Nothing about what you eat.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable testID="start-confirm" style={styles.primary} disabled={busy}
                     onPress={() => onStart(entry, selected, tomorrow)}>
            {busy ? <ActivityIndicator color="#0A0A0A" /> : (
              <Text style={styles.primaryText}>
                {selected.length ? `Start with ${selected.length} friend${selected.length === 1 ? "" : "s"}` : "Start challenge"}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: spacing.lg, maxHeight: "90%", borderWidth: 1, borderColor: colors.cardBorder,
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary, flex: 1 },
  cancel: { ...typography.label, color: colors.textSecondary },
  body: { ...typography.caption, fontSize: 14, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 19 },
  section: { ...typography.label, color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.sm },
  segment: { flexDirection: "row", backgroundColor: colors.pillBackground, borderRadius: radius.pill, padding: 3 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: spacing.sm, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.cardBorder },
  segmentText: { ...typography.label, color: colors.textSecondary },
  segmentTextActive: { color: colors.textPrimary },
  friend: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  friendName: { ...typography.body, fontSize: 15, color: colors.textPrimary, flex: 1 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.cardBorder, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.progressFill, borderColor: colors.progressFill },
  tick: { fontSize: 13, fontWeight: "700", color: "#0A0A0A" },
  small: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm, lineHeight: 17 },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
  primary: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.lg },
  primaryText: { ...typography.label, color: "#0A0A0A" },
});
