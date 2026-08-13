import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

export interface HeaderMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

interface Props {
  dateLabel: string;
  isToday: boolean;
  onPrevDay: () => void;
  onNextDay: () => void;
  onJumpToToday: () => void;
  menuItems: HeaderMenuItem[];
}

export function DashboardHeader({
  dateLabel,
  isToday,
  onPrevDay,
  onNextDay,
  onJumpToToday,
  menuItems,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <View style={styles.wrap}>
      <View style={styles.pager}>
        <Pressable style={styles.chevron} onPress={onPrevDay} hitSlop={12} accessibilityLabel="Previous day">
          <Text style={styles.chevronText}>‹</Text>
        </Pressable>

        <Pressable
          style={styles.datePill}
          onPress={onJumpToToday}
          disabled={isToday}
          hitSlop={8}
          accessibilityLabel="Jump to today"
        >
          <Text style={styles.dateText}>{dateLabel}</Text>
        </Pressable>

        <Pressable
          style={styles.chevron}
          onPress={onNextDay}
          disabled={isToday}
          hitSlop={12}
          accessibilityLabel="Next day"
        >
          <Text style={[styles.chevronText, isToday && styles.chevronTextDisabled]}>›</Text>
        </Pressable>
      </View>

      <Pressable
        style={styles.menuButton}
        onPress={() => setMenuOpen(true)}
        hitSlop={12}
        accessibilityLabel="More options"
      >
        <Text style={styles.menuButtonText}>⋮</Text>
      </Pressable>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuCard}>
            {menuItems.map((item, index) => (
              <Pressable
                key={item.label}
                style={[styles.menuRow, index < menuItems.length - 1 && styles.menuRowDivider]}
                onPress={() => {
                  setMenuOpen(false);
                  item.onPress();
                }}
              >
                <Text style={[styles.menuRowText, item.destructive && styles.menuRowTextDestructive]}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.pillBackground,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xs,
  },
  chevron: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronText: {
    fontSize: 22,
    color: colors.textPrimary,
    fontWeight: "600",
  },
  chevronTextDisabled: {
    color: colors.textTertiary,
  },
  datePill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minWidth: 76,
    alignItems: "center",
  },
  dateText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  menuButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonText: {
    fontSize: 22,
    color: colors.textPrimary,
    fontWeight: "700",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "flex-end",
  },
  menuCard: {
    marginTop: 56,
    marginRight: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    minWidth: 220,
    overflow: "hidden",
  },
  menuRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  menuRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  menuRowText: {
    ...typography.body,
    color: colors.textPrimary,
  },
  menuRowTextDestructive: {
    color: colors.danger,
  },
});
