import React, { useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { REPORT_REASONS, describeInteractionError, reportContent, type ReportReason } from "@/lib/interactions";

interface Props {
  target: { kind: "comment" | "profile"; id: string; label: string } | null;
  onClose: (reported: boolean) => void;
}

/** Report a comment or a profile. Reports are reviewed by a moderator. */
export function ReportSheet({ target, onClose }: Props) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!target) return null;
  const close = (reported: boolean) => { setReason(null); setError(null); setDone(false); onClose(reported); };

  async function submit() {
    if (!reason || !target) return;
    setBusy(true);
    setError(null);
    try {
      await reportContent(target.kind, target.id, reason);
      setDone(true);
    } catch (e) {
      setError(describeInteractionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(done)}>
      <Pressable style={styles.backdrop} onPress={() => close(done)}>
        <Pressable style={styles.card} onPress={() => {}} testID="report-sheet">
          {done ? (
            <>
              <Text style={styles.title}>Thanks for letting us know</Text>
              <Text style={styles.body}>
                {target.kind === "comment" ? "You won't see this comment any more. " : ""}A moderator will review it.
                You can also block this person from the Friends list.
              </Text>
              <Pressable testID="report-done" style={styles.primary} onPress={() => close(true)}>
                <Text style={styles.primaryText}>Done</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.title}>Report {target.label}</Text>
              {REPORT_REASONS.map((r) => (
                <Pressable key={r.reason} testID={`report-${r.reason}`} style={styles.row} onPress={() => setReason(r.reason)}
                           accessibilityRole="radio" accessibilityState={{ selected: reason === r.reason }}>
                  <View style={[styles.radio, reason === r.reason && styles.radioOn]} />
                  <Text style={styles.rowText}>{r.label}</Text>
                </Pressable>
              ))}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <View style={styles.actions}>
                <Pressable onPress={() => close(false)} style={styles.secondary}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
                <Pressable testID="report-submit" onPress={submit} disabled={!reason || busy}
                           style={[styles.primary, styles.flex, (!reason || busy) && styles.disabled]}>
                  {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.primaryText}>Report</Text>}
                </Pressable>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(19,32,26,0.45)", justifyContent: "center", padding: spacing.lg },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.cardBorder },
  title: { ...typography.title, fontSize: 18, color: colors.textPrimary, marginBottom: spacing.sm },
  body: { ...typography.body, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.cardBorder },
  radioOn: { borderColor: colors.progressFill, backgroundColor: colors.progressFill },
  rowText: { ...typography.body, fontSize: 15, color: colors.textPrimary },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  flex: { flex: 1, marginTop: 0 },
  primary: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm, alignItems: "center", marginTop: spacing.lg },
  primaryText: { ...typography.label, color: colors.onAccent },
  secondary: { borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  secondaryText: { ...typography.label, color: colors.textPrimary },
  disabled: { opacity: 0.4 },
});
