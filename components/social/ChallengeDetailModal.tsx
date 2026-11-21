import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { colors, radius, spacing, typography } from "@/constants/theme";
import {
  daysLeft,
  getChallengeParticipants,
  kindLabel,
  metricLabel,
  progressMessage,
  stateLabel,
  type ChallengeParticipant,
  type MyChallenge,
} from "@/lib/challenges";
import { ChallengeProgress } from "./ChallengeProgress";
import { StateChip } from "./ChallengeCards";

interface Props {
  challenge: MyChallenge | null;
  today: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onCheckIn: (c: MyChallenge) => void;
  onLeave: (c: MyChallenge) => void;
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Challenge details, my progress, and (for friend challenges) everyone's day counts, alphabetically. */
export function ChallengeDetailModal({ challenge: c, today, busy, error, onClose, onCheckIn, onLeave }: Props) {
  const [people, setPeople] = useState<ChallengeParticipant[] | null>(null);
  const [peopleError, setPeopleError] = useState(false);

  const id = c?.challenge_id;
  const isApp = c?.kind === "app";
  const progress = c?.progress_days;
  useEffect(() => {
    setPeople(null);
    setPeopleError(false);
    if (!id || isApp) return;
    let live = true;
    getChallengeParticipants(id)
      .then((p) => { if (live) setPeople(p); })
      .catch(() => { if (live) setPeopleError(true); });
    return () => { live = false; };
  }, [id, isApp, progress]);   // reload after my progress changes

  if (!c) return null;
  const left = daysLeft(c.ends_on, today);
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="challenge-detail">
          <View style={styles.titleRow}>
            <Text style={styles.title}>{c.title}</Text>
            <Pressable testID="challenge-detail-close" onPress={onClose} hitSlop={12}>
              <Text style={styles.done}>Close</Text>
            </Pressable>
          </View>
          <ScrollView>
            <View style={styles.chips}>
              <StateChip state={c.state} />
              <Text style={styles.meta}>{kindLabel(c.kind)}</Text>
            </View>
            <Text style={styles.body}>{c.description}</Text>
            <Text style={styles.meta}>
              {formatDay(c.starts_on)} – {formatDay(c.ends_on)} · {metricLabel(c.metric)}
            </Text>

            <View style={styles.progressCard}>
              <Text style={styles.section}>Your progress</Text>
              <ChallengeProgress progress={c.progress_days} target={c.target_days} completed={c.state === "completed"} />
              <Text style={styles.message}>{progressMessage(c, left)}</Text>
              {c.metric === "checkin_days" && c.state === "active" ? (
                c.checked_in_today ? (
                  <Text style={styles.checked}>✓ Checked in today</Text>
                ) : (
                  <Pressable testID="detail-checkin" style={styles.primary} onPress={() => onCheckIn(c)} disabled={busy}>
                    {busy ? <ActivityIndicator color="#0A0A0A" /> : <Text style={styles.primaryText}>{c.checkin_label ?? "Check in"}</Text>}
                  </Pressable>
                )
              ) : null}
              {c.metric === "checkin_days" ? (
                <Text style={styles.small}>Self-reported: check in once a day, for today only.</Text>
              ) : (
                <Text style={styles.small}>Counted automatically from the days you log meals.</Text>
              )}
            </View>

            {c.safety_note ? <Text style={styles.safety}>💚 {c.safety_note}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}

            {c.kind !== "app" ? (
              <>
                <Text style={styles.section}>Taking part</Text>
                {peopleError ? (
                  <Text style={styles.small}>Couldn't load participants.</Text>
                ) : people === null ? (
                  <ActivityIndicator color={colors.progressFill} />
                ) : (
                  people.map((p) => (
                    <View key={p.user_id} style={styles.person} testID={`participant-${p.user_id}`}>
                      <Avatar seed={p.user_id} photoUrl={p.avatar_url} label={p.username ?? undefined} size={32} />
                      <Text style={styles.personName} numberOfLines={1}>
                        {p.is_me ? "You" : p.username ? `@${p.username}` : "Friend"}
                      </Text>
                      <Text style={styles.personState}>
                        {p.state === "active" || p.state === "completed"
                          ? `${Math.min(p.progress_days, p.target_days)}/${p.target_days} days`
                          : stateLabel(p.state)}
                      </Text>
                    </View>
                  ))
                )}
              </>
            ) : (
              <Text style={styles.small}>App challenges are open to everyone; other participants aren't listed.</Text>
            )}

            {c.state === "active" || c.state === "upcoming" ? (
              <Pressable testID="detail-leave" style={styles.leave} onPress={() => onLeave(c)} disabled={busy}>
                <Text style={styles.leaveText}>Leave challenge</Text>
              </Pressable>
            ) : null}
          </ScrollView>
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
  done: { ...typography.label, color: colors.progressFill },
  chips: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  body: { ...typography.body, fontSize: 15, color: colors.textSecondary, marginTop: spacing.md, lineHeight: 21 },
  meta: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.xs },
  progressCard: { backgroundColor: colors.pillBackground, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.lg },
  section: { ...typography.label, color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.sm },
  message: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  small: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.sm },
  checked: { ...typography.label, color: colors.progressFill, marginTop: spacing.md },
  primary: {
    backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm,
    alignItems: "center", marginTop: spacing.md,
  },
  primaryText: { ...typography.label, color: "#0A0A0A" },
  safety: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.md, lineHeight: 17 },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
  person: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  personName: { ...typography.body, fontSize: 15, color: colors.textPrimary, flex: 1 },
  personState: { ...typography.caption, color: colors.textSecondary },
  leave: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.lg },
  leaveText: { ...typography.label, color: colors.danger },
});
