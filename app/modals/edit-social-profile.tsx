import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { getProfile } from "@/lib/api";
import {
  isUsernameAvailable,
  normalizeUsername,
  setAvatarUrl,
  setUsername,
  validateUsername,
} from "@/lib/social";
import { deleteAvatar, pickAvatarImage, uploadAvatar } from "@/lib/avatarUpload";
import { Avatar } from "@/components/Avatar";
import { colors, radius, spacing, typography } from "@/constants/theme";

export default function EditSocialProfileModal() {
  const { userId } = useAuth();

  const [username, setUsernameText] = useState("");
  const [originalUsername, setOriginalUsername] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrlState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    getProfile(userId)
      .then((p) => {
        setOriginalUsername(p?.username ?? null);
        setUsernameText(p?.username ?? "");
        setAvatarUrlState(p?.avatar_url ?? null);
      })
      .finally(() => setLoading(false));
  }, [userId]);

  async function handlePickPhoto() {
    if (!userId) return;
    setError(null);
    const image = await pickAvatarImage();
    if (!image) {
      setNote("No photo selected. Photo library access is needed to upload one.");
      return;
    }

    setUploading(true);
    try {
      const url = await uploadAvatar(userId, image);
      await setAvatarUrl(userId, url);
      setAvatarUrlState(url);
      setNote("Photo updated.");
    } catch {
      setError("Couldn't upload that photo. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemovePhoto() {
    if (!userId) return;
    setUploading(true);
    try {
      await deleteAvatar(userId);
      await setAvatarUrl(userId, null);
      setAvatarUrlState(null);
      setNote("Back to your generated avatar.");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!userId) return;
    setError(null);
    setNote(null);

    const validationError = validateUsername(username);
    if (validationError) {
      setError(validationError);
      return;
    }

    const normalized = normalizeUsername(username);
    setSaving(true);
    try {
      if (normalized !== originalUsername) {
        const available = await isUsernameAvailable(normalized, userId);
        if (!available) {
          setError(`@${normalized} is already taken.`);
          return;
        }
        await setUsername(userId, normalized);
      }
      router.back();
    } catch {
      setError("Couldn't save your profile. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.centerScreen}>
        <ActivityIndicator color={colors.link} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.closeButton}>✕</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Your profile</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.avatarBlock}>
          <Avatar
            seed={userId ?? "me"}
            photoUrl={avatarUrl}
            label={username || undefined}
            size={96}
          />
          <Text style={styles.avatarHint}>
            {avatarUrl
              ? "Your photo is visible to friends you connect with."
              : "This avatar is generated from your account — nobody else has the same one."}
          </Text>

          <View style={styles.avatarActions}>
            <Pressable
              style={[styles.secondaryButton, uploading && styles.disabled]}
              onPress={handlePickPhoto}
              disabled={uploading}
            >
              <Text style={styles.secondaryButtonText}>
                {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Add photo"}
              </Text>
            </Pressable>
            {avatarUrl && (
              <Pressable
                style={[styles.secondaryButton, uploading && styles.disabled]}
                onPress={handleRemovePhoto}
                disabled={uploading}
              >
                <Text style={styles.secondaryButtonText}>Remove</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Username</Text>
          <View style={styles.inputRow}>
            <Text style={styles.atSign}>@</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={(t) => {
                setUsernameText(t);
                setError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="yourname"
              placeholderTextColor={colors.textTertiary}
            />
          </View>
          <Text style={styles.hint}>
            3–20 characters: letters, numbers, and underscores. This is how friends find you, and
            the only thing they see — your age, height, and weight stay private.
          </Text>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {note ? <Text style={styles.noteText}>{note}</Text> : null}

        <Pressable
          style={[styles.primaryButton, saving && styles.disabled]}
          onPress={handleSave}
          disabled={saving}
        >
          <Text style={styles.primaryButtonText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>

        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.xl },
  centerScreen: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  closeButton: { fontSize: 20, color: colors.textPrimary, width: 24 },
  headerTitle: { ...typography.title, color: colors.textPrimary },
  content: { padding: spacing.lg, gap: spacing.md },
  avatarBlock: { alignItems: "center", paddingVertical: spacing.lg },
  avatarHint: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    lineHeight: 17,
  },
  avatarActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: { ...typography.label, color: colors.textPrimary },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg },
  label: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  inputRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  atSign: { ...typography.body, color: colors.textSecondary, fontSize: 18 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...typography.body,
  },
  hint: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.sm,
    lineHeight: 17,
  },
  errorText: { ...typography.caption, color: colors.danger },
  noteText: { ...typography.caption, color: colors.textSecondary },
  primaryButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  primaryButtonText: { ...typography.label, color: colors.onAccent },
  disabled: { opacity: 0.5 },
});
