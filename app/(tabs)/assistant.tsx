import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { useAuth } from "@/lib/auth-context";
import { useAssistant } from "@/lib/assistant-context";
import { DRAFT, activeThread, type ChatItem } from "@/lib/assistantState";
import { MessageBubble, TypingIndicator } from "@/components/assistant/MessageBubble";
import { ConversationsSheet } from "@/components/assistant/ConversationsSheet";

const QUICK_ACTIONS = [
  "How many calories have I consumed today?",
  "How much protein do I have remaining?",
  "Suggest a meal for today",
  "Summarize my weekly nutrition",
  "Show my recent meals",
];

const MAX_CHARS = 2000;

export default function AssistantScreen() {
  const { signOut } = useAuth();
  const a = useAssistant();
  const { state } = a;
  const [text, setText] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<FlatList<ChatItem>>(null);

  useEffect(() => {
    if (a.available && !state.conversationsLoaded) void a.loadConversations();
  }, [a, state.conversationsLoaded]);

  if (!a.available) {
    return (
      <View style={[styles.wrap, styles.center]} testID="assistant-unavailable">
        <Text style={styles.title}>Assistant</Text>
        <Text style={styles.muted}>The nutrition assistant isn't available in this version of the app.</Text>
      </View>
    );
  }

  const threadId = state.activeId ?? DRAFT;
  const thread = activeThread(state);
  const sending = state.sending[threadId] ?? false;
  const title = state.conversations.find((c) => c.id === state.activeId)?.title ?? "Assistant";
  const items = [...thread.items].reverse();        // inverted list: newest at the bottom

  function submit(value: string = text) {
    const v = value.trim();
    if (!v || sending) return;
    setText("");
    void a.send(v);
    listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }

  async function signInAgain() {
    await signOut();
    router.replace("/");
  }

  return (
    <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Pressable onPress={() => setHistoryOpen(true)} hitSlop={12} testID="open-history">
          <Text style={styles.headerIcon}>☰</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        <Pressable onPress={() => a.openConversation(null)} hitSlop={12} disabled={state.activeId === null} testID="new-conversation">
          <Text style={[styles.headerIcon, state.activeId === null && { opacity: 0.3 }]}>✎</Text>
        </Pressable>
      </View>

      {state.authExpired && (
        <View style={styles.banner} testID="auth-expired">
          <Text style={styles.bannerText}>Your session has expired.</Text>
          <Pressable onPress={signInAgain} testID="sign-in-again"><Text style={styles.bannerLink}>Sign in again</Text></Pressable>
        </View>
      )}

      {thread.items.length === 0 && !sending ? (
        <View style={styles.empty} testID="assistant-empty">
          {state.activeId !== null && !thread.loaded ? (
            <ActivityIndicator color={colors.progressFill} />
          ) : (
            <>
              <Text style={styles.emptyTitle}>Ask about your nutrition</Text>
              <Text style={styles.muted}>
                I can check your log, compare it with your targets, suggest meals and prepare food logs for you to confirm.
              </Text>
              <View style={styles.quick}>
                {QUICK_ACTIONS.map((q) => (
                  <Pressable key={q} style={styles.quickChip} onPress={() => submit(q)} disabled={sending} testID={`quick-${q}`}>
                    <Text style={styles.quickText}>{q}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.disclaimer}>
                General information, not medical advice. Messages are processed by our AI provider.
              </Text>
            </>
          )}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          inverted
          data={items}
          keyExtractor={(i) => i.key}
          contentContainerStyle={styles.list}
          ListHeaderComponent={sending ? <TypingIndicator /> : null}
          ListFooterComponent={thread.loadingOlder ? <ActivityIndicator color={colors.textSecondary} style={{ margin: spacing.md }} /> : null}
          onEndReached={thread.nextBeforeSeq ? () => void a.loadOlder() : undefined}
          onEndReachedThreshold={0.3}
          keyboardShouldPersistTaps="handled"
          testID="message-list"
          renderItem={({ item }) => (
            <MessageBubble
              item={item}
              busy={sending}
              onAsk={submit}
              onRetry={(id) => void a.retry(id)}
              onConfirm={a.confirm}
              onCancel={a.reject}
            />
          )}
        />
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Ask about your nutrition…"
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={MAX_CHARS}
          editable={!state.authExpired}
          testID="composer-input"
        />
        <Pressable
          style={[styles.send, (!text.trim() || sending) && styles.sendDisabled]}
          onPress={() => submit()}
          disabled={!text.trim() || sending || state.authExpired}
          testID="composer-send"
        >
          <Text style={styles.sendText}>{sending ? "…" : "↑"}</Text>
        </Pressable>
      </View>

      <ConversationsSheet
        visible={historyOpen}
        conversations={state.conversations}
        activeId={state.activeId}
        hasMore={state.conversationsCursor !== null}
        error={state.listError}
        onClose={() => setHistoryOpen(false)}
        onOpen={(id) => { setHistoryOpen(false); void a.openConversation(id); }}
        onDelete={(id) => void a.removeConversation(id)}
        onLoadMore={() => void a.loadConversations(true)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.xl },
  center: { alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.sm },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  headerTitle: { ...typography.title, color: colors.textPrimary, flex: 1, textAlign: "center", marginHorizontal: spacing.md },
  headerIcon: { fontSize: 20, color: colors.textPrimary, width: 24, textAlign: "center" },
  banner: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: colors.card,
    borderColor: colors.danger, borderWidth: 1, borderRadius: radius.sm, margin: spacing.md, padding: spacing.sm,
  },
  bannerText: { ...typography.caption, color: colors.textPrimary },
  bannerLink: { ...typography.label, color: colors.progressFill },
  empty: { flex: 1, paddingHorizontal: spacing.lg, justifyContent: "center" },
  emptyTitle: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.sm },
  muted: { ...typography.body, color: colors.textSecondary, textAlign: "left" },
  quick: { marginTop: spacing.lg, gap: spacing.sm },
  quickChip: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.md,
    paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md,
  },
  quickText: { ...typography.label, color: colors.textPrimary },
  disclaimer: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.lg },
  list: { paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  composer: {
    flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, padding: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.divider,
  },
  input: {
    flex: 1, maxHeight: 120, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textPrimary, ...typography.body,
  },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.progressFill, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.4 },
  sendText: { fontSize: 18, fontWeight: "700", color: colors.background },
});
