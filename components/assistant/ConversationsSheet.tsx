import React, { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Conversation } from "@/lib/assistant";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface Props {
  visible: boolean;
  conversations: Conversation[];
  activeId: string | null;
  hasMore: boolean;
  error: string | null;
  onClose: () => void;
  onOpen: (id: string | null) => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ConversationsSheet({ visible, conversations, activeId, hasMore, error, onClose, onOpen, onDelete, onLoadMore }: Props) {
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="conversations-sheet">
          <View style={styles.header}>
            <Text style={styles.title}>Conversations</Text>
            <Pressable onPress={onClose} hitSlop={12} testID="conversations-close"><Text style={styles.close}>✕</Text></Pressable>
          </View>
          <Pressable style={styles.newButton} onPress={() => onOpen(null)} testID="conversation-new">
            <Text style={styles.newText}>+ New conversation</Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <FlatList
            data={conversations}
            keyExtractor={(c) => c.id}
            onEndReached={hasMore ? onLoadMore : undefined}
            ListEmptyComponent={<Text style={styles.empty}>No conversations yet.</Text>}
            renderItem={({ item }) => (
              <Pressable style={[styles.row, item.id === activeId && styles.rowActive]} onPress={() => onOpen(item.id)}
                testID={`conversation-${item.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{item.title ?? "New conversation"}</Text>
                  <Text style={styles.rowSub}>{when(item.updated_at)} · {item.message_count} messages</Text>
                </View>
                <Pressable onPress={() => setPendingDelete(item)} hitSlop={10} testID={`conversation-delete-${item.id}`}>
                  <Text style={styles.delete}>Delete</Text>
                </Pressable>
              </Pressable>
            )}
          />
          <Text style={styles.retention}>Conversations are deleted after 90 days without activity.</Text>
        </View>
      </View>
      <ConfirmDialog
        visible={pendingDelete !== null}
        title="Delete conversation?"
        message="This removes all of its messages. Foods you've logged stay in your log."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (pendingDelete) onDelete(pendingDelete.id); setPendingDelete(null); }}
        onCancel={() => setPendingDelete(null)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(19,32,26,0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: spacing.lg, maxHeight: "80%",
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { ...typography.title, color: colors.textPrimary },
  close: { fontSize: 18, color: colors.textSecondary },
  newButton: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm, alignItems: "center", marginVertical: spacing.md },
  newText: { ...typography.label, color: colors.onAccent },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  rowActive: { backgroundColor: colors.pillBackground, borderRadius: radius.sm, paddingHorizontal: spacing.sm },
  rowTitle: { ...typography.label, color: colors.textPrimary },
  rowSub: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  delete: { ...typography.caption, color: colors.danger },
  empty: { ...typography.caption, color: colors.textSecondary, textAlign: "center", marginVertical: spacing.lg },
  error: { ...typography.caption, color: colors.danger, marginBottom: spacing.sm },
  retention: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.md, textAlign: "center" },
});
