import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, fonts, radius, spacing, typography } from "@/constants/theme";

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
  /** Profile lives behind this button now that it is no longer a tab. */
  onProfilePress?: () => void;
}

export function DashboardHeader({
  dateLabel,
  isToday,
  onPrevDay,
  onNextDay,
  onJumpToToday,
  menuItems,
  onProfilePress,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <View style={styles.wrap}>
      <View style={styles.pager}>
        <Pressable style={styles.chevron} onPress={onPrevDay} hitSlop={12} accessibilityLabel="Previous day">
          <Feather name="chevron-left" size={20} color={colors.textPrimary} />
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
          <Feather name="chevron-right" size={20} color={isToday ? colors.textTertiary : colors.textPrimary} />
        </Pressable>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={styles.menuButton}
          onPress={() => setMenuOpen(true)}
          hitSlop={8}
          accessibilityLabel="More options"
        >
          <Feather name="more-horizontal" size={20} color={colors.textPrimary} />
        </Pressable>
        {onProfilePress && (
          <Pressable style={styles.profileButton} onPress={onProfilePress} hitSlop={8} accessibilityLabel="Profile">
            <Feather name="user" size={20} color={colors.textPrimary} />
          </Pressable>
        )}
      </View>

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
    marginBottom: 20,
  },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    padding: spacing.xs,
  },
  chevron: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  datePill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minWidth: 76,
    alignItems: "center",
  },
  dateText: {
    fontFamily: fonts.displayBold,
    fontWeight: "700",
    fontSize: 17,
    color: colors.textPrimary,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.badgeActive,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(19,32,26,0.45)",
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
