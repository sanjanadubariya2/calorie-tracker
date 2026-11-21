import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { REACTIONS, type EventInteractions, type ReactionType } from "@/lib/interactions";

interface Props {
  eventId: string;
  value: EventInteractions;
  /** Own events: counts only, no reacting to yourself. */
  readOnly?: boolean;
  onReact: (next: ReactionType | null) => void;
  onOpenComments: () => void;
}

/** Four positive reactions with counts; tapping your current one removes it. */
export function ReactionBar({ eventId, value, readOnly, onReact, onOpenComments }: Props) {
  return (
    <View style={styles.row}>
      {REACTIONS.map((r) => {
        const count = value.counts[r.type];
        const on = value.mine === r.type;
        if (readOnly && count === 0) return null;
        return (
          <Pressable
            key={r.type}
            testID={`react-${eventId}-${r.type}`}
            disabled={readOnly}
            onPress={() => onReact(on ? null : r.type)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${r.label}${count ? `, ${count}` : ""}`}
            hitSlop={6}
          >
            <Text style={styles.emoji}>{r.emoji}</Text>
            {count > 0 ? <Text style={[styles.count, on && styles.countOn]}>{count}</Text> : null}
          </Pressable>
        );
      })}
      <View style={{ flex: 1 }} />
      <Pressable testID={`comments-${eventId}`} onPress={onOpenComments} style={styles.chip} hitSlop={4}
                 accessibilityRole="button" accessibilityLabel={`Comments${value.comments ? `, ${value.comments}` : ""}`}>
        <Text style={styles.emoji}>💬</Text>
        {value.comments > 0 ? <Text style={styles.count}>{value.comments}</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.pill, borderWidth: 1,
    borderColor: colors.cardBorder, paddingHorizontal: 10, paddingVertical: 4, minHeight: 34, minWidth: 40,
    justifyContent: "center",
  },
  chipOn: { borderColor: colors.progressFill, backgroundColor: "rgba(126,211,33,0.12)" },
  emoji: { fontSize: 14 },
  count: { ...typography.caption, color: colors.textSecondary },
  countOn: { color: colors.progressFill },
});
