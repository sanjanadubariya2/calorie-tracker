import React from "react";
import { Modal, Pressable, StyleSheet, Text } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  friend: { username: string | null } | null;
  onRemove: () => void;
  onBlock: () => void;
  onReport?: () => void;
  onClose: () => void;
}

/** Long-press options for a friend: remove, or block. */
export function FriendActionsSheet({ friend, onRemove, onBlock, onReport, onClose }: Props) {
  return (
    <Modal visible={friend !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{friend?.username ? `@${friend.username}` : "Friend"}</Text>
          <Pressable testID="friend-action-remove" style={styles.row} onPress={onRemove}>
            <Text style={styles.rowText}>Remove friend</Text>
          </Pressable>
          <Pressable testID="friend-action-block" style={styles.row} onPress={onBlock}>
            <Text style={[styles.rowText, styles.danger]}>Block</Text>
          </Pressable>
          {onReport ? (
            <Pressable testID="friend-action-report" style={styles.row} onPress={onReport}>
              <Text style={styles.rowText}>Report profile</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.row} onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: spacing.lg },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.cardBorder },
  title: { ...typography.title, fontSize: 18, color: colors.textPrimary, marginBottom: spacing.sm },
  row: { paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.divider },
  rowText: { ...typography.body, color: colors.textPrimary },
  danger: { color: colors.danger },
  cancel: { ...typography.body, color: colors.textSecondary },
});
