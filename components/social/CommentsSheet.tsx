import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { relativeTime } from "@/lib/relativeTime";
import { describeActivity, type ActivityEvent } from "@/lib/socialActivity";
import {
  COMMENT_MAX,
  addComment,
  deleteComment,
  describeInteractionError,
  getComments,
  validateComment,
  type ActivityComment,
} from "@/lib/interactions";
import { ReportSheet } from "./ReportSheet";

interface Props {
  event: ActivityEvent | null;
  onClose: (changed: boolean) => void;
}

/** Comments on one feed event: read, post, delete (own, or any on my event), report. */
export function CommentsSheet({ event, onClose }: Props) {
  const [comments, setComments] = useState<ActivityComment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [changed, setChanged] = useState(false);
  const [reporting, setReporting] = useState<ActivityComment | null>(null);
  const inFlight = useRef(false);
  const id = event?.id;

  async function load(eventId: string) {
    try {
      setComments(await getComments(eventId));
      setLoadError(null);
    } catch (e) {
      setLoadError(describeInteractionError(e));
    }
  }

  useEffect(() => {
    setComments(null);
    setDraft("");
    setError(null);
    setChanged(false);
    if (id) load(id);
  }, [id]);

  if (!event) return null;
  const chars = [...draft.trim()].length;

  async function post() {
    if (!event || inFlight.current) return;
    const v = validateComment(draft);
    if (!v.ok) { setError(v.error); return; }
    inFlight.current = true;
    setPosting(true);
    setError(null);
    try {
      await addComment(event.id, v.body);
      setDraft("");
      setChanged(true);
      await load(event.id);
    } catch (e) {
      setError(describeInteractionError(e));
    } finally {
      inFlight.current = false;
      setPosting(false);
    }
  }

  async function remove(c: ActivityComment) {
    if (!event) return;
    setComments((cur) => cur?.filter((x) => x.id !== c.id) ?? cur);
    try {
      await deleteComment(c.id);
      setChanged(true);
    } catch (e) {
      setError(describeInteractionError(e));
      await load(event.id);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={() => onClose(changed)}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.sheet} testID="comments-sheet">
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={2}>{describeActivity(event).title}</Text>
            <Pressable testID="comments-close" onPress={() => onClose(changed)} hitSlop={12}>
              <Text style={styles.done}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.list}>
            {loadError ? (
              <Text style={styles.error}>{loadError}</Text>
            ) : comments === null ? (
              <ActivityIndicator color={colors.progressFill} style={{ margin: spacing.lg }} />
            ) : comments.length === 0 ? (
              <Text style={styles.empty} testID="comments-empty">No comments yet. Say something encouraging!</Text>
            ) : (
              comments.map((c) => (
                <View key={c.id} style={styles.comment} testID={`comment-${c.id}`}>
                  <Avatar seed={c.author_id} photoUrl={c.author_avatar_url} label={c.author_username ?? undefined} size={32} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.author}>
                      {c.is_mine ? "You" : c.author_username ? `@${c.author_username}` : "Friend"}
                      <Text style={styles.time}>  {relativeTime(c.created_at)}</Text>
                    </Text>
                    <Text style={styles.body}>{c.body}</Text>
                    <View style={styles.actions}>
                      {c.can_delete ? (
                        <Pressable testID={`delete-comment-${c.id}`} onPress={() => remove(c)} hitSlop={12}>
                          <Text style={styles.action}>Delete</Text>
                        </Pressable>
                      ) : null}
                      {!c.is_mine ? (
                        <Pressable testID={`report-comment-${c.id}`} onPress={() => setReporting(c)} hitSlop={12}>
                          <Text style={styles.action}>Report</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
          {error ? <Text style={styles.error} testID="comment-error">{error}</Text> : null}
          <Text style={styles.audience} testID="comment-audience">
            {commentAudience(event)}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              testID="comment-input"
              style={styles.input}
              value={draft}
              onChangeText={(t) => { setDraft(t); setError(null); }}
              placeholder="Add a kind word…"
              placeholderTextColor={colors.textTertiary}
              multiline
              maxLength={COMMENT_MAX + 20}
            />
            <Pressable testID="comment-post" style={[styles.post, (chars === 0 || chars > COMMENT_MAX || posting) && styles.disabled]}
                       disabled={chars === 0 || chars > COMMENT_MAX || posting} onPress={post}>
              {posting ? <ActivityIndicator color="#0A0A0A" /> : <Text style={styles.postText}>Post</Text>}
            </Pressable>
          </View>
          <Text style={[styles.counter, chars > COMMENT_MAX && { color: colors.danger }]}>{chars}/{COMMENT_MAX}</Text>
        </View>
      </KeyboardAvoidingView>
      <ReportSheet
        target={reporting ? { kind: "comment", id: reporting.id, label: "this comment" } : null}
        onClose={(reported) => {
          if (reported && reporting) setComments((cur) => cur?.filter((x) => x.id !== reporting.id) ?? cur);
          if (reported) setChanged(true);
          setReporting(null);
        }}
      />
    </Modal>
  );
}

/**
 * Who will read a comment (migration 027): the event's owner, and the
 * commenter's own friends who can see the event. Shown before posting.
 */
export function commentAudience(event: Pick<ActivityEvent, "is_me" | "actor_username">): string {
  if (event.is_me) return "👥 Visible to your friends who can see this milestone.";
  const owner = event.actor_username ? `@${event.actor_username}` : "the owner";
  return `👥 Visible to ${owner} and to your friends who can see this milestone. Others won't see it.`;
}

const styles = StyleSheet.create({
  audience: { ...typography.caption, fontSize: 11, color: colors.textTertiary, marginTop: spacing.sm, lineHeight: 15 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg,
    maxHeight: "85%", borderWidth: 1, borderColor: colors.cardBorder,
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md, marginBottom: spacing.sm },
  title: { ...typography.label, fontSize: 16, color: colors.textPrimary, flex: 1 },
  done: { ...typography.label, color: colors.progressFill },
  list: { maxHeight: 380 },
  empty: { ...typography.caption, color: colors.textSecondary, textAlign: "center", padding: spacing.lg },
  comment: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.sm },
  author: { ...typography.label, color: colors.textPrimary },
  time: { ...typography.caption, color: colors.textTertiary, fontWeight: "400" },
  body: { ...typography.body, fontSize: 15, color: colors.textSecondary, marginTop: 2, lineHeight: 20 },
  actions: { flexDirection: "row", gap: spacing.md, marginTop: 4 },
  action: { ...typography.caption, color: colors.textTertiary, paddingVertical: 6 },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.sm },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, marginTop: spacing.md },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: radius.md, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, color: colors.textPrimary, maxHeight: 100, ...typography.body, fontSize: 15,
  },
  post: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  postText: { ...typography.label, color: "#0A0A0A" },
  disabled: { opacity: 0.4 },
  counter: { ...typography.caption, fontSize: 11, color: colors.textTertiary, textAlign: "right", marginTop: 4 },
});
