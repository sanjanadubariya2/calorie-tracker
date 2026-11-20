import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { ItemEdit } from "@/lib/assistant";
import type { ChatItem } from "@/lib/assistantState";
import { ProposalCard } from "./ProposalCard";
import { ResponseCard, SourcesLine } from "./ResponseCards";

interface Props {
  item: ChatItem;
  busy: boolean;
  onAsk: (text: string) => void;
  onRetry: (clientMessageId: string) => void;
  onConfirm: (proposalId: string, edits: { meal_type?: string; items?: ItemEdit[] }) => Promise<unknown>;
  onCancel: (proposalId: string) => Promise<unknown>;
}

export function MessageBubble({ item, busy, onAsk, onRetry, onConfirm, onCancel }: Props) {
  if (item.role === "user") {
    return (
      <View style={styles.userWrap} testID={`message-${item.key}`}>
        <View style={[styles.userBubble, item.status === "failed" && styles.failed]}>
          <Text style={styles.userText}>{item.content}</Text>
        </View>
        {item.status === "failed" && item.error && (
          <View style={styles.failRow} testID="message-error">
            <Text style={styles.errorText}>{item.error.message}</Text>
            {item.error.retryable && item.clientMessageId && (
              <Pressable onPress={() => onRetry(item.clientMessageId!)} disabled={busy} hitSlop={8} testID="message-retry">
                <Text style={styles.retry}>Retry</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    );
  }

  const r = item.response;
  const isError = r?.type === "error";
  return (
    <View style={styles.assistantWrap} testID={`message-${item.key}`}>
      <View style={[styles.assistantBubble, isError && styles.errorBubble]}>
        <Text style={[styles.assistantText, isError && { color: colors.textSecondary }]}>{item.content}</Text>
        {r && r.type === "proposed_action" ? (
          <ProposalCard
            proposal={r.action.proposal}
            onConfirm={(edits) => onConfirm(r.action.proposal.id, edits)}
            onCancel={() => onCancel(r.action.proposal.id)}
          />
        ) : r ? (
          <ResponseCard response={r} onAsk={onAsk} disabled={busy} />
        ) : null}
        {r && !isError && <SourcesLine sources={r.sources} />}
      </View>
    </View>
  );
}

export function TypingIndicator() {
  return (
    <View style={styles.assistantWrap} testID="assistant-thinking">
      <View style={styles.assistantBubble}>
        <Text style={styles.thinking}>Thinking…</Text>
        <Text style={styles.thinkingSub}>This can take a few seconds.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  userWrap: { alignItems: "flex-end", marginVertical: spacing.xs },
  userBubble: {
    backgroundColor: colors.pillBackground, borderRadius: radius.md, borderBottomRightRadius: 4,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, maxWidth: "85%",
  },
  failed: { borderWidth: 1, borderColor: colors.danger },
  userText: { ...typography.body, color: colors.textPrimary },
  failRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 4, maxWidth: "85%" },
  errorText: { ...typography.caption, color: colors.danger, flexShrink: 1 },
  retry: { ...typography.label, color: colors.progressFill },
  assistantWrap: { alignItems: "flex-start", marginVertical: spacing.xs },
  assistantBubble: {
    backgroundColor: colors.card, borderRadius: radius.md, borderBottomLeftRadius: 4, borderWidth: 1,
    borderColor: colors.cardBorder, padding: spacing.md, maxWidth: "92%", width: "92%",
  },
  errorBubble: { borderColor: colors.divider },
  assistantText: { ...typography.body, color: colors.textPrimary },
  thinking: { ...typography.label, color: colors.textPrimary },
  thinkingSub: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
});
